#![cfg(test)]
extern crate std;

use super::{
    DataKey, Error, ReceiptAnchored, ReceiptRecord, ReceiptRegistry, ReceiptRegistryClient, ENTRY_TTL_EXTEND_TO,
    MAX_ORDER_REF_LEN, STORAGE_SCHEMA_VERSION,
};
use soroban_sdk::{
    testutils::{storage::Persistent as _, Address as _, AuthorizedFunction, AuthorizedInvocation, Events as _, Ledger as _},
    Address, Bytes, BytesN, Env, Event, IntoVal, Symbol,
};

const NOW: u64 = 1_790_000_000;
const LEDGER: u32 = 4_812_648;
const HOODIE: i128 = 368_315_789; // 36.8315789 USDC

struct Fixture<'a> {
    env: Env,
    client: ReceiptRegistryClient<'a>,
    contract_id: Address,
    merchant: Address,
}

fn setup<'a>() -> Fixture<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(NOW);
    env.ledger().set_sequence_number(LEDGER);
    let contract_id = env.register(ReceiptRegistry, ());
    let client = ReceiptRegistryClient::new(&env, &contract_id);
    Fixture { merchant: Address::generate(&env), contract_id, env, client }
}

fn hash(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

fn order_ref(env: &Env, text: &str) -> Bytes {
    Bytes::from_slice(env, text.as_bytes())
}

// ---------------------------------------------------------------- acceptance

#[test]
fn anchoring_stores_the_record_with_ledger_and_time() {
    let f = setup();
    let h = hash(&f.env, 1);
    let r = order_ref(&f.env, "ord_mucrhcq85d377d2f30");

    f.client.anchor(&h, &f.merchant, &HOODIE, &r);

    assert_eq!(
        f.client.get(&h),
        Some(ReceiptRecord { merchant: f.merchant.clone(), amount: HOODIE, order_ref: r, ledger: LEDGER, timestamp: NOW })
    );
}

#[test]
fn an_unknown_hash_reads_none() {
    let f = setup();
    assert_eq!(f.client.get(&hash(&f.env, 9)), None);
}

#[test]
fn counts_are_per_merchant() {
    let f = setup();
    let other = Address::generate(&f.env);
    assert_eq!(f.client.count(&f.merchant), 0);

    f.client.anchor(&hash(&f.env, 1), &f.merchant, &HOODIE, &order_ref(&f.env, "ord_1"));
    f.client.anchor(&hash(&f.env, 2), &f.merchant, &HOODIE, &order_ref(&f.env, "ord_2"));
    f.client.anchor(&hash(&f.env, 3), &other, &1, &order_ref(&f.env, "ord_3"));

    assert_eq!(f.client.count(&f.merchant), 2);
    assert_eq!(f.client.count(&other), 1);
}

// ---------------------------------------------------------------- refusals

#[test]
fn the_same_hash_cannot_be_anchored_twice_even_by_another_merchant() {
    let f = setup();
    let h = hash(&f.env, 1);
    f.client.anchor(&h, &f.merchant, &HOODIE, &order_ref(&f.env, "ord_1"));

    let again = f.client.try_anchor(&h, &f.merchant, &HOODIE, &order_ref(&f.env, "ord_1"));
    assert_eq!(again, Err(Ok(Error::AlreadyAnchored)));

    let hijack = f.client.try_anchor(&h, &Address::generate(&f.env), &1, &order_ref(&f.env, "ord_x"));
    assert_eq!(hijack, Err(Ok(Error::AlreadyAnchored)));

    // The original record is untouched, and the count did not move.
    assert_eq!(f.client.get(&h).unwrap().amount, HOODIE);
    assert_eq!(f.client.count(&f.merchant), 1);
}

#[test]
fn zero_and_negative_amounts_are_refused() {
    let f = setup();
    let r = order_ref(&f.env, "ord_1");
    assert_eq!(f.client.try_anchor(&hash(&f.env, 1), &f.merchant, &0, &r), Err(Ok(Error::InvalidAmount)));
    assert_eq!(f.client.try_anchor(&hash(&f.env, 1), &f.merchant, &-5, &r), Err(Ok(Error::InvalidAmount)));
    assert_eq!(f.client.get(&hash(&f.env, 1)), None);
}

#[test]
fn empty_and_oversized_order_refs_are_refused() {
    let f = setup();
    let empty = Bytes::new(&f.env);
    let long = Bytes::from_slice(&f.env, &[b'x'; (MAX_ORDER_REF_LEN + 1) as usize]);
    let max = Bytes::from_slice(&f.env, &[b'x'; MAX_ORDER_REF_LEN as usize]);

    assert_eq!(f.client.try_anchor(&hash(&f.env, 1), &f.merchant, &HOODIE, &empty), Err(Ok(Error::InvalidOrderRef)));
    assert_eq!(f.client.try_anchor(&hash(&f.env, 2), &f.merchant, &HOODIE, &long), Err(Ok(Error::InvalidOrderRef)));
    f.client.anchor(&hash(&f.env, 3), &f.merchant, &HOODIE, &max);
    assert_eq!(f.client.count(&f.merchant), 1);
}

// ---------------------------------------------------------------- auth

#[test]
fn anchoring_requires_the_merchants_own_authorization() {
    let f = setup();
    let h = hash(&f.env, 1);
    let r = order_ref(&f.env, "ord_1");
    f.client.anchor(&h, &f.merchant, &HOODIE, &r);

    assert_eq!(
        f.env.auths(),
        std::vec![(
            f.merchant.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    f.contract_id.clone(),
                    Symbol::new(&f.env, "anchor"),
                    (h.clone(), f.merchant.clone(), HOODIE, r.clone()).into_val(&f.env),
                )),
                sub_invocations: std::vec![],
            }
        )]
    );
}

#[test]
#[should_panic]
fn anchoring_without_authorization_fails() {
    let env = Env::default(); // no mock_all_auths
    let contract_id = env.register(ReceiptRegistry, ());
    let client = ReceiptRegistryClient::new(&env, &contract_id);
    let merchant = Address::generate(&env);
    client.anchor(&hash(&env, 1), &merchant, &HOODIE, &order_ref(&env, "ord_1"));
}

// ---------------------------------------------------------------- events, storage

#[test]
fn anchoring_publishes_receipt_anchored() {
    let f = setup();
    let h = hash(&f.env, 7);
    let r = order_ref(&f.env, "ord_7");
    f.client.anchor(&h, &f.merchant, &HOODIE, &r);

    let expected = ReceiptAnchored { merchant: f.merchant.clone(), hash: h, amount: HOODIE, order_ref: r };
    assert_eq!(f.env.events().all(), std::vec![expected.to_xdr(&f.env, &f.contract_id)]);
}

#[test]
fn records_are_kept_alive_well_beyond_the_hackathon() {
    let f = setup();
    let h = hash(&f.env, 1);
    f.client.anchor(&h, &f.merchant, &HOODIE, &order_ref(&f.env, "ord_1"));

    let ttl = f.env.as_contract(&f.contract_id, || f.env.storage().persistent().get_ttl(&DataKey::Receipt(h.clone())));
    assert!(ttl >= ENTRY_TTL_EXTEND_TO - 1, "ttl {ttl}");
}

#[test]
fn reports_its_schema_version() {
    let f = setup();
    assert_eq!(f.client.schema_version(), STORAGE_SCHEMA_VERSION);
}
