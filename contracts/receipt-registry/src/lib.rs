#![no_std]
//! Vitrinee receipt registry.
//!
//! Receipts never go on chain. A merchant anchors only the SHA-256 of the
//! compact JWS it signed, with the amount and its own order reference, so
//! anyone holding the receipt can check that the merchant committed to it at
//! a given ledger — and that nobody changed a byte since.
//!
//! Deliberately small (docs/DECISIONES.md, V-3): no admin, no upgrade, no
//! constructor. Nobody can delete or rewrite an anchored receipt, including
//! the merchant that anchored it and whoever deployed this contract.

use soroban_sdk::{contract, contracterror, contractevent, contractimpl, contracttype, Address, Bytes, BytesN, Env};

/// Bumped whenever the persistent storage layout changes incompatibly.
/// Off-chain readers decode `DataKey::Receipt` directly (packages/anchor).
pub const STORAGE_SCHEMA_VERSION: u32 = 1;

/// Longest `order_ref` accepted, in bytes. Vitrinee order ids are ~24 bytes.
pub const MAX_ORDER_REF_LEN: u32 = 64;

pub const LEDGERS_PER_DAY: u32 = 17_280; // ~5 s per ledger

/// Persistent entries are extended on every write and read-through is not
/// required: without this the state is archived and the registry silently
/// stops answering within weeks.
pub const ENTRY_TTL_THRESHOLD: u32 = 30 * LEDGERS_PER_DAY;
pub const ENTRY_TTL_EXTEND_TO: u32 = 120 * LEDGERS_PER_DAY;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
#[repr(u32)]
pub enum Error {
    /// This hash is already anchored. Re-anchoring is refused so a record can
    /// never be overwritten with a different merchant, amount or reference.
    AlreadyAnchored = 1,
    /// `amount` must be positive (USDC atomic units, 7 decimals).
    InvalidAmount = 2,
    /// `order_ref` is empty or longer than `MAX_ORDER_REF_LEN`.
    InvalidOrderRef = 3,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReceiptRecord {
    pub merchant: Address,
    pub amount: i128,
    pub order_ref: Bytes,
    pub ledger: u32,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Receipt(BytesN<32>),
    Count(Address),
}

/// Topics: `("receipt_anchored", merchant)`.
#[contractevent(topics = ["receipt_anchored"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReceiptAnchored {
    #[topic]
    pub merchant: Address,
    pub hash: BytesN<32>,
    pub amount: i128,
    pub order_ref: Bytes,
}

#[contract]
pub struct ReceiptRegistry;

#[contractimpl]
impl ReceiptRegistry {
    pub fn schema_version(_env: Env) -> u32 {
        STORAGE_SCHEMA_VERSION
    }

    /// Anchors a receipt hash. Only the merchant named can anchor for itself.
    pub fn anchor(env: Env, hash: BytesN<32>, merchant: Address, amount: i128, order_ref: Bytes) -> Result<(), Error> {
        merchant.require_auth();

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if order_ref.is_empty() || order_ref.len() > MAX_ORDER_REF_LEN {
            return Err(Error::InvalidOrderRef);
        }

        let key = DataKey::Receipt(hash.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyAnchored);
        }

        let record = ReceiptRecord {
            merchant: merchant.clone(),
            amount,
            order_ref: order_ref.clone(),
            ledger: env.ledger().sequence(),
            timestamp: env.ledger().timestamp(),
        };
        env.storage().persistent().set(&key, &record);
        Self::extend(&env, &key);

        let count_key = DataKey::Count(merchant.clone());
        let count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);
        env.storage().persistent().set(&count_key, &(count + 1));
        Self::extend(&env, &count_key);

        ReceiptAnchored { merchant, hash, amount, order_ref }.publish(&env);
        Ok(())
    }

    pub fn get(env: Env, hash: BytesN<32>) -> Option<ReceiptRecord> {
        env.storage().persistent().get(&DataKey::Receipt(hash))
    }

    /// How many receipts this merchant has anchored.
    pub fn count(env: Env, merchant: Address) -> u32 {
        env.storage().persistent().get(&DataKey::Count(merchant)).unwrap_or(0)
    }

    fn extend(env: &Env, key: &DataKey) {
        env.storage()
            .persistent()
            .extend_ttl(key, ENTRY_TTL_THRESHOLD, ENTRY_TTL_EXTEND_TO);
    }
}

mod test;
