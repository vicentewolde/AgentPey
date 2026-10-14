//! PurchaseEscrow — one store's agent purchases, held until they ship and
//! released or refunded by the contract's own deadlines (Fase 9, T157;
//! decisions X-1 to X-18).
//!
//! A buyer's x402 payment lands here as a plain token `transfer` (the
//! `policy_rail` can authorise nothing else, `X-3`). The store then records
//! the purchase with `hold`, and from there the contract decides where the
//! money goes:
//!
//! - `mark_shipped` starts the release window; `release` pays the store once
//!   it closes, and anyone may call it.
//! - `open` freezes the release. It carries the payer's own consent: the
//!   Ed25519 signature of the rail's owner over the claim (a rail payer), or
//!   the account's Stellar auth (a classic payer, `X-16`). No arbiter needed.
//! - `respond` is the store's answer, accepted only inside the response window.
//! - `resolve` is the arbiter's verdict: a refund to the payer, the rest to the
//!   store. `expire` refunds everything if the arbiter misses its deadline (`X-7`).
//!
//! One contract per store (`X-11`): a contract cannot read another
//! transaction's hash, so with a shared escrow one store could `hold` a
//! payment meant for another. Here every unallocated unit belongs to this
//! store, and `hold` never allocates more than has arrived. `tx_hash` is
//! unique, so one payment backs one purchase and one receipt (brecha 10).
//!
//! Who signs what (`X-4`): `operator` is the store's signing account, the key
//! its server holds (`hold`, `mark_shipped`); `payee` is its payout account,
//! the merchant's own wallet (`respond`, and where releases go).
//!
//! Known limit: `payer` is what the operator says it is. A stolen operator key
//! plus an absent arbiter could `hold` with a fake payer and collect through
//! `expire`. The receipt verifier compares the payer with the settled
//! transaction (T159), and the arbiter's deadline is the backstop.
#![no_std]

use soroban_sdk::{
    address_payload::AddressPayload, contract, contractclient, contracterror, contractevent, contractimpl,
    contracttype, token, Address, Bytes, BytesN, Env,
};

pub const STORAGE_SCHEMA_VERSION: u32 = 1;

/// Domain of the message a rail's owner signs to open a dispute. Exactly 32 bytes.
pub const OPEN_DOMAIN: &[u8; 32] = b"agentpey/purchase-escrow/open/v1";
/// `receipt-registry`'s own bound on an order reference, kept the same here.
pub const MAX_ORDER_REF_LEN: u32 = 64;

const LEDGERS_PER_DAY: u32 = 17_280; // ~5 s per ledger, same estimate the other contracts use
const INSTANCE_TTL_THRESHOLD: u32 = 30 * LEDGERS_PER_DAY;
const INSTANCE_TTL_EXTEND_TO: u32 = 90 * LEDGERS_PER_DAY;
const ENTRY_TTL_THRESHOLD: u32 = 30 * LEDGERS_PER_DAY;
const ENTRY_TTL_EXTEND_TO: u32 = 120 * LEDGERS_PER_DAY;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
#[repr(u32)]
pub enum Error {
    /// A window given at construction is zero.
    InvalidWindow = 1,
    /// An amount is zero or negative where it must be positive, or negative where it may be zero.
    InvalidAmount = 2,
    /// The order reference is empty or longer than 64 bytes.
    InvalidOrderRef = 3,
    /// This order already has a purchase here.
    OrderAlreadyHeld = 4,
    /// This payment transaction already backs a purchase: one payment, one receipt.
    PaymentAlreadyHeld = 5,
    /// The amount is larger than what has arrived and is not yet allocated to a purchase.
    InsufficientUnallocated = 6,
    /// No purchase exists for this order.
    PurchaseNotFound = 7,
    /// The purchase is not in a state that allows this call.
    WrongStatus = 8,
    /// The release window after shipping has not closed yet.
    ReleaseTooEarly = 9,
    /// The release window has closed: the purchase can only be released now.
    ClaimWindowClosed = 10,
    /// The payer is a contract and no signature came with the claim.
    MissingSignature = 11,
    /// The payer's address is of a kind this contract does not know.
    UnsupportedPayer = 12,
    /// The store answered after its response window closed.
    ResponseWindowClosed = 13,
    /// The store has not answered and may still do so: the arbiter waits.
    ResponseWindowOpen = 14,
    /// The arbiter's deadline has passed: only `expire` applies now.
    ResolveWindowClosed = 15,
    /// The arbiter's deadline has not passed yet.
    ResolveWindowOpen = 16,
    /// The refund is larger than the purchase.
    RefundExceedsAmount = 17,
}

/// The one function of `policy_rail` this contract calls: its owner's raw Ed25519 key.
#[contractclient(name = "RailClient")]
pub trait RailInterface {
    fn owner(env: Env) -> BytesN<32>;
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    /// The store's signing account: records and ships purchases.
    pub operator: Address,
    /// The store's payout account: answers disputes and receives releases.
    pub payee: Address,
    /// Resolves disputes; the same arbiter as AgentResolve.
    pub arbiter: Address,
    pub token: Address,
    /// Seconds after `mark_shipped` before the payment can be released.
    pub release_window: u64,
    /// Seconds after `open` during which the store may answer.
    pub response_window: u64,
    /// Seconds after the response window during which the arbiter may resolve.
    pub resolve_window: u64,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Status {
    Held,
    Shipped,
    Released,
    Disputed,
    Responded,
    Resolved,
    Expired,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Purchase {
    pub order_ref: Bytes,
    /// Who paid, and who receives any refund: a `policy_rail` or a classic account.
    pub payer: Address,
    pub amount: i128,
    /// Hash of the settled payment transaction; unique in this contract.
    pub tx_hash: BytesN<32>,
    /// SHA-256 of the signed receipt for this purchase.
    pub receipt_hash: BytesN<32>,
    pub status: Status,
    pub held_at: u64,
    /// 0 until `mark_shipped`.
    pub shipped_at: u64,
    pub claim_hash: Option<BytesN<32>>,
    /// 0 until `open`.
    pub opened_at: u64,
    pub response_hash: Option<BytesN<32>>,
    pub verdict_hash: Option<BytesN<32>>,
    /// What went back to the payer, once the purchase is closed.
    pub refund: i128,
    /// When it was released, resolved or expired; 0 while open.
    pub closed_at: u64,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Config,
    /// Sum of the amounts of purchases not yet paid out.
    Allocated,
    Purchase(Bytes),
    /// Payment transaction hash → order reference.
    Payment(BytesN<32>),
}

#[contractevent(topics = ["escrow", "held"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Held {
    #[topic]
    pub order_ref: Bytes,
    pub payer: Address,
    pub amount: i128,
    pub tx_hash: BytesN<32>,
    pub receipt_hash: BytesN<32>,
}

#[contractevent(topics = ["escrow", "shipped"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Shipped {
    #[topic]
    pub order_ref: Bytes,
}

#[contractevent(topics = ["escrow", "released"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Released {
    #[topic]
    pub order_ref: Bytes,
    pub payee: Address,
    pub amount: i128,
}

#[contractevent(topics = ["escrow", "opened"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeOpened {
    #[topic]
    pub order_ref: Bytes,
    pub payer: Address,
    pub claim_hash: BytesN<32>,
}

#[contractevent(topics = ["escrow", "responded"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeResponded {
    #[topic]
    pub order_ref: Bytes,
    pub response_hash: BytesN<32>,
}

#[contractevent(topics = ["escrow", "resolved"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeResolved {
    #[topic]
    pub order_ref: Bytes,
    pub verdict_hash: BytesN<32>,
    pub refund: i128,
}

#[contractevent(topics = ["escrow", "expired"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeExpired {
    #[topic]
    pub order_ref: Bytes,
    pub refund: i128,
}

#[contract]
pub struct PurchaseEscrow;

#[contractimpl]
impl PurchaseEscrow {
    /// Seven settings, fixed for the contract's life (spec §4.2): changing a window is another contract.
    #[allow(clippy::too_many_arguments)]
    pub fn __constructor(
        env: Env,
        operator: Address,
        payee: Address,
        arbiter: Address,
        token: Address,
        release_window: u64,
        response_window: u64,
        resolve_window: u64,
    ) -> Result<(), Error> {
        if release_window == 0 || response_window == 0 || resolve_window == 0 {
            return Err(Error::InvalidWindow);
        }
        let config = Config { operator, payee, arbiter, token, release_window, response_window, resolve_window };
        env.storage().instance().set(&DataKey::Config, &config);
        env.storage().instance().set(&DataKey::Allocated, &0i128);
        Self::extend_instance(&env);
        Ok(())
    }

    pub fn schema_version(_env: Env) -> u32 {
        STORAGE_SCHEMA_VERSION
    }

    pub fn config(env: Env) -> Config {
        Self::load_config(&env)
    }

    pub fn get(env: Env, order_ref: Bytes) -> Option<Purchase> {
        env.storage().persistent().get(&DataKey::Purchase(order_ref))
    }

    /// The purchase a settled payment backs, if any.
    pub fn by_tx(env: Env, tx_hash: BytesN<32>) -> Option<Purchase> {
        let order_ref: Option<Bytes> = env.storage().persistent().get(&DataKey::Payment(tx_hash));
        order_ref.and_then(|order_ref| Self::get(env, order_ref))
    }

    /// What has arrived here and no purchase has claimed yet.
    pub fn unallocated(env: Env) -> i128 {
        let config = Self::load_config(&env);
        token::Client::new(&env, &config.token).balance(&env.current_contract_address()) - Self::allocated(&env)
    }

    /// Records a purchase whose payment has already landed here. Operator only.
    pub fn hold(
        env: Env,
        order_ref: Bytes,
        payer: Address,
        amount: i128,
        tx_hash: BytesN<32>,
        receipt_hash: BytesN<32>,
    ) -> Result<(), Error> {
        let config = Self::load_config(&env);
        config.operator.require_auth();

        if order_ref.is_empty() || order_ref.len() > MAX_ORDER_REF_LEN {
            return Err(Error::InvalidOrderRef);
        }
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let key = DataKey::Purchase(order_ref.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::OrderAlreadyHeld);
        }
        let payment_key = DataKey::Payment(tx_hash.clone());
        if env.storage().persistent().has(&payment_key) {
            return Err(Error::PaymentAlreadyHeld);
        }
        if amount > Self::unallocated(env.clone()) {
            return Err(Error::InsufficientUnallocated);
        }

        Self::set_allocated(&env, Self::allocated(&env) + amount);
        let purchase = Purchase {
            order_ref: order_ref.clone(),
            payer: payer.clone(),
            amount,
            tx_hash: tx_hash.clone(),
            receipt_hash: receipt_hash.clone(),
            status: Status::Held,
            held_at: env.ledger().timestamp(),
            shipped_at: 0,
            claim_hash: None,
            opened_at: 0,
            response_hash: None,
            verdict_hash: None,
            refund: 0,
            closed_at: 0,
        };
        Self::save(&env, &purchase);
        env.storage().persistent().set(&payment_key, &order_ref);
        Self::extend_entry(&env, &payment_key);
        Held { order_ref, payer, amount, tx_hash, receipt_hash }.publish(&env);
        Ok(())
    }

    /// Starts the release window. Operator only.
    pub fn mark_shipped(env: Env, order_ref: Bytes) -> Result<(), Error> {
        let config = Self::load_config(&env);
        config.operator.require_auth();
        let mut purchase = Self::load(&env, &order_ref)?;
        if purchase.status != Status::Held {
            return Err(Error::WrongStatus);
        }
        purchase.status = Status::Shipped;
        purchase.shipped_at = env.ledger().timestamp();
        Self::save(&env, &purchase);
        Shipped { order_ref }.publish(&env);
        Ok(())
    }

    /// Pays the store once the release window after shipping has closed with
    /// no claim. Anyone may call it.
    pub fn release(env: Env, order_ref: Bytes) -> Result<(), Error> {
        let config = Self::load_config(&env);
        let mut purchase = Self::load(&env, &order_ref)?;
        if purchase.status != Status::Shipped {
            return Err(Error::WrongStatus);
        }
        let now = env.ledger().timestamp();
        if now < purchase.shipped_at.saturating_add(config.release_window) {
            return Err(Error::ReleaseTooEarly);
        }
        Self::close(&env, &config, &mut purchase, Status::Released, 0, now);
        Released { order_ref, payee: config.payee, amount: purchase.amount }.publish(&env);
        Ok(())
    }

    /// Opens a dispute and freezes the release (`X-12`, `X-15`): allowed until
    /// the release window closes. A rail payer's consent is `sig`, its owner's
    /// Ed25519 signature over `open_message`; a classic payer signs the call
    /// itself (`X-16`).
    pub fn open(env: Env, order_ref: Bytes, claim_hash: BytesN<32>, sig: Option<BytesN<64>>) -> Result<(), Error> {
        let config = Self::load_config(&env);
        let mut purchase = Self::load(&env, &order_ref)?;
        let now = env.ledger().timestamp();
        match purchase.status {
            Status::Held => {}
            Status::Shipped => {
                if now >= purchase.shipped_at.saturating_add(config.release_window) {
                    return Err(Error::ClaimWindowClosed);
                }
            }
            _ => return Err(Error::WrongStatus),
        }

        match purchase.payer.to_payload() {
            Some(AddressPayload::AccountIdPublicKeyEd25519(_)) => purchase.payer.require_auth(),
            Some(AddressPayload::ContractIdHash(_)) => {
                let sig = sig.ok_or(Error::MissingSignature)?;
                let owner = RailClient::new(&env, &purchase.payer).owner();
                let message = Self::open_message(env.clone(), order_ref.clone(), claim_hash.clone());
                // Aborts the whole call on a bad signature: fail closed, enforced by the host.
                env.crypto().ed25519_verify(&owner, &message, &sig);
            }
            None => return Err(Error::UnsupportedPayer),
        }

        purchase.status = Status::Disputed;
        purchase.claim_hash = Some(claim_hash.clone());
        purchase.opened_at = now;
        Self::save(&env, &purchase);
        DisputeOpened { order_ref, payer: purchase.payer, claim_hash }.publish(&env);
        Ok(())
    }

    /// The bytes a rail's owner signs to open a dispute here: the 32-byte
    /// domain, this contract's 32-byte id, the claim hash, then the order
    /// reference. Everything but the last part has a fixed length.
    pub fn open_message(env: Env, order_ref: Bytes, claim_hash: BytesN<32>) -> Bytes {
        let mut message = Bytes::from_array(&env, OPEN_DOMAIN);
        if let Some(AddressPayload::ContractIdHash(id)) = env.current_contract_address().to_payload() {
            message.append(&id.into());
        }
        message.append(&claim_hash.into());
        message.append(&order_ref);
        message
    }

    /// The store's answer to a dispute, inside the response window. Payee only.
    pub fn respond(env: Env, order_ref: Bytes, response_hash: BytesN<32>) -> Result<(), Error> {
        let config = Self::load_config(&env);
        config.payee.require_auth();
        let mut purchase = Self::load(&env, &order_ref)?;
        if purchase.status != Status::Disputed {
            return Err(Error::WrongStatus);
        }
        if env.ledger().timestamp() > purchase.opened_at.saturating_add(config.response_window) {
            return Err(Error::ResponseWindowClosed);
        }
        purchase.status = Status::Responded;
        purchase.response_hash = Some(response_hash.clone());
        Self::save(&env, &purchase);
        DisputeResponded { order_ref, response_hash }.publish(&env);
        Ok(())
    }

    /// The arbiter's verdict: `refund` (0 to the purchase) to the payer, the
    /// rest to the store. Not before the store has answered or its window has
    /// closed, and not after the arbiter's deadline. Arbiter only.
    pub fn resolve(env: Env, order_ref: Bytes, verdict_hash: BytesN<32>, refund: i128) -> Result<(), Error> {
        let config = Self::load_config(&env);
        config.arbiter.require_auth();
        let mut purchase = Self::load(&env, &order_ref)?;
        let now = env.ledger().timestamp();
        match purchase.status {
            Status::Responded => {}
            Status::Disputed => {
                if now <= purchase.opened_at.saturating_add(config.response_window) {
                    return Err(Error::ResponseWindowOpen);
                }
            }
            _ => return Err(Error::WrongStatus),
        }
        if now > Self::resolve_deadline(&config, &purchase) {
            return Err(Error::ResolveWindowClosed);
        }
        if refund < 0 {
            return Err(Error::InvalidAmount);
        }
        if refund > purchase.amount {
            return Err(Error::RefundExceedsAmount);
        }
        purchase.verdict_hash = Some(verdict_hash.clone());
        Self::close(&env, &config, &mut purchase, Status::Resolved, refund, now);
        DisputeResolved { order_ref, verdict_hash, refund }.publish(&env);
        Ok(())
    }

    /// Refunds the whole purchase when the arbiter missed its deadline (`X-7`).
    /// Anyone may call it.
    pub fn expire(env: Env, order_ref: Bytes) -> Result<(), Error> {
        let config = Self::load_config(&env);
        let mut purchase = Self::load(&env, &order_ref)?;
        if purchase.status != Status::Disputed && purchase.status != Status::Responded {
            return Err(Error::WrongStatus);
        }
        let now = env.ledger().timestamp();
        if now <= Self::resolve_deadline(&config, &purchase) {
            return Err(Error::ResolveWindowOpen);
        }
        let refund = purchase.amount;
        Self::close(&env, &config, &mut purchase, Status::Expired, refund, now);
        DisputeExpired { order_ref, refund }.publish(&env);
        Ok(())
    }

    fn resolve_deadline(config: &Config, purchase: &Purchase) -> u64 {
        purchase.opened_at.saturating_add(config.response_window).saturating_add(config.resolve_window)
    }

    /// Pays `refund` to the payer and the rest to the payee, frees the allocation and records the outcome.
    fn close(env: &Env, config: &Config, purchase: &mut Purchase, status: Status, refund: i128, now: u64) {
        purchase.status = status;
        purchase.refund = refund;
        purchase.closed_at = now;
        Self::set_allocated(env, Self::allocated(env) - purchase.amount);
        Self::save(env, purchase);

        let token = token::Client::new(env, &config.token);
        let this = env.current_contract_address();
        if refund > 0 {
            token.transfer(&this, &purchase.payer, &refund);
        }
        let to_store = purchase.amount - refund;
        if to_store > 0 {
            token.transfer(&this, &config.payee, &to_store);
        }
    }

    fn load_config(env: &Env) -> Config {
        Self::extend_instance(env);
        // Set by the constructor, which runs at deploy: it is always there.
        env.storage().instance().get(&DataKey::Config).unwrap()
    }

    fn allocated(env: &Env) -> i128 {
        env.storage().instance().get(&DataKey::Allocated).unwrap_or(0)
    }

    fn set_allocated(env: &Env, value: i128) {
        env.storage().instance().set(&DataKey::Allocated, &value);
    }

    fn load(env: &Env, order_ref: &Bytes) -> Result<Purchase, Error> {
        env.storage().persistent().get(&DataKey::Purchase(order_ref.clone())).ok_or(Error::PurchaseNotFound)
    }

    fn save(env: &Env, purchase: &Purchase) {
        let key = DataKey::Purchase(purchase.order_ref.clone());
        env.storage().persistent().set(&key, purchase);
        Self::extend_entry(env, &key);
    }

    fn extend_instance(env: &Env) {
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
    }

    fn extend_entry(env: &Env, key: &DataKey) {
        env.storage().persistent().extend_ttl(key, ENTRY_TTL_THRESHOLD, ENTRY_TTL_EXTEND_TO);
    }
}

mod test;
