"""Cross-check for T123: verify AgentPey's exported AP2 mandates with the AP2 reference SDK.

Reads a directory written by `pnpm run ap2:export` (checkout.sd-jwt,
payment.sd-jwt, issuer.jwk.json) and verifies both mandates with
`ap2.sdk.mandate.MandateClient`, as AP2's own code does it: issuer signature,
disclosures, and the typed model of each open mandate. Then checks that
`payment.reference` is the SDK's own `sd_hash` of the checkout mandate.

Usage (from the repo root, in a virtualenv with requirements.txt installed):

    python scripts/ap2-crosscheck/verify.py .vitrinee/ap2
    python scripts/ap2-crosscheck/verify.py .vitrinee/ap2/p256

The first is the real export (EdDSA, Stellar keys); the second the same
Mandate and intent signed with single-use P-256 keys (E-9). The SDK verifies
open mandates with either. Where it does insist on P-256 is one step later,
outside T123: following `cnf` to verify the agent's closing hop
(`ap2/sdk/sdjwt/kb_sd_jwt.py`, `JsonWebKey` allows EC P-256 only).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from ap2.sdk.generated.open_checkout_mandate import OpenCheckoutMandate
from ap2.sdk.generated.open_payment_mandate import OpenPaymentMandate, PaymentReference
from ap2.sdk.mandate import MandateClient
from ap2.sdk.sdjwt.common import compute_sd_hash, parse_token
from jwcrypto.jwk import JWK


def main() -> int:
    args = sys.argv[1:]
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
