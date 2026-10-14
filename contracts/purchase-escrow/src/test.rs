#![cfg(test)]
extern crate std;

use super::{Error, PurchaseEscrow, PurchaseEscrowClient, Status, OPEN_DOMAIN, STORAGE_SCHEMA_VERSION};
use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, IssuerFlags, Ledger as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Address, Bytes, BytesN, Env, IntoVal,
};

const NOW: u64 = 1_790_000_000; // a fixed "now" so tests never depend on the clock
const RELEASE: u64 = 600; // the agentcommerce demo windows (X-6): 10, 15 and 60 minutes
const RESPONSE: u64 = 900;
const RESOLVE: u64 = 3_600;
const PRICE: i128 = 5_157_895; // 0.5157895 USDC, the magnet the MCP buys
/// The contract id the shared `open` message vector is built for (AgentResolve's, any valid `C…` would do).
const VECTOR_CONTRACT: &str = "CCYMGX56FJ65EVXUY2M4BTVBCCOBXBTAMGSCWN5X4TQLQTCCEAHDCD3F";
/// Same vector as `packages/resolve/src/escrow-open.test.ts`: claim hash 0x11 × 32, order `ord_test123`.
const VECTOR_MESSAGE: &str = "6167656e747065792f70757263686173652d657363726f772f6f70656e2f7631b0c35fbe2a7dd256f4c699c0cea1109c1b866061a42b37b7e4e0b84c42200e3111111111111111111111111111111111111111111111111111111111111111116f72645f74657374313233";

/// Any valid account address: the classic payer of `X-16`.
const CLASSIC_PAYER: &str = "GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K";

/// Stands in for a `policy_rail`: the one function the escrow calls.
#[contract]
pub struct MockRail;

#[contractimpl]
impl MockRail {
    pub fn __constructor(env: Env, owner: BytesN<32>) {
        env.storage().instance().set(&0u32, &owner);
    }

    pub fn owner(env: Env) -> BytesN<32> {
        env.storage().instance().get(&0u32).unwrap()
    }
}

struct Fixture {
    env: Env,
    client: PurchaseEscrowClient<'static>,
    contract: Address,
    operator: Address,
    payee: Address,
    arbiter: Address,
    token: TokenClient<'static>,
    minter: StellarAssetClient<'static>,
    rail: Address,
    rail_owner: SigningKey,
}

fn hash(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

fn order(env: &Env, seed: u8) -> Bytes {
    Bytes::from_slice(env, std::format!("ord_{seed:03}").as_bytes())
}

fn to_vec(bytes: &Bytes) -> std::vec::Vec<u8> {
    bytes.iter().collect()
}

fn from_hex(env: &Env, hex: &str) -> Bytes {
    let raw: std::vec::Vec<u8> = (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect();
    Bytes::from_slice(env, &raw)
}

impl Fixture {
    fn setup() -> Self {
        Self::setup_at(None)
    }

    fn setup_at(at: Option<&str>) -> Self {
        let env = Env::default();
        env.ledger().set_timestamp(NOW);
        env.mock_all_auths();

        let operator = Address::generate(&env);
        let payee = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let asset = env.register_stellar_asset_contract_v2(Address::generate(&env));
        // Revocable, so a test can deauthorise a balance and see a refund that cannot be delivered (X-19).
        asset.issuer().set_flag(IssuerFlags::RevocableFlag);
        let token_address = asset.address();
        let args = (operator.clone(), payee.clone(), arbiter.clone(), token_address.clone(), RELEASE, RESPONSE, RESOLVE);
        let contract = match at {
            Some(id) => env.register_at(&Address::from_str(&env, id), PurchaseEscrow, args),
            None => env.register(PurchaseEscrow, args),
        };

        // Fixed keys: the snapshots stay the same from one `cargo test` to the next.
        let rail_owner = SigningKey::from_bytes(&[7; 32]);
        let rail = env.register(MockRail, (BytesN::from_array(&env, &rail_owner.verifying_key().to_bytes()),));

        Fixture {
            client: PurchaseEscrowClient::new(&env, &contract),
            token: TokenClient::new(&env, &token_address),
            minter: StellarAssetClient::new(&env, &token_address),
            contract,
            operator,
            payee,
            arbiter,
            rail,
            rail_owner,
            env,
        }
    }

    /// What an x402 settlement does: the payer's transfer lands on the escrow.
    fn pay(&self, amount: i128) {
        self.minter.mint(&self.contract, &amount);
    }

    /// A paid purchase from the rail, recorded with `hold`.
    fn held(&self, seed: u8) -> Bytes {
        self.held_by(seed, &self.rail.clone(), PRICE)
    }

    fn held_by(&self, seed: u8, payer: &Address, amount: i128) -> Bytes {
        self.pay(amount);
        let order_ref = order(&self.env, seed);
        self.client.hold(&order_ref, payer, &amount, &hash(&self.env, seed), &hash(&self.env, seed.wrapping_add(100)));
        order_ref
    }

    fn shipped(&self, seed: u8) -> Bytes {
        let order_ref = self.held(seed);
        self.client.mark_shipped(&order_ref);
        order_ref
    }

    fn sign_open(&self, key: &SigningKey, order_ref: &Bytes, claim: &BytesN<32>) -> BytesN<64> {
        let message = self.client.open_message(order_ref, claim);
        BytesN::from_array(&self.env, &key.sign(&to_vec(&message)).to_bytes())
    }

    /// The rail's owner opens a dispute over `order_ref`.
    fn opened(&self, order_ref: &Bytes) -> BytesN<32> {
        let claim = hash(&self.env, 42);
        let sig = self.sign_open(&self.rail_owner, order_ref, &claim);
        self.client.open(order_ref, &claim, &Some(sig));
        claim
    }

    fn advance(&self, seconds: u64) {
        let now = self.env.ledger().timestamp();
        self.env.ledger().set_timestamp(now + seconds);
    }

    fn status(&self, order_ref: &Bytes) -> Status {
        self.client.get(order_ref).unwrap().status
    }

    fn last_signer(&self) -> Address {
        self.env.auths().into_iter().next().unwrap().0
    }
}

// ------------------------------------------------------------- construction

#[test]
fn reports_its_schema_and_config() {
    let f = Fixture::setup();
    assert_eq!(f.client.schema_version(), STORAGE_SCHEMA_VERSION);
    let config = f.client.config();
    assert_eq!((config.operator, config.payee, config.arbiter), (f.operator.clone(), f.payee.clone(), f.arbiter.clone()));
    assert_eq!((config.release_window, config.response_window, config.resolve_window), (RELEASE, RESPONSE, RESOLVE));
    assert_eq!(f.client.unallocated(), 0);
}

/// A constructor error makes `register` panic: the contract is never deployed.
fn register_with_windows(release: u64, response: u64, resolve: u64) {
    let env = Env::default();
    let a = || Address::generate(&env);
    env.register(PurchaseEscrow, (a(), a(), a(), a(), release, response, resolve));
}

#[test]
#[should_panic]
fn refuses_a_zero_release_window() {
    register_with_windows(0, 1, 1);
}

#[test]
#[should_panic]
fn refuses_a_zero_response_window() {
    register_with_windows(1, 0, 1);
}

#[test]
#[should_panic]
fn refuses_a_zero_resolve_window() {
    register_with_windows(1, 1, 0);
}

// ---------------------------------------------------------------------- hold

#[test]
fn holds_a_paid_purchase_and_finds_it_by_its_payment() {
    let f = Fixture::setup();
    f.pay(PRICE + 7); // something extra arrived, unclaimed
    let order_ref = order(&f.env, 1);
    f.client.hold(&order_ref, &f.rail, &PRICE, &hash(&f.env, 1), &hash(&f.env, 101));

    let purchase = f.client.get(&order_ref).unwrap();
    assert_eq!(purchase.status, Status::Held);
    assert_eq!((purchase.payer, purchase.amount, purchase.held_at), (f.rail.clone(), PRICE, NOW));
    assert_eq!(purchase.receipt_hash, hash(&f.env, 101));
    assert_eq!(f.client.by_tx(&hash(&f.env, 1)).unwrap().order_ref, order_ref);
    assert!(f.client.by_tx(&hash(&f.env, 2)).is_none());
    assert_eq!(f.client.unallocated(), 7);
}

#[test]
fn one_payment_backs_one_purchase_and_one_order_one_hold() {
    let f = Fixture::setup();
    f.held(1);
    f.pay(PRICE);
    // Same payment, another order: the second receipt over one payment (brecha 10).
    assert_eq!(f.client.try_hold(&order(&f.env, 2), &f.rail, &PRICE, &hash(&f.env, 1), &hash(&f.env, 102)), Err(Ok(Error::PaymentAlreadyHeld)));
    // Same order, another payment.
    assert_eq!(f.client.try_hold(&order(&f.env, 1), &f.rail, &PRICE, &hash(&f.env, 2), &hash(&f.env, 102)), Err(Ok(Error::OrderAlreadyHeld)));
    assert_eq!(f.client.unallocated(), PRICE);
}

#[test]
fn never_holds_more_than_arrived_and_is_unclaimed() {
    let f = Fixture::setup();
    f.held(1); // fully allocated
    assert_eq!(f.client.try_hold(&order(&f.env, 2), &f.rail, &1, &hash(&f.env, 2), &hash(&f.env, 102)), Err(Ok(Error::InsufficientUnallocated)));
    f.pay(PRICE - 1);
    assert_eq!(f.client.try_hold(&order(&f.env, 2), &f.rail, &PRICE, &hash(&f.env, 2), &hash(&f.env, 102)), Err(Ok(Error::InsufficientUnallocated)));
    f.client.hold(&order(&f.env, 2), &f.rail, &(PRICE - 1), &hash(&f.env, 2), &hash(&f.env, 102));
    assert_eq!(f.client.unallocated(), 0);
}

#[test]
fn refuses_a_bad_order_reference_or_amount() {
    let f = Fixture::setup();
    f.pay(PRICE);
    let empty = Bytes::new(&f.env);
    let long = Bytes::from_slice(&f.env, &[b'x'; 65]);
    let max = Bytes::from_slice(&f.env, &[b'x'; 64]);
    assert_eq!(f.client.try_hold(&empty, &f.rail, &PRICE, &hash(&f.env, 1), &hash(&f.env, 101)), Err(Ok(Error::InvalidOrderRef)));
    assert_eq!(f.client.try_hold(&long, &f.rail, &PRICE, &hash(&f.env, 1), &hash(&f.env, 101)), Err(Ok(Error::InvalidOrderRef)));
    assert_eq!(f.client.try_hold(&max, &f.rail, &0, &hash(&f.env, 1), &hash(&f.env, 101)), Err(Ok(Error::InvalidAmount)));
    assert_eq!(f.client.try_hold(&max, &f.rail, &-1, &hash(&f.env, 1), &hash(&f.env, 101)), Err(Ok(Error::InvalidAmount)));
    f.client.hold(&max, &f.rail, &PRICE, &hash(&f.env, 1), &hash(&f.env, 101));
}

// ------------------------------------------------------------ ship, release

#[test]
fn releases_to_the_payee_when_the_window_closes_and_not_a_second_earlier() {
    let f = Fixture::setup();
    let order_ref = f.shipped(1);
    assert_eq!(f.client.get(&order_ref).unwrap().shipped_at, NOW);

    f.advance(RELEASE - 1);
    assert_eq!(f.client.try_release(&order_ref), Err(Ok(Error::ReleaseTooEarly)));
    f.advance(1);
    f.client.release(&order_ref);

    assert_eq!(f.token.balance(&f.payee), PRICE);
    assert_eq!(f.token.balance(&f.contract), 0);
    let purchase = f.client.get(&order_ref).unwrap();
    assert_eq!((purchase.status, purchase.refund, purchase.closed_at), (Status::Released, 0, NOW + RELEASE));
    assert_eq!(f.client.try_release(&order_ref), Err(Ok(Error::WrongStatus)));
}

#[test]
fn nothing_is_released_before_shipping_and_shipping_happens_once() {
    let f = Fixture::setup();
    let order_ref = f.held(1);
    f.advance(30 * RELEASE);
    assert_eq!(f.client.try_release(&order_ref), Err(Ok(Error::WrongStatus)));
    f.client.mark_shipped(&order_ref);
    assert_eq!(f.client.try_mark_shipped(&order_ref), Err(Ok(Error::WrongStatus)));
    assert_eq!(f.client.try_mark_shipped(&order(&f.env, 9)), Err(Ok(Error::PurchaseNotFound)));
}

#[test]
fn other_purchases_do_not_move_when_one_is_released() {
    let f = Fixture::setup();
    let first = f.shipped(1);
    let second = f.held(2);
    f.advance(RELEASE);
    f.client.release(&first);
    assert_eq!(f.token.balance(&f.contract), PRICE);
    assert_eq!(f.client.unallocated(), 0);
    assert_eq!(f.status(&second), Status::Held);
}

// --------------------------------------------------------------------- open

#[test]
fn the_rails_owner_opens_a_dispute_without_the_arbiter_and_freezes_the_release() {
    let f = Fixture::setup();
    let order_ref = f.shipped(1);
    let claim = f.opened(&order_ref);

    let purchase = f.client.get(&order_ref).unwrap();
    assert_eq!((purchase.status, purchase.claim_hash, purchase.opened_at), (Status::Disputed, Some(claim), NOW));
    // Nobody's Stellar auth was needed: the signature is the consent.
    assert!(f.env.auths().is_empty());
    f.advance(RELEASE);
    assert_eq!(f.client.try_release(&order_ref), Err(Ok(Error::WrongStatus)));
}

#[test]
fn a_signature_from_another_key_is_refused_by_the_host() {
    let f = Fixture::setup();
    let order_ref = f.held(1);
    let claim = hash(&f.env, 42);
    let stranger = SigningKey::from_bytes(&[8; 32]);
    let sig = f.sign_open(&stranger, &order_ref, &claim);
    assert!(matches!(f.client.try_open(&order_ref, &claim, &Some(sig)), Err(Err(_))));
    assert_eq!(f.status(&order_ref), Status::Held);
}

#[test]
fn a_signature_for_another_order_or_claim_or_escrow_does_not_open_this_one() {
    let f = Fixture::setup();
    let target = f.held(1);
    let other = f.held(2);
    let claim = hash(&f.env, 42);

    let for_other_order = f.sign_open(&f.rail_owner, &other, &claim);
    assert!(matches!(f.client.try_open(&target, &claim, &Some(for_other_order)), Err(Err(_))));
    let for_other_claim = f.sign_open(&f.rail_owner, &target, &hash(&f.env, 43));
    assert!(matches!(f.client.try_open(&target, &claim, &Some(for_other_claim)), Err(Err(_))));

    // The same order and claim in another store's escrow: the contract id is part of the message.
    let config = f.client.config();
    let args = (config.operator, config.payee, config.arbiter, config.token, RELEASE, RESPONSE, RESOLVE);
    let elsewhere = PurchaseEscrowClient::new(&f.env, &f.env.register(PurchaseEscrow, args));
    let message = elsewhere.open_message(&target, &claim);
    assert_eq!(message.slice(0..32), Bytes::from_array(&f.env, OPEN_DOMAIN));
    assert_ne!(message, f.client.open_message(&target, &claim));
    let for_other_escrow = BytesN::from_array(&f.env, &f.rail_owner.sign(&to_vec(&message)).to_bytes());
    assert!(matches!(f.client.try_open(&target, &claim, &Some(for_other_escrow)), Err(Err(_))));
    assert_eq!(f.status(&target), Status::Held);
}

#[test]
fn a_rail_payer_must_bring_a_signature() {
    let f = Fixture::setup();
    let order_ref = f.held(1);
    assert_eq!(f.client.try_open(&order_ref, &hash(&f.env, 42), &None), Err(Ok(Error::MissingSignature)));
}

#[test]
fn a_classic_payer_opens_with_its_own_stellar_auth() {
    let f = Fixture::setup();
    // `Address::generate` makes contract addresses; a classic payer is a `G…` account.
    let buyer = Address::from_str(&f.env, CLASSIC_PAYER);
    let order_ref = f.held_by(1, &buyer, PRICE);
    f.client.open(&order_ref, &hash(&f.env, 42), &None);
    assert_eq!(f.last_signer(), buyer);
    assert_eq!(f.status(&order_ref), Status::Disputed);

    let second = f.held_by(2, &buyer, PRICE);
    f.env.set_auths(&[]);
    assert!(matches!(f.client.try_open(&second, &hash(&f.env, 42), &None), Err(Err(_))));
    assert_eq!(f.status(&second), Status::Held);
}

#[test]
fn a_claim_is_possible_until_the_release_window_closes() {
    let f = Fixture::setup();
    // Never shipped: a claim (not delivered) is always possible.
    let unshipped = f.held(1);
    f.advance(100 * RELEASE);
    f.opened(&unshipped);

    let shipped = f.shipped(2);
    f.advance(RELEASE - 1);
    f.opened(&shipped);

    let late = f.shipped(3);
    f.advance(RELEASE);
    let claim = hash(&f.env, 42);
    let sig = f.sign_open(&f.rail_owner, &late, &claim);
    assert_eq!(f.client.try_open(&late, &claim, &Some(sig)), Err(Ok(Error::ClaimWindowClosed)));
    f.client.release(&late);
}

#[test]
fn a_purchase_has_one_dispute() {
    let f = Fixture::setup();
    let order_ref = f.held(1);
    f.opened(&order_ref);
    let claim = hash(&f.env, 43);
    let sig = f.sign_open(&f.rail_owner, &order_ref, &claim);
    assert_eq!(f.client.try_open(&order_ref, &claim, &Some(sig)), Err(Ok(Error::WrongStatus)));
}

// ------------------------------------------------------------------ respond

#[test]
fn the_store_answers_inside_its_window_and_a_late_answer_is_refused() {
    let f = Fixture::setup();
    let on_time = f.held(1);
    let late = f.held(2);
    f.opened(&on_time);
    f.opened(&late);

    f.advance(RESPONSE);
    f.client.respond(&on_time, &hash(&f.env, 50));
    assert_eq!(f.last_signer(), f.payee);
    let purchase = f.client.get(&on_time).unwrap();
    assert_eq!((purchase.status, purchase.response_hash), (Status::Responded, Some(hash(&f.env, 50))));
    assert_eq!(f.client.try_respond(&on_time, &hash(&f.env, 51)), Err(Ok(Error::WrongStatus)));

    f.advance(1);
    assert_eq!(f.client.try_respond(&late, &hash(&f.env, 50)), Err(Ok(Error::ResponseWindowClosed)));
}

// ---------------------------------------------------------- resolve, expire

#[test]
fn a_full_refund_reaches_the_rail_that_paid() {
    let f = Fixture::setup();
    let order_ref = f.shipped(1);
    f.opened(&order_ref);
    f.client.respond(&order_ref, &hash(&f.env, 50));
    f.client.resolve(&order_ref, &hash(&f.env, 60), &PRICE);

    assert_eq!(f.token.balance(&f.rail), PRICE);
    assert_eq!(f.token.balance(&f.payee), 0);
    let purchase = f.client.get(&order_ref).unwrap();
    assert_eq!((purchase.status, purchase.refund, purchase.verdict_hash), (Status::Resolved, PRICE, Some(hash(&f.env, 60))));
    assert_eq!(f.client.try_resolve(&order_ref, &hash(&f.env, 60), &PRICE), Err(Ok(Error::WrongStatus)));
    assert_eq!(f.client.try_expire(&order_ref), Err(Ok(Error::WrongStatus)));
}

#[test]
fn a_partial_refund_splits_the_payment_exactly_and_a_rejection_pays_the_store() {
    let f = Fixture::setup();
    let partial = f.held(1);
    let rejected = f.held(2);
    f.opened(&partial);
    f.opened(&rejected);
    f.client.respond(&partial, &hash(&f.env, 50));
    f.client.respond(&rejected, &hash(&f.env, 50));

    f.client.resolve(&partial, &hash(&f.env, 60), &1_000_000);
    assert_eq!(f.token.balance(&f.rail), 1_000_000);
    assert_eq!(f.token.balance(&f.payee), PRICE - 1_000_000);

    f.client.resolve(&rejected, &hash(&f.env, 61), &0);
    assert_eq!(f.token.balance(&f.rail), 1_000_000);
    assert_eq!(f.token.balance(&f.payee), 2 * PRICE - 1_000_000);
    assert_eq!(f.token.balance(&f.contract), 0);
    assert_eq!(f.client.unallocated(), 0);
}

#[test]
fn refuses_a_refund_above_the_purchase_or_below_zero() {
    let f = Fixture::setup();
    let order_ref = f.held(1);
    f.opened(&order_ref);
    f.client.respond(&order_ref, &hash(&f.env, 50));
    assert_eq!(f.client.try_resolve(&order_ref, &hash(&f.env, 60), &(PRICE + 1)), Err(Ok(Error::RefundExceedsAmount)));
    assert_eq!(f.client.try_resolve(&order_ref, &hash(&f.env, 60), &-1), Err(Ok(Error::InvalidAmount)));
}

#[test]
fn the_arbiter_waits_for_the_store_until_its_window_closes() {
    let f = Fixture::setup();
    let order_ref = f.held(1);
    f.opened(&order_ref);
    f.advance(RESPONSE);
    assert_eq!(f.client.try_resolve(&order_ref, &hash(&f.env, 60), &PRICE), Err(Ok(Error::ResponseWindowOpen)));
    f.advance(1);
    f.client.resolve(&order_ref, &hash(&f.env, 60), &PRICE);
    assert_eq!(f.token.balance(&f.rail), PRICE);
}

#[test]
fn past_the_arbiters_deadline_only_expire_applies_and_it_refunds_everything() {
    let f = Fixture::setup();
    let order_ref = f.held(1);
    f.opened(&order_ref);
    f.client.respond(&order_ref, &hash(&f.env, 50));

    f.advance(RESPONSE + RESOLVE);
    assert_eq!(f.client.try_expire(&order_ref), Err(Ok(Error::ResolveWindowOpen)));
    f.client.resolve(&order_ref, &hash(&f.env, 60), &0); // the last second still belongs to the arbiter

    let late = f.held(2);
    f.opened(&late);
    f.advance(RESPONSE + RESOLVE + 1);
    assert_eq!(f.client.try_resolve(&late, &hash(&f.env, 60), &0), Err(Ok(Error::ResolveWindowClosed)));
    f.env.set_auths(&[]); // anyone may expire
    f.client.expire(&late);

    assert_eq!(f.token.balance(&f.rail), PRICE);
    let purchase = f.client.get(&late).unwrap();
    assert_eq!((purchase.status, purchase.refund, purchase.verdict_hash), (Status::Expired, PRICE, None));
    assert_eq!(f.client.unallocated(), 0);
}

#[test]
fn release_and_expire_need_nobodys_auth() {
    let f = Fixture::setup();
    let order_ref = f.shipped(1);
    f.advance(RELEASE);
    f.env.set_auths(&[]);
    f.client.release(&order_ref);
    assert_eq!(f.token.balance(&f.payee), PRICE);
}

// ------------------------------------------------------------- authorisation

#[test]
fn only_the_operator_holds_and_ships_only_the_payee_answers_only_the_arbiter_resolves() {
    let f = Fixture::setup();
    let order_ref = f.held(1);
    assert_eq!(f.last_signer(), f.operator);
    f.client.mark_shipped(&order_ref);
    assert_eq!(f.last_signer(), f.operator);
    f.opened(&order_ref);
    f.client.respond(&order_ref, &hash(&f.env, 50));
    assert_eq!(f.last_signer(), f.payee);
    f.client.resolve(&order_ref, &hash(&f.env, 60), &0);
    assert_eq!(f.last_signer(), f.arbiter);

    // With nobody's authorisation mocked, none of them goes through.
    let disputed = f.held(2);
    f.opened(&disputed);
    let answered = f.held(3);
    f.opened(&answered);
    f.client.respond(&answered, &hash(&f.env, 50));
    let fresh = f.held(4);
    f.pay(PRICE);
    f.env.set_auths(&[]);
    assert!(matches!(f.client.try_hold(&order(&f.env, 5), &f.rail, &PRICE, &hash(&f.env, 5), &hash(&f.env, 105)), Err(Err(_))));
    assert!(matches!(f.client.try_mark_shipped(&fresh), Err(Err(_))));
    assert!(matches!(f.client.try_respond(&disputed, &hash(&f.env, 50)), Err(Err(_))));
    assert!(matches!(f.client.try_resolve(&answered, &hash(&f.env, 60), &PRICE), Err(Err(_))));
    assert!(f.client.get(&order(&f.env, 5)).is_none());
    assert_eq!((f.status(&fresh), f.status(&disputed), f.status(&answered)), (Status::Held, Status::Disputed, Status::Responded));
}

#[test]
fn the_arbiter_cannot_touch_a_purchase_nobody_disputed() {
    let f = Fixture::setup();
    let held = f.held(1);
    let shipped = f.shipped(2);
    f.advance(RESPONSE + RESOLVE + 1);
    for order_ref in [&held, &shipped] {
        assert_eq!(f.client.try_resolve(order_ref, &hash(&f.env, 60), &PRICE), Err(Ok(Error::WrongStatus)));
        assert_eq!(f.client.try_expire(order_ref), Err(Ok(Error::WrongStatus)));
    }
    assert_eq!(f.token.balance(&f.rail), 0);
    assert_eq!((f.status(&held), f.status(&shipped)), (Status::Held, Status::Shipped));
}

#[test]
fn a_disputed_purchase_cannot_be_shipped_into_a_release() {
    let f = Fixture::setup();
    let order_ref = f.held(1);
    f.opened(&order_ref);
    assert_eq!(f.client.try_mark_shipped(&order_ref), Err(Ok(Error::WrongStatus)));
}

#[test]
fn another_account_signing_for_the_operator_is_refused_by_the_host() {
    let f = Fixture::setup();
    f.pay(PRICE);
    let args = (order(&f.env, 1), f.rail.clone(), PRICE, hash(&f.env, 1), hash(&f.env, 101));
    let invoke = MockAuthInvoke { contract: &f.contract, fn_name: "hold", args: args.clone().into_val(&f.env), sub_invokes: &[] };
    f.env.mock_auths(&[MockAuth { address: &f.payee, invoke: &invoke }]);
    assert!(matches!(f.client.try_hold(&args.0, &args.1, &args.2, &args.3, &args.4), Err(Err(_))));
    assert!(f.client.get(&args.0).is_none());
}

// ------------------------------------------------- a refund nobody can deliver

#[test]
fn a_refund_the_payer_cannot_receive_is_owed_instead_of_blocking_the_verdict() {
    let f = Fixture::setup();
    let order_ref = f.held(1);
    f.opened(&order_ref);
    f.client.respond(&order_ref, &hash(&f.env, 50));
    f.minter.set_authorized(&f.rail, &false); // the payer's balance can no longer receive

    f.client.resolve(&order_ref, &hash(&f.env, 60), &1_000_000);
    let purchase = f.client.get(&order_ref).unwrap();
    assert_eq!((purchase.status, purchase.refund, purchase.refund_owed), (Status::Resolved, 1_000_000, 1_000_000));
    assert_eq!(f.token.balance(&f.payee), PRICE - 1_000_000); // the store got its part anyway
    assert_eq!(f.token.balance(&f.contract), 1_000_000);
    assert_eq!(f.client.unallocated(), 0); // the owed refund stays allocated: no hold can take it

    assert_eq!(f.client.try_claim_refund(&order_ref), Err(Ok(Error::RefundUndeliverable)));
    f.minter.set_authorized(&f.rail, &true);
    f.env.set_auths(&[]); // anyone may send it, and it only goes to the payer
    f.client.claim_refund(&order_ref);
    assert_eq!(f.token.balance(&f.rail), 1_000_000);
    assert_eq!(f.client.get(&order_ref).unwrap().refund_owed, 0);
    assert_eq!(f.client.try_claim_refund(&order_ref), Err(Ok(Error::NoRefundOwed)));
}

#[test]
fn a_classic_payer_without_a_trustline_cannot_freeze_the_money_through_expire() {
    let f = Fixture::setup();
    // An account this ledger has never seen: the same refusal as a dropped USDC trustline.
    let buyer = Address::from_str(&f.env, CLASSIC_PAYER);
    let order_ref = f.held_by(1, &buyer, PRICE);
    f.client.open(&order_ref, &hash(&f.env, 42), &None);
    f.advance(RESPONSE + RESOLVE + 1);

    f.client.expire(&order_ref);
    let purchase = f.client.get(&order_ref).unwrap();
    assert_eq!((purchase.status, purchase.refund_owed), (Status::Expired, PRICE));
    assert_eq!(f.client.unallocated(), 0);
    assert_eq!(f.client.try_claim_refund(&order_ref), Err(Ok(Error::RefundUndeliverable)));
}

#[test]
fn a_payee_that_cannot_receive_only_delays_its_own_payment() {
    let f = Fixture::setup();
    let released = f.shipped(1);
    let disputed = f.held(2);
    f.opened(&disputed);
    f.minter.set_authorized(&f.payee, &false);

    f.advance(RESPONSE + RESOLVE + 1);
    assert_eq!(f.client.try_release(&released), Err(Ok(Error::PayeeCannotReceive)));
    assert_eq!(f.status(&released), Status::Shipped); // nothing changed
    f.client.expire(&disputed); // the buyer is refunded in full regardless
    assert_eq!(f.token.balance(&f.rail), PRICE);

    f.minter.set_authorized(&f.payee, &true);
    f.client.release(&released);
    assert_eq!(f.token.balance(&f.payee), PRICE);
}

#[test]
fn a_delivered_refund_owes_nothing() {
    let f = Fixture::setup();
    let order_ref = f.held(1);
    f.opened(&order_ref);
    f.client.respond(&order_ref, &hash(&f.env, 50));
    f.client.resolve(&order_ref, &hash(&f.env, 60), &PRICE);
    assert_eq!(f.client.get(&order_ref).unwrap().refund_owed, 0);
    assert_eq!(f.client.try_claim_refund(&order_ref), Err(Ok(Error::NoRefundOwed)));
    assert_eq!(f.client.try_claim_refund(&order(&f.env, 9)), Err(Ok(Error::PurchaseNotFound)));
}

// ------------------------------------------------------------ shared formats

#[test]
fn the_open_message_matches_the_vector_the_typescript_side_signs() {
    let f = Fixture::setup_at(Some(VECTOR_CONTRACT));
    let message = f.client.open_message(&Bytes::from_slice(&f.env, b"ord_test123"), &hash(&f.env, 0x11));
    assert_eq!(message, from_hex(&f.env, VECTOR_MESSAGE));
    assert_eq!(message.len(), 107);
}

/// `policy_rail` is in this workspace, but linking two contracts into one test
/// binary is not something this repo does; what can drift is `owner()`. This
/// reads its source and fails if the function the escrow calls changes shape.
/// Its `Result` is transparent on the wire: an `Ok` arrives as the bare key the
/// escrow's client declares, and an `Err` aborts the call.
const RAIL_SOURCE: &str = include_str!("../../policy-rail/src/lib.rs");

#[test]
fn the_declared_rail_interface_matches_policy_rails_source() {
    let squash = |s: &str| s.split_whitespace().collect::<std::vec::Vec<_>>().join(" ");
    assert!(squash(RAIL_SOURCE).contains("pub fn owner(env: Env) -> Result<BytesN<32>, Error>"), "policy_rail's owner() changed shape");
}
