#![cfg(test)]
extern crate std;

use super::{Error, PolicyRail, Signature, STORAGE_SCHEMA_VERSION};
use ed25519_dalek::{Signer, SigningKey};
use rand::rngs::OsRng;
use soroban_sdk::{
    auth::{Context, ContractContext},
    symbol_short,
    testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    vec, Address, BytesN, Env, IntoVal, InvokeError, Val, Vec,
};

const NOW: u64 = 1_772_000_000; // a fixed "now" so tests never depend on the clock
const DAY: u64 = 86_400;

fn generate_key() -> SigningKey {
    SigningKey::generate(&mut OsRng)
}

fn public_key_bytes(env: &Env, key: &SigningKey) -> BytesN<32> {
    BytesN::from_array(env, &key.verifying_key().to_bytes())
}

fn payload_bytes(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

struct Fixture {
    env: Env,
    contract_id: Address,
    owner_key: SigningKey,
    owner: BytesN<32>,
    /// The wallet with the last word over the rail — `withdraw`/`set_owner`.
    principal: Address,
    /// A real Stellar Asset Contract, not a bare `Address`: `withdraw` moves
    /// actual balances, so the asset has to be something that can hold one.
    asset: Address,
    per_tx: i128,
    per_day: i128,
    valid_until: u64,
}

impl Fixture {
    fn setup() -> Self {
        Self::with_limits(500_0000000, 2_000_0000000) // 500 / 2000, arbitrary units
    }

    fn with_limits(per_tx: i128, per_day: i128) -> Self {
        let env = Env::default();
        env.ledger().set_timestamp(NOW);
        let owner_key = generate_key();
        let owner = public_key_bytes(&env, &owner_key);
        let principal = Address::generate(&env);
        // `soroban-sdk`'s own SEP-41 double, so `withdraw` has a real balance
        // to move rather than a stand-in address nothing can hold value at.
        let token_admin = Address::generate(&env);
        let asset = env.register_stellar_asset_contract_v2(token_admin).address();
        let valid_until = NOW + 30 * DAY;

        let contract_id = env.register(
            PolicyRail,
            (
                owner.clone(),
                principal.clone(),
                asset.clone(),
                per_tx,
                per_day,
                valid_until,
            ),
        );

        Fixture {
            env,
            contract_id,
            owner_key,
            owner,
            principal,
            asset,
            per_tx,
            per_day,
            valid_until,
        }
    }

    /// Mints `amount` of the rail's asset into the rail itself — what a
    /// principal funding their own rail leaves behind. The token admin's
    /// authorisation is mocked and then cleared, so nothing a test does
    /// afterwards runs with auth mocked on.
    fn fund(&self, amount: i128) {
        self.env.mock_all_auths();
        StellarAssetClient::new(&self.env, &self.asset).mint(&self.contract_id, &amount);
        self.env.set_auths(&[]);
    }

    fn balance_of(&self, who: &Address) -> i128 {
        TokenClient::new(&self.env, &self.asset).balance(who)
    }

    fn client(&self) -> super::PolicyRailClient<'_> {
        super::PolicyRailClient::new(&self.env, &self.contract_id)
    }

    /// `withdraw`, authorised by the principal — the only signer it accepts.
    fn withdraw_as_principal(
        &self,
        to: &Address,
        amount: i128,
    ) -> Result<Result<(), soroban_sdk::ConversionError>, Result<Error, InvokeError>> {
        self.client()
            .mock_auths(&[MockAuth {
                address: &self.principal,
                invoke: &MockAuthInvoke {
                    contract: &self.contract_id,
                    fn_name: "withdraw",
                    args: (to.clone(), amount).into_val(&self.env),
                    sub_invokes: &[],
                },
            }])
            .try_withdraw(to, &amount)
    }

    /// `set_owner`, authorised by the principal.
    fn set_owner_as_principal(
        &self,
        new_owner: &BytesN<32>,
    ) -> Result<Result<(), soroban_sdk::ConversionError>, Result<Error, InvokeError>> {
        self.client()
            .mock_auths(&[MockAuth {
                address: &self.principal,
                invoke: &MockAuthInvoke {
                    contract: &self.contract_id,
                    fn_name: "set_owner",
                    args: (new_owner.clone(),).into_val(&self.env),
                    sub_invokes: &[],
                },
            }])
            .try_set_owner(new_owner)
    }

    fn sign(&self, payload: &BytesN<32>) -> BytesN<64> {
        self.sign_with(&self.owner_key, payload)
    }

    fn sign_with(&self, key: &SigningKey, payload: &BytesN<32>) -> BytesN<64> {
        let signature = key.sign(&payload.to_array());
        BytesN::from_array(&self.env, &signature.to_bytes())
    }

    fn signature_val_from(&self, public_key: &BytesN<32>, signature: &BytesN<64>) -> Val {
        let sig = Signature {
            public_key: public_key.clone(),
            signature: signature.clone(),
        };
        let sigs: Vec<Signature> = vec![&self.env, sig];
        sigs.into_val(&self.env)
    }

    /// The owner's real signature over `payload` — the normal case.
    fn signature_val(&self, payload: &BytesN<32>) -> Val {
        let signature = self.sign(payload);
        self.signature_val_from(&self.owner, &signature)
    }

    fn no_contexts(&self) -> Vec<Context> {
        vec![&self.env]
    }

    /// The one call shape this rail approves: `asset.transfer(this contract, to, amount)`.
    fn transfer_context(&self, to: &Address, amount: i128) -> Vec<Context> {
        vec![&self.env, self.context_calling(&self.asset, "transfer", to, amount)]
    }

    fn context_calling(
        &self,
        contract: &Address,
        fn_name: &str,
        to: &Address,
        amount: i128,
    ) -> Context {
        let args: Vec<Val> = vec![
            &self.env,
            self.contract_id.clone().into_val(&self.env),
            to.clone().into_val(&self.env),
            amount.into_val(&self.env),
        ];
        Context::Contract(ContractContext {
            contract: contract.clone(),
            fn_name: soroban_sdk::Symbol::new(&self.env, fn_name),
            args,
        })
    }

    fn check_auth(
        &self,
        payload: &BytesN<32>,
        sig_val: Val,
        contexts: Vec<Context>,
    ) -> Result<(), Result<Error, InvokeError>> {
        self.env
            .try_invoke_contract_check_auth::<Error>(&self.contract_id, payload, sig_val, &contexts)
    }

    fn authorise(&self, to: &Address, amount: i128, seed: u8) -> Result<(), Result<Error, InvokeError>> {
        self.authorise_with(&self.owner_key, to, amount, seed)
    }

    /// The same authorisation, signed by an arbitrary key — what `set_owner`
    /// changes the answer to.
    fn authorise_with(
        &self,
        key: &SigningKey,
        to: &Address,
        amount: i128,
        seed: u8,
    ) -> Result<(), Result<Error, InvokeError>> {
        let payload = payload_bytes(&self.env, seed);
        let public_key = public_key_bytes(&self.env, key);
        let signature = self.sign_with(key, &payload);
        let sig_val = self.signature_val_from(&public_key, &signature);
        self.check_auth(&payload, sig_val, self.transfer_context(to, amount))
    }

    fn spent_today(&self) -> i128 {
        let day = NOW / DAY;
        super::PolicyRailClient::new(&self.env, &self.contract_id).spent_on(&day)
    }
}

// ------------------------------------------------------------- configuration

#[test]
fn reports_the_configuration_it_was_deployed_with() {
    let f = Fixture::setup();
    let client = super::PolicyRailClient::new(&f.env, &f.contract_id);

    assert_eq!(STORAGE_SCHEMA_VERSION, 1);
    assert_eq!(client.schema_version(), STORAGE_SCHEMA_VERSION);
    assert_eq!(client.owner(), f.owner);
    assert_eq!(client.principal(), f.principal);
    assert_eq!(client.asset(), f.asset);
    assert_eq!(client.per_tx(), f.per_tx);
    assert_eq!(client.per_day(), f.per_day);
    assert_eq!(client.valid_until(), f.valid_until);
}

#[test]
fn a_zero_per_tx_limit_is_refused_at_deploy_time() {
    let env = Env::default();
    env.ledger().set_timestamp(NOW);
    let owner = public_key_bytes(&env, &generate_key());
    let principal = Address::generate(&env);
    let asset = Address::generate(&env);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        env.register(
            PolicyRail,
            (owner, principal, asset, 0i128, 100i128, NOW + DAY),
        )
    }));

    assert!(result.is_err(), "a zero per_tx must not deploy");
}

#[test]
fn a_valid_until_that_is_already_in_the_past_is_refused_at_deploy_time() {
    let env = Env::default();
    env.ledger().set_timestamp(NOW);
    let owner = public_key_bytes(&env, &generate_key());
    let principal = Address::generate(&env);
    let asset = Address::generate(&env);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        env.register(
            PolicyRail,
            (owner, principal, asset, 100i128, 100i128, NOW - 1),
        )
    }));

    assert!(result.is_err(), "an already-expired valid_until must not deploy");
}

// -------------------------------------------------------- the happy path

#[test]
fn a_transfer_within_both_limits_is_authorised_and_recorded() {
    let f = Fixture::setup();
    let to = Address::generate(&f.env);

    let result = f.authorise(&to, 100_0000000, 1);

    assert_eq!(result, Ok(()));
    assert_eq!(f.spent_today(), 100_0000000);
}

#[test]
fn spend_accumulates_across_authorisations_on_the_same_day() {
    let f = Fixture::setup();
    let to = Address::generate(&f.env);

    assert_eq!(f.authorise(&to, 100_0000000, 1), Ok(()));
    assert_eq!(f.authorise(&to, 50_0000000, 2), Ok(()));

    assert_eq!(f.spent_today(), 150_0000000);
}

// ------------------------------------------------------------------- perTx

#[test]
fn a_transfer_over_per_tx_is_refused_and_nothing_is_recorded() {
    let f = Fixture::setup();
    let to = Address::generate(&f.env);

    let result = f.authorise(&to, f.per_tx + 1, 1);

    assert_eq!(result, Err(Ok(Error::PerTxExceeded)));
    assert_eq!(f.spent_today(), 0, "a refused authorisation must not spend budget");
}

#[test]
fn a_transfer_of_exactly_per_tx_is_allowed() {
    let f = Fixture::setup();
    let to = Address::generate(&f.env);

    assert_eq!(f.authorise(&to, f.per_tx, 1), Ok(()));
}

// ------------------------------------------------------------------ perDay

#[test]
fn a_second_transfer_that_would_push_the_day_over_per_day_is_refused() {
    // 500 perTx, 2000 perDay: four transfers of 500 exhaust the day exactly;
    // a fifth of any size must be refused, even a single stroop.
    let f = Fixture::setup();
    let to = Address::generate(&f.env);

    for seed in 1..=4u8 {
        assert_eq!(f.authorise(&to, f.per_tx, seed), Ok(()));
    }
    assert_eq!(f.spent_today(), f.per_day);

    let result = f.authorise(&to, 1, 5);

    assert_eq!(result, Err(Ok(Error::PerDayExceeded)));
    assert_eq!(f.spent_today(), f.per_day, "the refused fifth transfer must not be recorded");
}

#[test]
fn the_day_resets_naturally_because_the_key_is_the_ledger_s_own_day() {
    let f = Fixture::setup();
    let to = Address::generate(&f.env);
    assert_eq!(f.authorise(&to, f.per_tx, 1), Ok(()));

    // Tomorrow, UTC — a fresh day, a fresh budget. Nothing about yesterday's
    // spend carries over, because `SpentOn(day)` is keyed by the day itself.
    f.env.ledger().set_timestamp(NOW + DAY);
    let tomorrow = f.authorise(&to, f.per_tx, 2);

    assert_eq!(tomorrow, Ok(()));
}

// ------------------------------------------------------------- expiration

#[test]
fn a_transfer_after_valid_until_is_refused_even_if_everything_else_is_correct() {
    let f = Fixture::setup();
    let to = Address::generate(&f.env);
    f.env.ledger().set_timestamp(f.valid_until + 1);

    let result = f.authorise(&to, 1, 1);

    assert_eq!(result, Err(Ok(Error::Expired)));
}

// ------------------------------------------------------- shape of the call

#[test]
fn no_auth_contexts_at_all_is_refused() {
    let f = Fixture::setup();
    let payload = payload_bytes(&f.env, 1);
    let sig_val = f.signature_val(&payload);

    let result = f.check_auth(&payload, sig_val, f.no_contexts());

    assert_eq!(result, Err(Ok(Error::UnexpectedInvocation)));
}

#[test]
fn more_than_one_auth_context_is_refused() {
    let f = Fixture::setup();
    let to = Address::generate(&f.env);
    let payload = payload_bytes(&f.env, 1);
    let sig_val = f.signature_val(&payload);
    let one = f.transfer_context(&to, 10_0000000);
    let contexts: Vec<Context> = vec![&f.env, one.get_unchecked(0), one.get_unchecked(0)];

    let result = f.check_auth(&payload, sig_val, contexts);

    assert_eq!(result, Err(Ok(Error::UnexpectedInvocation)));
}

#[test]
fn a_call_to_a_contract_other_than_this_rail_s_asset_is_refused() {
    let f = Fixture::setup();
    let to = Address::generate(&f.env);
    let a_different_token = Address::generate(&f.env);
    let payload = payload_bytes(&f.env, 1);
    let sig_val = f.signature_val(&payload);
    let contexts = vec![&f.env, f.context_calling(&a_different_token, "transfer", &to, 10_0000000)];

    let result = f.check_auth(&payload, sig_val, contexts);

    assert_eq!(result, Err(Ok(Error::UnexpectedInvocation)));
}

#[test]
fn a_call_to_a_function_other_than_transfer_is_refused() {
    let f = Fixture::setup();
    let to = Address::generate(&f.env);
    let payload = payload_bytes(&f.env, 1);
    let sig_val = f.signature_val(&payload);
    let contexts = vec![&f.env, f.context_calling(&f.asset, "burn", &to, 10_0000000)];

    let result = f.check_auth(&payload, sig_val, contexts);

    assert_eq!(result, Err(Ok(Error::UnexpectedInvocation)));
}

#[test]
fn a_transfer_where_this_rail_is_not_the_source_is_refused() {
    // Someone else's transfer, on the rail's own asset — this account never
    // asked to authorise moving funds it is not the source of.
    let f = Fixture::setup();
    let to = Address::generate(&f.env);
    let someone_else = Address::generate(&f.env);
    let payload = payload_bytes(&f.env, 1);
    let sig_val = f.signature_val(&payload);
    let args: Vec<Val> = vec![
        &f.env,
        someone_else.into_val(&f.env),
        to.into_val(&f.env),
        10_0000000i128.into_val(&f.env),
    ];
    let contexts = vec![
        &f.env,
        Context::Contract(ContractContext {
            contract: f.asset.clone(),
            fn_name: symbol_short!("transfer"),
            args,
        }),
    ];

    let result = f.check_auth(&payload, sig_val, contexts);

    assert_eq!(result, Err(Ok(Error::UnexpectedInvocation)));
}

#[test]
fn a_zero_amount_transfer_is_refused() {
    let f = Fixture::setup();
    let to = Address::generate(&f.env);

    let result = f.authorise(&to, 0, 1);

    assert_eq!(result, Err(Ok(Error::UnexpectedInvocation)));
}

// -------------------------------------------------------------- signer identity

#[test]
fn a_valid_signature_from_the_owner_is_accepted() {
    let f = Fixture::setup();
    let to = Address::generate(&f.env);

    assert_eq!(f.authorise(&to, 10_0000000, 1), Ok(()));
}

#[test]
fn a_signature_from_a_key_that_is_not_the_owner_is_rejected_without_touching_crypto() {
    // The stranger's signature is genuine — over the right payload, with a
    // real key — and still refused, because `public_key != owner` is checked
    // before `ed25519_verify` ever runs. A forged signer identity is caught
    // by comparison, not by a cryptographic failure that happens to also work.
    let f = Fixture::setup();
    let to = Address::generate(&f.env);
    let stranger_key = generate_key();
    let stranger_public_key = public_key_bytes(&f.env, &stranger_key);
    let payload = payload_bytes(&f.env, 1);
    let stranger_signature = BytesN::from_array(&f.env, &stranger_key.sign(&payload.to_array()).to_bytes());
    let sig_val = f.signature_val_from(&stranger_public_key, &stranger_signature);

    let result = f.check_auth(&payload, sig_val, f.transfer_context(&to, 10_0000000));

    assert_eq!(result, Err(Ok(Error::UnknownSigner)));
}

#[test]
fn no_signatures_at_all_is_rejected() {
    let f = Fixture::setup();
    let to = Address::generate(&f.env);
    let payload = payload_bytes(&f.env, 1);
    let empty: Vec<Signature> = vec![&f.env];
    let sig_val: Val = empty.into_val(&f.env);

    let result = f.check_auth(&payload, sig_val, f.transfer_context(&to, 10_0000000));

    assert_eq!(result, Err(Ok(Error::UnknownSigner)));
}

#[test]
fn more_than_one_signature_is_rejected_even_if_one_of_them_is_the_owner_s() {
    let f = Fixture::setup();
    let to = Address::generate(&f.env);
    let payload = payload_bytes(&f.env, 1);
    let owner_signature = f.sign(&payload);
    let extra_key = generate_key();
    let extra_public_key = public_key_bytes(&f.env, &extra_key);
    let extra_signature = BytesN::from_array(&f.env, &extra_key.sign(&payload.to_array()).to_bytes());

    let sigs: Vec<Signature> = vec![
        &f.env,
        Signature {
            public_key: f.owner.clone(),
            signature: owner_signature,
        },
        Signature {
            public_key: extra_public_key,
            signature: extra_signature,
        },
    ];
    let sig_val: Val = sigs.into_val(&f.env);

    let result = f.check_auth(&payload, sig_val, f.transfer_context(&to, 10_0000000));

    assert_eq!(result, Err(Ok(Error::UnknownSigner)));
}

#[test]
fn a_tampered_signature_from_the_real_owner_key_is_refused_by_the_host_itself() {
    // The public key matches — this passes our own `UnknownSigner` check —
    // but the signature bytes don't correspond to this payload.
    // `ed25519_verify` has no fallible return of its own: the host aborts the
    // whole invocation, which `try_invoke_contract_check_auth` surfaces as
    // `InvokeError::Abort`, never as one of `Error`'s own variants. Same
    // fail-closed direction as everywhere else in this project (`B-1`), just
    // enforced by the host instead of a typed `Result`.
    let f = Fixture::setup();
    let to = Address::generate(&f.env);
    let payload = payload_bytes(&f.env, 1);
    let signed_a_different_payload = f.sign(&payload_bytes(&f.env, 2));
    let sig_val = f.signature_val_from(&f.owner, &signed_a_different_payload);

    let result = f.check_auth(&payload, sig_val, f.transfer_context(&to, 10_0000000));

    assert_eq!(result, Err(Err(InvokeError::Abort)));
}

// --------------------------------------------- withdraw, gated by the principal

#[test]
fn the_principal_can_withdraw_the_rail_s_balance() {
    // The whole point of `G9`: money that reached the rail can leave it on
    // the principal's say-so alone — the `owner` key is not involved, and is
    // not consulted.
    let f = Fixture::setup();
    let destination = Address::generate(&f.env);
    f.fund(1_000_0000000);

    let result = f.withdraw_as_principal(&destination, 400_0000000);

    assert_eq!(result, Ok(Ok(())));
    assert_eq!(f.balance_of(&destination), 400_0000000);
    assert_eq!(f.balance_of(&f.contract_id), 600_0000000);
}

#[test]
fn a_withdrawal_is_not_bound_by_per_tx_or_per_day() {
    // Those two limits constrain what the *delegated key* may spend. Taking
    // your own money back is not spending, and a principal whose balance
    // exceeded a day's allowance could otherwise never fully recover it.
    let f = Fixture::setup();
    let destination = Address::generate(&f.env);
    let far_over_the_limits = f.per_day * 10;
    f.fund(far_over_the_limits);

    let result = f.withdraw_as_principal(&destination, far_over_the_limits);

    assert_eq!(result, Ok(Ok(())));
    assert_eq!(f.balance_of(&destination), far_over_the_limits);
    assert_eq!(f.spent_today(), 0, "a withdrawal is not a spend against the day's budget");
}

#[test]
fn a_withdrawal_still_works_after_valid_until_has_passed() {
    // Refusing here would recreate `G9` on a timer: an expired rail is
    // exactly the one whose balance most needs a way out.
    let f = Fixture::setup();
    let destination = Address::generate(&f.env);
    f.fund(100_0000000);
    f.env.ledger().set_timestamp(f.valid_until + 1);

    // The delegated key can no longer spend a stroop …
    assert_eq!(f.authorise(&destination, 1, 1), Err(Ok(Error::Expired)));
    // … and the principal can still take everything back.
    assert_eq!(f.withdraw_as_principal(&destination, 100_0000000), Ok(Ok(())));
    assert_eq!(f.balance_of(&destination), 100_0000000);
}

#[test]
fn a_withdrawal_without_the_principal_s_authorisation_is_refused() {
    // No mocked auth at all: `require_auth()` fails and the host aborts the
    // whole invocation before anything moves. Not one of `Error`'s own
    // variants — an auth failure never reaches contract code — so it surfaces
    // as `InvokeError::Abort`, exactly like the tampered-signature case above.
    let f = Fixture::setup();
    let destination = Address::generate(&f.env);
    f.fund(100_0000000);

    let result = f.client().try_withdraw(&destination, &10_0000000);

    assert_eq!(result, Err(Err(InvokeError::Abort)));
    assert_eq!(f.balance_of(&destination), 0);
    assert_eq!(f.balance_of(&f.contract_id), 100_0000000);
}

#[test]
fn a_withdrawal_authorised_by_someone_other_than_the_principal_is_refused() {
    // A genuine authorisation — from the wrong address. Holding the agent's
    // delegated key, or any key at all, is not holding the principal's wallet.
    let f = Fixture::setup();
    let destination = Address::generate(&f.env);
    let stranger = Address::generate(&f.env);
    f.fund(100_0000000);

    let result = f
        .client()
        .mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &f.contract_id,
                fn_name: "withdraw",
                args: (destination.clone(), 10_0000000i128).into_val(&f.env),
                sub_invokes: &[],
            },
        }])
        .try_withdraw(&destination, &10_0000000);

    assert_eq!(result, Err(Err(InvokeError::Abort)), "only the principal may withdraw");
    assert_eq!(f.balance_of(&f.contract_id), 100_0000000);
}

#[test]
fn a_withdrawal_of_zero_or_less_is_refused_by_the_contract_itself() {
    let f = Fixture::setup();
    let destination = Address::generate(&f.env);
    f.fund(100_0000000);

    assert_eq!(
        f.withdraw_as_principal(&destination, 0),
        Err(Ok(Error::InvalidWithdrawAmount))
    );
    assert_eq!(
        f.withdraw_as_principal(&destination, -1),
        Err(Ok(Error::InvalidWithdrawAmount))
    );
    assert_eq!(f.balance_of(&f.contract_id), 100_0000000);
}

// -------------------------------------------- set_owner, gated by the principal

#[test]
fn the_principal_can_rotate_the_spending_key() {
    // Not just "the reader reports a different value": the new key actually
    // authorises a payment and the old one actually stops being able to.
    let f = Fixture::setup();
    let destination = Address::generate(&f.env);
    let replacement_key = generate_key();
    let replacement = public_key_bytes(&f.env, &replacement_key);
    assert_eq!(f.authorise(&destination, 10_0000000, 1), Ok(()));

    let result = f.set_owner_as_principal(&replacement);

    assert_eq!(result, Ok(Ok(())));
    assert_eq!(f.client().owner(), replacement);
    assert_eq!(
        f.authorise_with(&replacement_key, &destination, 10_0000000, 2),
        Ok(()),
        "the new key must be able to authorise"
    );
    assert_eq!(
        f.authorise(&destination, 10_0000000, 3),
        Err(Ok(Error::UnknownSigner)),
        "the old key must no longer be able to authorise"
    );
}

#[test]
fn rotating_the_spending_key_leaves_the_rest_of_the_configuration_alone() {
    let f = Fixture::setup();
    let replacement = public_key_bytes(&f.env, &generate_key());

    assert_eq!(f.set_owner_as_principal(&replacement), Ok(Ok(())));

    let client = f.client();
    assert_eq!(client.principal(), f.principal);
    assert_eq!(client.asset(), f.asset);
    assert_eq!(client.per_tx(), f.per_tx);
    assert_eq!(client.per_day(), f.per_day);
    assert_eq!(client.valid_until(), f.valid_until);
}

#[test]
fn rotating_the_spending_key_works_after_valid_until_has_passed() {
    let f = Fixture::setup();
    let replacement = public_key_bytes(&f.env, &generate_key());
    f.env.ledger().set_timestamp(f.valid_until + 1);

    assert_eq!(f.set_owner_as_principal(&replacement), Ok(Ok(())));
    assert_eq!(f.client().owner(), replacement);
}

#[test]
fn rotating_the_spending_key_without_the_principal_s_authorisation_is_refused() {
    let f = Fixture::setup();
    let replacement = public_key_bytes(&f.env, &generate_key());

    let result = f.client().try_set_owner(&replacement);

    assert_eq!(result, Err(Err(InvokeError::Abort)));
    assert_eq!(f.client().owner(), f.owner, "the owner must be untouched");
}

#[test]
fn the_owner_cannot_rotate_itself_by_authorising_as_someone_else() {
    // The agent's own address, authorising `set_owner` — refused. The two
    // authorities are separate on purpose: whoever spends day to day must not
    // be able to lock the principal out by pointing `owner` at a key of their
    // own choosing.
    let f = Fixture::setup();
    let the_agent = Address::generate(&f.env);
    let replacement = public_key_bytes(&f.env, &generate_key());

    let result = f
        .client()
        .mock_auths(&[MockAuth {
            address: &the_agent,
            invoke: &MockAuthInvoke {
                contract: &f.contract_id,
                fn_name: "set_owner",
                args: (replacement.clone(),).into_val(&f.env),
                sub_invokes: &[],
            },
        }])
        .try_set_owner(&replacement);

    assert_eq!(
        result,
        Err(Err(InvokeError::Abort)),
        "only the principal may rotate the spending key"
    );
    assert_eq!(f.client().owner(), f.owner);
}

// ------------------------------------------- one rail per person (T186, `Y-4`)

/// A second person's rail on the same asset, in the same ledger: its own owner key and its own principal.
fn second_rail(f: &Fixture, owner_key: &SigningKey) -> (Address, Address) {
    let principal = Address::generate(&f.env);
    let rail = f.env.register(
        PolicyRail,
        (
            public_key_bytes(&f.env, owner_key),
            principal.clone(),
            f.asset.clone(),
            f.per_tx,
            f.per_day,
            f.valid_until,
        ),
    );
    f.env.mock_all_auths();
    StellarAssetClient::new(&f.env, &f.asset).mint(&rail, &300_0000000);
    f.env.set_auths(&[]);
    (rail, principal)
}

/// `asset.transfer(from, to, amount)` as an auth context, with `from` any rail.
fn transfer_from(f: &Fixture, from: &Address, to: &Address, amount: i128) -> Vec<Context> {
    let args: Vec<Val> = vec![&f.env, from.into_val(&f.env), to.into_val(&f.env), amount.into_val(&f.env)];
    vec![
        &f.env,
        Context::Contract(ContractContext { contract: f.asset.clone(), fn_name: symbol_short!("transfer"), args }),
    ]
}

#[test]
fn one_person_s_agent_key_cannot_spend_from_another_person_s_rail() {
    // Two people, two rails on the same USDC, each owned by its own derived agent key. Person A's key, signing a
    // genuine authorisation, is a stranger to B's rail: B's money does not move on A's word, whatever A asks for.
    let f = Fixture::setup();
    f.fund(300_0000000);
    let b_key = generate_key();
    let (b_rail, _) = second_rail(&f, &b_key);
    let to = Address::generate(&f.env);
    let payload = payload_bytes(&f.env, 7);
    let a_signature = f.signature_val(&payload); // A's owner key, a real signature over the payload

    let on_b = f.env.try_invoke_contract_check_auth::<Error>(&b_rail, &payload, a_signature, &transfer_from(&f, &b_rail, &to, 10_0000000));

    assert_eq!(on_b, Err(Ok(Error::UnknownSigner)));
    assert_eq!(f.balance_of(&b_rail), 300_0000000);
}

#[test]
fn a_person_s_own_rail_will_not_approve_moving_another_person_s_funds() {
    // The other way round: A's rail, with A's own valid signature, asked to approve a transfer whose source is B's
    // rail. A rail only ever approves moving its own balance, so A cannot borrow B's money through A's own account.
    let f = Fixture::setup();
    let (b_rail, _) = second_rail(&f, &generate_key());
    let to = Address::generate(&f.env);
    let payload = payload_bytes(&f.env, 8);
    let a_signature = f.signature_val(&payload);

    let on_a = f.check_auth(&payload, a_signature, transfer_from(&f, &b_rail, &to, 10_0000000));

    assert_eq!(on_a, Err(Ok(Error::UnexpectedInvocation)));
    assert_eq!(f.balance_of(&b_rail), 300_0000000);
    assert_eq!(f.spent_today(), 0, "a refused approval spends nothing from A's own day either");
}

#[test]
fn each_person_s_limits_are_counted_on_their_own_rail() {
    // A spends up to A's daily limit; B's day is untouched and B can still spend. One person's purchases never use
    // up another's allowance.
    let f = Fixture::with_limits(100_0000000, 100_0000000);
    f.fund(300_0000000);
    let b_key = generate_key();
    let (b_rail, _) = second_rail(&f, &b_key);
    let to = Address::generate(&f.env);

    assert_eq!(f.authorise(&to, 100_0000000, 1), Ok(()));
    assert_eq!(f.authorise(&to, 1, 2), Err(Ok(Error::PerDayExceeded)));

    let payload = payload_bytes(&f.env, 3);
    let b_signature = BytesN::from_array(&f.env, &b_key.sign(&payload.to_array()).to_bytes());
    let b_sig_val = f.signature_val_from(&public_key_bytes(&f.env, &b_key), &b_signature);
    let on_b = f.env.try_invoke_contract_check_auth::<Error>(&b_rail, &payload, b_sig_val, &transfer_from(&f, &b_rail, &to, 100_0000000));
    assert_eq!(on_b, Ok(()));
}
