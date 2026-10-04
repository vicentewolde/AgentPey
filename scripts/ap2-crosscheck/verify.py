"""Cross-check for T123: verify AgentPey's exported AP2 mandates with the AP2 reference SDK.

Reads a directory written by `pnpm run ap2:export` (checkout.sd-jwt,
payment.sd-jwt, issuer.jwk.json) and verifies both mandates with
`ap2.sdk.mandate.MandateClient`, as AP2's own code does it: issuer signature,
disclosures, and the typed model of each open mandate. Then checks that
`payment.reference` is the SDK's own `sd_hash` of the checkout mandate.

Usage (from the repo root, in a virtualenv with requirements.txt installed):

    python scripts/ap2-crosscheck/verify.py .vitrinee/ap2
    python scripts/ap2-crosscheck/verify.py .vitrinee/ap2/p256
    python scripts/ap2-crosscheck/verify.py --closed .vitrinee/ap2-t134

The first is the real export (EdDSA, Stellar keys); the second the same
Mandate and intent signed with single-use P-256 keys (E-9). The SDK verifies
open mandates with either. Where it does insist on P-256 is one step later,
outside T123: following `cnf` to verify the agent's closing hop
(`ap2/sdk/sdjwt/kb_sd_jwt.py`, `JsonWebKey` allows EC P-256 only).
"""

from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

from ap2.sdk.generated.open_checkout_mandate import OpenCheckoutMandate
from ap2.sdk.generated.open_payment_mandate import OpenPaymentMandate, PaymentReference
from ap2.sdk.mandate import MandateClient
from ap2.sdk.sdjwt.common import compute_sd_hash, parse_token
from jwcrypto.jwk import JWK


def verify_closed(folder: Path) -> int:
    """T134: a closed checkout mandate from a UCP checkout (open~~close, R-15).

    Reads what `pnpm run ucp:buy -- --ucp-version 2026-08-25 --ap2` writes:
    chain.txt and binding.json (aud, nonce, and the two profiles the keys are
    published in). With profile URLs in binding.json, the keys are fetched
    from there, as any third party would: the platform's from its profile,
    the store's from its `/.well-known/ucp`, each by its `kid`. Without them
    (the offline sample), platform.jwk.json and business.jwk.json are read.
    Verifies the chain as AP2's own code does, evaluates the open mandate's
    constraints against the checkout the store signed, and checks that
    signature with the store's key.
    """
    from ap2.sdk.checkout_mandate_chain import CheckoutMandateChain
    from ap2.sdk.jwt_helper import verify_jwt

    chain = (folder / "chain.txt").read_text().strip()
    binding = json.loads((folder / "binding.json").read_text())
    if "platform_profile" in binding and "store_profile" in binding:
        platform = JWK(**published_key(binding["platform_profile"], binding["platform_kid"]))
        business = JWK(**published_key(binding["store_profile"], binding["store_kid"]))
        source = "published profiles"
    else:
        platform = JWK(**json.loads((folder / "platform.jwk.json").read_text()))
        business = JWK(**json.loads((folder / "business.jwk.json").read_text()))
        source = "local files (sample)"

    print(f"AP2 reference SDK · closed checkout mandate · {folder}")
    print(f"  keys from      {source}")
    print(f"  aud            {binding['aud']}")
    print(f"  nonce          {binding['nonce']}")
    try:
        payloads = MandateClient().verify(chain, lambda _token: platform, expected_aud=binding["aud"], expected_nonce=binding["nonce"])
    except Exception as error:  # noqa: BLE001 — report whatever the SDK raises
        print(f"  FAILED         {type(error).__name__}: {error}")
        return 1
    print(f"  chain          {len(payloads)} hops: {[p.get('vct') for p in payloads]}")
    closed = payloads[-1]
    violations = CheckoutMandateChain.parse(payloads).verify(expected_checkout_hash=closed["checkout_hash"], checkout_jwt=closed["checkout_jwt"])
    if violations:
        print(f"  FAILED         constraint violations: {violations}")
        return 1
    print("  constraints    none violated (line items, allowed merchants)")
    if verify_jwt(closed["checkout_jwt"], business) is None:
        print("  FAILED         checkout_jwt is not signed by the store's key")
        return 1
    print(f"  checkout_jwt   signed by the store key {business.get('kid')}")
    print("\nOK: the AP2 reference SDK verifies the closed mandate.")
    return 0


def published_key(profile_url: str, kid: str) -> dict:
    """The public key `kid` from the `keys` of a UCP profile, fetched over HTTPS."""
    if not profile_url.startswith("https://"):
        raise SystemExit(f"refusing a non-https profile URL: {profile_url}")
    with urllib.request.urlopen(profile_url, timeout=10) as response:  # noqa: S310 — https only, checked above
        profile = json.loads(response.read(256 * 1024))
    for key in profile.get("keys", []):
        if key.get("kid") == kid:
            return {name: key[name] for name in ("kty", "crv", "x", "y", "kid") if name in key}
    raise SystemExit(f"{profile_url} publishes no key {kid}")


def main() -> int:
    args = sys.argv[1:]
    if len(args) == 2 and args[0] == "--closed":
        return verify_closed(Path(args[1]))
    if len(args) != 1:
        print(__doc__)
        return 2
    folder = Path(args[0])
    checkout = (folder / "checkout.sd-jwt").read_text().strip()
    payment = (folder / "payment.sd-jwt").read_text().strip()
    issuer_jwk = json.loads((folder / "issuer.jwk.json").read_text())

    print(f"AP2 reference SDK · {folder}")
    print(f"  issuer key     {issuer_jwk['kty']} {issuer_jwk.get('crv')}")

    client = MandateClient()
    try:
        key = JWK(**issuer_jwk)
        checkout_mandate = client.verify(checkout, key, payload_type=OpenCheckoutMandate)
        payment_mandate = client.verify(payment, key, payload_type=OpenPaymentMandate)
    except Exception as error:  # noqa: BLE001 — the point is to report whatever the SDK raises
        print(f"  FAILED         {type(error).__name__}: {error}")
        return 1

    opened_checkout = checkout_mandate.mandate_payload
    opened_payment = payment_mandate.mandate_payload
    print(f"  checkout       {opened_checkout.vct}, {len(opened_checkout.constraints)} constraints, typed by OpenCheckoutMandate")
    print(f"  payment        {opened_payment.vct}, {len(opened_payment.constraints)} constraints, typed by OpenPaymentMandate")

    open_checkout_hash = compute_sd_hash(parse_token(checkout))
    references = [c.conditional_transaction_id for c in opened_payment.constraints if isinstance(c, PaymentReference)]
    if references != [open_checkout_hash]:
        print(f"  FAILED         payment.reference {references} != sd_hash {open_checkout_hash}")
        return 1
    print(f"  reference      payment.reference == SDK sd_hash of the checkout mandate ({open_checkout_hash[:16]}…)")

    print("\nOK: the AP2 reference SDK verifies both mandates.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
