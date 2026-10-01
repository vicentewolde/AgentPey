#![cfg(test)]
extern crate std;

use super::{AgentResolve, AgentResolveClient, Error, Guarantee, ReceiptRecord, Status, STORAGE_SCHEMA_VERSION};
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Bytes, BytesN, Env,
};

const NOW: u64 = 1_790_000_000; // a fixed "now" so tests never depend on the clock
const DAY: u64 = 86_400;
const WINDOW: u64 = 10 * DAY;
const RECEIPT_AMOUNT: i128 = 15_684_211; // 1.5684211 USDC, the T122 purchase

/// Stands in for `receipt-registry` (its own Cargo workspace): the same `get`
/// and the same record, plus a way to put one there.
#[contract]
pub struct MockRegistry;

#[contractimpl]
impl MockRegistry {
    pub fn put(env: Env, hash: BytesN<32>, record: ReceiptRecord) {
        env.storage().persistent().set(&hash, &record);
    }

    pub fn get(env: Env, hash: BytesN<32>) -> Option<ReceiptRecord> {
        env.storage().persistent().get(&hash)
    }
}

struct Fixture {
    env: Env,
    client: AgentResolveClient<'static>,
    contract: Address,
    arbiter: Address,
    token: TokenClient<'static>,
    registry: MockRegistryClient<'static>,
    merchant: Address,
    sponsor: Address,
    payer: Address,
}

fn hash(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

impl Fixture {
    fn setup() -> Self {
        let env = Env::default();
        env.ledger().set_timestamp(NOW);
        env.mock_all_auths();

        let arbiter = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_address = env.register_stellar_asset_contract_v2(token_admin).address();
        let registry_address = env.register(MockRegistry, ());
        let contract = env.register(AgentResolve, (arbiter.clone(), token_address.clone(), registry_address.clone(), WINDOW));

        let sponsor = Address::generate(&env);
        StellarAssetClient::new(&env, &token_address).mint(&sponsor, &100_0000000);

        Fixture {
            client: AgentResolveClient::new(&env, &contract),
            token: TokenClient::new(&env, &token_address),
            registry: MockRegistryClient::new(&env, &registry_address),
            merchant: Address::generate(&env),
            payer: Address::generate(&env),
            contract,
            arbiter,
            sponsor,
            env,
        }
    }

    /// Anchors a receipt for `merchant`, issued `age` seconds ago.
    fn anchor(&self, seed: u8, merchant: &Address, amount: i128, age: u64) -> BytesN<32> {
        let receipt = hash(&self.env, seed);
        let record = ReceiptRecord {
            merchant: merchant.clone(),
            amount,
            order_ref: Bytes::from_slice(&self.env, b"ord_test"),
            ledger: 1,
            timestamp: NOW - age,
        };
        self.registry.put(&receipt, &record);
        receipt
    }

    fn fund(&self, merchant: &Address, amount: i128) {
        self.client.deposit(&self.sponsor, merchant, &amount);
    }
}

#[test]
fn reports_its_schema_and_config() {
    let f = Fixture::setup();
    assert_eq!(f.client.schema_version(), STORAGE_SCHEMA_VERSION);
    let config = f.client.config();
    assert_eq!(config.arbiter, f.arbiter);
    assert_eq!(config.claim_window, WINDOW);
}

#[test]
#[should_panic]
fn refuses_a_zero_claim_window() {
    // A constructor error makes `register` panic: the contract is never deployed.
    let env = Env::default();
    let token = env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
    let registry = env.register(MockRegistry, ());
    env.register(AgentResolve, (Address::generate(&env), token, registry, 0_u64));
}

#[test]
fn a_sponsor_funds_a_merchant_guarantee_and_the_merchant_withdraws_what_is_free() {
    let f = Fixture::setup();
    f.fund(&f.merchant, 3_0000000);
    assert_eq!(f.client.guarantee(&f.merchant), Guarantee { balance: 3_0000000, locked: 0 });
    assert_eq!(f.token.balance(&f.contract), 3_0000000);

    let to = Address::generate(&f.env);
    f.client.withdraw(&f.merchant, &to, &1_0000000);
    assert_eq!(f.token.balance(&to), 1_0000000);
    assert_eq!(f.client.try_withdraw(&f.merchant, &to, &2_0000001), Err(Ok(Error::InsufficientFree)));
}

#[test]
fn a_full_refund_reaches_the_payer_and_records_the_verdict_next_to_the_receipt() {
    let f = Fixture::setup();
    f.fund(&f.merchant, 3_0000000);
    let receipt = f.anchor(1, &f.merchant, RECEIPT_AMOUNT, DAY);

    f.client.open(&receipt, &f.payer, &hash(&f.env, 9), &RECEIPT_AMOUNT);
    assert_eq!(f.client.guarantee(&f.merchant).locked, RECEIPT_AMOUNT);
    let opened = f.client.get(&receipt).unwrap();
    assert_eq!(opened.status, Status::Open);
    assert_eq!(opened.merchant, f.merchant);

    let verdict = hash(&f.env, 7);
    f.client.resolve(&receipt, &verdict, &RECEIPT_AMOUNT);

    assert_eq!(f.token.balance(&f.payer), RECEIPT_AMOUNT);
    assert_eq!(f.client.guarantee(&f.merchant), Guarantee { balance: 3_0000000 - RECEIPT_AMOUNT, locked: 0 });
    let resolved = f.client.get(&receipt).unwrap();
    assert_eq!(resolved.status, Status::Resolved);
    assert_eq!(resolved.verdict_hash, Some(verdict));
    assert_eq!(resolved.refund, RECEIPT_AMOUNT);
    assert_eq!(resolved.resolved_at, NOW);
}

#[test]
fn a_partial_refund_pays_part_and_a_rejection_pays_nothing_both_releasing_the_lock() {
    let f = Fixture::setup();
    f.fund(&f.merchant, 4_0000000); // two claims of 1.5684211 each must both fit
    let partial = f.anchor(1, &f.merchant, RECEIPT_AMOUNT, DAY);
    let rejected = f.anchor(2, &f.merchant, RECEIPT_AMOUNT, DAY);
    f.client.open(&partial, &f.payer, &hash(&f.env, 9), &RECEIPT_AMOUNT);
    f.client.open(&rejected, &f.payer, &hash(&f.env, 8), &RECEIPT_AMOUNT);

    f.client.resolve(&partial, &hash(&f.env, 7), &5_000_000);
    f.client.resolve(&rejected, &hash(&f.env, 6), &0);

    assert_eq!(f.token.balance(&f.payer), 5_000_000);
    assert_eq!(f.client.guarantee(&f.merchant), Guarantee { balance: 4_0000000 - 5_000_000, locked: 0 });
}

#[test]
fn refuses_a_refund_larger_than_the_locked_claim() {
    let f = Fixture::setup();
    f.fund(&f.merchant, 3_0000000);
    let receipt = f.anchor(1, &f.merchant, RECEIPT_AMOUNT, DAY);
    f.client.open(&receipt, &f.payer, &hash(&f.env, 9), &1_000_000);
    assert_eq!(f.client.try_resolve(&receipt, &hash(&f.env, 7), &1_000_001), Err(Ok(Error::RefundExceedsClaim)));
    assert_eq!(f.client.try_resolve(&receipt, &hash(&f.env, 7), &-1), Err(Ok(Error::InvalidAmount)));
}

#[test]
fn refuses_a_claim_larger_than_the_anchored_receipt() {
    let f = Fixture::setup();
    f.fund(&f.merchant, 3_0000000);
    let receipt = f.anchor(1, &f.merchant, RECEIPT_AMOUNT, DAY);
    assert_eq!(f.client.try_open(&receipt, &f.payer, &hash(&f.env, 9), &(RECEIPT_AMOUNT + 1)), Err(Ok(Error::AmountExceedsReceipt)));
    assert_eq!(f.client.try_open(&receipt, &f.payer, &hash(&f.env, 9), &0), Err(Ok(Error::InvalidAmount)));
}

#[test]
fn refuses_a_receipt_that_is_not_anchored() {
    let f = Fixture::setup();
    f.fund(&f.merchant, 3_0000000);
    assert_eq!(f.client.try_open(&hash(&f.env, 42), &f.payer, &hash(&f.env, 9), &1), Err(Ok(Error::ReceiptNotAnchored)));
}

#[test]
fn never_touches_another_merchants_guarantee() {
    let f = Fixture::setup();
    let other = Address::generate(&f.env);
    f.fund(&other, 3_0000000);
    // The receipt is `merchant`'s, who has no guarantee; `other`'s is not used.
    let receipt = f.anchor(1, &f.merchant, RECEIPT_AMOUNT, DAY);
    assert_eq!(f.client.try_open(&receipt, &f.payer, &hash(&f.env, 9), &RECEIPT_AMOUNT), Err(Ok(Error::InsufficientGuarantee)));
    assert_eq!(f.client.guarantee(&other), Guarantee { balance: 3_0000000, locked: 0 });
}

#[test]
fn refuses_to_open_twice_or_resolve_twice() {
    let f = Fixture::setup();
    f.fund(&f.merchant, 3_0000000);
    let receipt = f.anchor(1, &f.merchant, RECEIPT_AMOUNT, DAY);
    f.client.open(&receipt, &f.payer, &hash(&f.env, 9), &RECEIPT_AMOUNT);
    assert_eq!(f.client.try_open(&receipt, &f.payer, &hash(&f.env, 9), &RECEIPT_AMOUNT), Err(Ok(Error::AlreadyDisputed)));

    f.client.resolve(&receipt, &hash(&f.env, 7), &RECEIPT_AMOUNT);
    assert_eq!(f.client.try_resolve(&receipt, &hash(&f.env, 7), &RECEIPT_AMOUNT), Err(Ok(Error::AlreadyResolved)));
    // A resolved dispute still blocks a new one over the same receipt.
    assert_eq!(f.client.try_open(&receipt, &f.payer, &hash(&f.env, 9), &1), Err(Ok(Error::AlreadyDisputed)));
    assert_eq!(f.client.try_resolve(&hash(&f.env, 43), &hash(&f.env, 7), &0), Err(Ok(Error::DisputeNotFound)));
}

#[test]
fn refuses_a_claim_after_the_window_with_the_last_second_inclusive() {
    let f = Fixture::setup();
    f.fund(&f.merchant, 3_0000000);
    let on_the_edge = f.anchor(1, &f.merchant, RECEIPT_AMOUNT, WINDOW);
    let too_late = f.anchor(2, &f.merchant, RECEIPT_AMOUNT, WINDOW + 1);
    f.client.open(&on_the_edge, &f.payer, &hash(&f.env, 9), &1);
    assert_eq!(f.client.try_open(&too_late, &f.payer, &hash(&f.env, 9), &1), Err(Ok(Error::ClaimWindowClosed)));
}

#[test]
fn a_merchant_cannot_withdraw_what_an_open_dispute_locks() {
    let f = Fixture::setup();
    f.fund(&f.merchant, 2_0000000);
    let receipt = f.anchor(1, &f.merchant, RECEIPT_AMOUNT, DAY);
    f.client.open(&receipt, &f.payer, &hash(&f.env, 9), &RECEIPT_AMOUNT);
    let to = Address::generate(&f.env);
    assert_eq!(f.client.try_withdraw(&f.merchant, &to, &2_0000000), Err(Ok(Error::InsufficientFree)));
    f.client.withdraw(&f.merchant, &to, &(2_0000000 - RECEIPT_AMOUNT));
    f.client.resolve(&receipt, &hash(&f.env, 7), &RECEIPT_AMOUNT);
    assert_eq!(f.token.balance(&f.payer), RECEIPT_AMOUNT);
    assert_eq!(f.client.guarantee(&f.merchant), Guarantee { balance: 0, locked: 0 });
}

#[test]
fn only_the_arbiter_opens_and_resolves() {
    let f = Fixture::setup();
    f.fund(&f.merchant, 3_0000000);
    let receipt = f.anchor(1, &f.merchant, RECEIPT_AMOUNT, DAY);

    f.client.open(&receipt, &f.payer, &hash(&f.env, 9), &1);
    let (signer, _) = f.env.auths().into_iter().next().unwrap();
    assert_eq!(signer, f.arbiter);

    f.client.resolve(&receipt, &hash(&f.env, 7), &1);
    let (signer, _) = f.env.auths().into_iter().next().unwrap();
    assert_eq!(signer, f.arbiter);

    // With nobody's authorisation mocked, neither call goes through.
    let receipt = f.anchor(2, &f.merchant, RECEIPT_AMOUNT, DAY);
    f.env.set_auths(&[]);
    assert!(f.client.try_open(&receipt, &f.payer, &hash(&f.env, 9), &1).is_err());
    assert!(f.client.get(&receipt).is_none());
}

#[test]
fn only_the_merchant_withdraws_and_only_the_funder_deposits() {
    let f = Fixture::setup();
    f.fund(&f.merchant, 1_0000000);
    let (signer, _) = f.env.auths().into_iter().next().unwrap();
    assert_eq!(signer, f.sponsor);

    let to = Address::generate(&f.env);
    f.client.withdraw(&f.merchant, &to, &1);
    let (signer, _) = f.env.auths().into_iter().next().unwrap();
    assert_eq!(signer, f.merchant);
}
