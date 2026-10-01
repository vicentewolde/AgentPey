//! AgentResolve — disputes over a Vitrinee receipt, paid from a merchant's
//! guarantee (Fase 7, T124; decisions E-14 to E-19).
//!
//! A merchant's guarantee is USDC held here. A dispute names a receipt
//! anchored in Vitrinee's `receipt-registry`; this contract reads that record
//! itself, so the merchant whose guarantee is locked and the ceiling of any
//! refund come from the anchored receipt, never from the caller:
//!
//! - `open` locks the disputed amount in **that receipt's merchant's**
//!   guarantee, only while the claim window after the receipt is open, and
//!   never more than the receipt's amount.
//! - `resolve` records the hash of the arbiter's verdict next to the receipt
//!   and pays the refund — at most the locked amount — to the payer named at
//!   `open`, then releases the lock.
//!
//! Only the arbiter (`E-16`) opens and resolves. It opens a dispute after
//! checking, off chain, that the claim was signed by whoever paid the receipt;
//! that check, the AI verdict and the human confirmation (`E-18`) live in
//! `@agentpey/resolve`. What this contract guarantees no matter what the
//! arbiter or its model decide: a refund never exceeds the receipt, never
//! comes from another merchant's guarantee, and never happens twice.
//!
//! Gap, written down for the SEP (`E-19`): a merchant can withdraw anything not
//! locked by an open dispute, including just before a claim arrives.
#![no_std]

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, token, Address, Bytes,
    BytesN, Env,
};

pub const STORAGE_SCHEMA_VERSION: u32 = 1;

const LEDGERS_PER_DAY: u32 = 17_280; // ~5 s per ledger, same estimate the other contracts use
const INSTANCE_TTL_THRESHOLD: u32 = 30 * LEDGERS_PER_DAY;
const INSTANCE_TTL_EXTEND_TO: u32 = 90 * LEDGERS_PER_DAY;
const ENTRY_TTL_THRESHOLD: u32 = 30 * LEDGERS_PER_DAY;
const ENTRY_TTL_EXTEND_TO: u32 = 120 * LEDGERS_PER_DAY;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
#[repr(u32)]
pub enum Error {
    /// The receipt hash is not anchored in `receipt-registry`.
    ReceiptNotAnchored = 1,
    /// The claim window after the receipt has closed.
    ClaimWindowClosed = 2,
    /// An amount is zero or negative where it must be positive, or negative where it may be zero.
    InvalidAmount = 3,
    /// The disputed amount is larger than the anchored receipt.
    AmountExceedsReceipt = 4,
    /// This receipt already has a dispute, open or resolved.
    AlreadyDisputed = 5,
    /// The receipt's merchant has less free guarantee than the disputed amount.
    InsufficientGuarantee = 6,
    /// No dispute exists for this receipt.
    DisputeNotFound = 7,
    /// The dispute was already resolved.
    AlreadyResolved = 8,
    /// The refund is larger than the amount locked by the dispute.
    RefundExceedsClaim = 9,
    /// A withdrawal is larger than the guarantee not locked by open disputes.
    InsufficientFree = 10,
    /// The claim window given at construction is zero.
    InvalidWindow = 11,
}

/// The record `receipt-registry` keeps per receipt. Same fields, same names:
/// a `contracttype` struct is encoded as a map keyed by field name, so this
/// decodes what that contract (its own Cargo workspace, soroban-sdk 28)
/// returns. `STORAGE_SCHEMA_VERSION` 1 there.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReceiptRecord {
    pub merchant: Address,
    pub amount: i128,
    pub order_ref: Bytes,
    pub ledger: u32,
    pub timestamp: u64,
}

/// The one function of `receipt-registry` this contract calls.
#[contractclient(name = "ReceiptRegistryClient")]
pub trait ReceiptRegistryInterface {
    fn get(env: Env, hash: BytesN<32>) -> Option<ReceiptRecord>;
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub arbiter: Address,
    pub token: Address,
    pub registry: Address,
    /// Seconds after the receipt's ledger timestamp during which a dispute may be opened.
    pub claim_window: u64,
}

#[contracttype]
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Guarantee {
    pub balance: i128,
    /// Sum of the amounts of this merchant's open disputes. Never above `balance`.
    pub locked: i128,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Status {
    Open,
    Resolved,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Dispute {
    /// From the anchored receipt, never from the caller.
    pub merchant: Address,
    /// Who receives any refund: the receipt's payer, as the arbiter verified it.
    pub payer: Address,
    /// SHA-256 of the signed claim the arbiter verified.
    pub claim_hash: BytesN<32>,
    /// Locked in the merchant's guarantee while the dispute is open.
    pub amount: i128,
    pub opened_at: u64,
    pub status: Status,
    /// SHA-256 of the verdict, set by `resolve`.
    pub verdict_hash: Option<BytesN<32>>,
    pub refund: i128,
    pub resolved_at: u64,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Config,
    Guarantee(Address),
    Dispute(BytesN<32>),
}

#[contractevent(topics = ["agentresolve", "deposit"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Deposited {
    #[topic]
    pub merchant: Address,
    pub from: Address,
    pub amount: i128,
}

#[contractevent(topics = ["agentresolve", "withdraw"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Withdrawn {
    #[topic]
    pub merchant: Address,
    pub to: Address,
    pub amount: i128,
}

#[contractevent(topics = ["agentresolve", "opened"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeOpened {
    #[topic]
    pub receipt: BytesN<32>,
    pub merchant: Address,
    pub payer: Address,
    pub claim_hash: BytesN<32>,
    pub amount: i128,
}

#[contractevent(topics = ["agentresolve", "resolved"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeResolved {
    #[topic]
    pub receipt: BytesN<32>,
    pub verdict_hash: BytesN<32>,
    pub refund: i128,
}

#[contract]
pub struct AgentResolve;

#[contractimpl]
impl AgentResolve {
    pub fn __constructor(env: Env, arbiter: Address, token: Address, registry: Address, claim_window: u64) -> Result<(), Error> {
        if claim_window == 0 {
            return Err(Error::InvalidWindow);
        }
        env.storage().instance().set(&DataKey::Config, &Config { arbiter, token, registry, claim_window });
        Self::extend_instance(&env);
        Ok(())
    }

    pub fn schema_version(_env: Env) -> u32 {
        STORAGE_SCHEMA_VERSION
    }

    pub fn config(env: Env) -> Config {
        Self::load_config(&env)
    }

    /// The merchant's guarantee: total held and the part locked by open disputes.
    pub fn guarantee(env: Env, merchant: Address) -> Guarantee {
        env.storage().persistent().get(&DataKey::Guarantee(merchant)).unwrap_or_default()
    }

    pub fn get(env: Env, receipt: BytesN<32>) -> Option<Dispute> {
        env.storage().persistent().get(&DataKey::Dispute(receipt))
    }

    /// Adds to `merchant`'s guarantee. Anyone may fund it — a sponsor as well
    /// as the merchant — and only `from` authorises the transfer.
    pub fn deposit(env: Env, from: Address, merchant: Address, amount: i128) -> Result<(), Error> {
        from.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let config = Self::load_config(&env);
        token::Client::new(&env, &config.token).transfer(&from, &env.current_contract_address(), &amount);

        let mut guarantee = Self::guarantee(env.clone(), merchant.clone());
        guarantee.balance += amount;
        Self::save_guarantee(&env, &merchant, &guarantee);
        Deposited { merchant, from, amount }.publish(&env);
        Ok(())
    }

    /// The merchant takes back guarantee not locked by an open dispute (`E-19`).
    pub fn withdraw(env: Env, merchant: Address, to: Address, amount: i128) -> Result<(), Error> {
        merchant.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let mut guarantee = Self::guarantee(env.clone(), merchant.clone());
        if amount > guarantee.balance - guarantee.locked {
            return Err(Error::InsufficientFree);
        }
        let config = Self::load_config(&env);
        guarantee.balance -= amount;
        Self::save_guarantee(&env, &merchant, &guarantee);
        token::Client::new(&env, &config.token).transfer(&env.current_contract_address(), &to, &amount);
        Withdrawn { merchant, to, amount }.publish(&env);
        Ok(())
    }

    /// Opens a dispute over an anchored receipt and locks `amount` in its
    /// merchant's guarantee. Arbiter only.
    pub fn open(env: Env, receipt: BytesN<32>, payer: Address, claim_hash: BytesN<32>, amount: i128) -> Result<(), Error> {
        let config = Self::load_config(&env);
        config.arbiter.require_auth();

        let key = DataKey::Dispute(receipt.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyDisputed);
        }
        let record = ReceiptRegistryClient::new(&env, &config.registry).get(&receipt).ok_or(Error::ReceiptNotAnchored)?;

        let now = env.ledger().timestamp();
        if now > record.timestamp.saturating_add(config.claim_window) {
            return Err(Error::ClaimWindowClosed);
        }
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if amount > record.amount {
            return Err(Error::AmountExceedsReceipt);
        }

        let merchant = record.merchant;
        let mut guarantee = Self::guarantee(env.clone(), merchant.clone());
        if amount > guarantee.balance - guarantee.locked {
            return Err(Error::InsufficientGuarantee);
        }
        guarantee.locked += amount;
        Self::save_guarantee(&env, &merchant, &guarantee);

        let dispute = Dispute {
            merchant: merchant.clone(),
            payer: payer.clone(),
            claim_hash: claim_hash.clone(),
            amount,
            opened_at: now,
            status: Status::Open,
            verdict_hash: None,
            refund: 0,
            resolved_at: 0,
        };
        env.storage().persistent().set(&key, &dispute);
        Self::extend_entry(&env, &key);
        DisputeOpened { receipt, merchant, payer, claim_hash, amount }.publish(&env);
        Ok(())
    }

    /// Records the verdict and pays `refund` (0 to the locked amount) from the
    /// merchant's guarantee to the payer, then releases the lock. Arbiter only.
    pub fn resolve(env: Env, receipt: BytesN<32>, verdict_hash: BytesN<32>, refund: i128) -> Result<(), Error> {
        let config = Self::load_config(&env);
        config.arbiter.require_auth();

        let key = DataKey::Dispute(receipt.clone());
        let mut dispute: Dispute = env.storage().persistent().get(&key).ok_or(Error::DisputeNotFound)?;
        if dispute.status == Status::Resolved {
            return Err(Error::AlreadyResolved);
        }
        if refund < 0 {
            return Err(Error::InvalidAmount);
        }
        if refund > dispute.amount {
            return Err(Error::RefundExceedsClaim);
        }

        let mut guarantee = Self::guarantee(env.clone(), dispute.merchant.clone());
        guarantee.locked -= dispute.amount;
        guarantee.balance -= refund;
        Self::save_guarantee(&env, &dispute.merchant, &guarantee);

        dispute.status = Status::Resolved;
        dispute.verdict_hash = Some(verdict_hash.clone());
        dispute.refund = refund;
        dispute.resolved_at = env.ledger().timestamp();
        env.storage().persistent().set(&key, &dispute);
        Self::extend_entry(&env, &key);

        if refund > 0 {
            token::Client::new(&env, &config.token).transfer(&env.current_contract_address(), &dispute.payer, &refund);
        }
        DisputeResolved { receipt, verdict_hash, refund }.publish(&env);
        Ok(())
    }

    fn load_config(env: &Env) -> Config {
        Self::extend_instance(env);
        // Set by the constructor, which runs at deploy: it is always there.
        env.storage().instance().get(&DataKey::Config).unwrap()
    }

    fn save_guarantee(env: &Env, merchant: &Address, guarantee: &Guarantee) {
        let key = DataKey::Guarantee(merchant.clone());
        env.storage().persistent().set(&key, guarantee);
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
