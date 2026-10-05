/**
 * The principal's Mandate, exported as AP2 v0.2 open mandates — T123.
 *
 * AgentPey signs these as AP2's "Trusted Agent Provider" (`E-8`): a wallet
 * signs SEP-53, not JWS, so the principal cannot sign an AP2 mandate
 * themselves, and AP2 lets the agent's provider do it on the condition that it
 * "MUST ensure that mandates are not created without explicit user consent
 * from trusted, deterministic channels". This function is that channel, and
 * it issues nothing the two authorities behind the agent do not already allow
 * (`M-4`: the issuer's credential and the principal's Mandate, both of which
 * must allow, neither able to widen the other):
 *
 * 1. the credential is verified on chain — signature, window, anchored, not
 *    revoked — so cutting the agent off from outside also stops the export;
 * 2. the Mandate is verified on chain the same way;
 * 3. the purchase intent is verified against the agent's own key, and must
 *    name that credential, that agent and that principal;
 * 4. `checkScope` and `checkMandate` (both unchanged) must allow it.
 *
 * Only then is a pair issued, for that purchase alone (`E-11`), as a narrower
 * restatement of both: the intent's item and venue; as the amount ceiling the
 * smallest of the four limits (`perTx` and `perDay`, credential and Mandate),
 * in cents and rounded down (`E-12`); and an expiry no later than the intent's,
 * the credential's, the Mandate's, or an hour from now (`E-10`), because
 * nothing can revoke an AP2 mandate once it is out. `perDay` is not carried as
 * a constraint (`E-10`); the `policy_rail` keeps enforcing it on chain.
 * Nothing here changes `checkScope`, `checkMandate`, `scope.limits` or `perDay`.
 *
 * Not enforced here: one pair per intent. The same intent can be exported
 * again until it expires; each pair is bounded by the same ceiling and window
 * (SEP annex, gap 14).
 */
import { AgentPassError, didToPublicJWK, stellarAddressToDid, stellarKeypairToJWK } from "@agentpass/core";
import type { StellarNetwork } from "@agentpass/core";
import { issueOpenMandatePair } from "@agentpey/ap2";
import type { Ap2PublicJwk, Ap2Signer, OpenMandatePair } from "@agentpey/ap2";
import type { Keypair } from "@stellar/stellar-sdk/base";
import { z } from "zod";

import { parseAssetId } from "../catalog/ids.js";
import type { CredentialVerifier, VerifiedOwnCredential } from "../credential/verifier.js";
import { verifyIntent } from "../intent/sign.js";
import type { PurchaseIntent } from "../intent/intent.js";
import { checkMandate, mandateCheckError } from "../mandate/check-mandate.js";
import type { MandateSource, MandateVerifier, VerifiedOwnMandate } from "../mandate/verifier.js";
import { toScaledAmount } from "../scope/amount.js";
import { checkScope } from "../scope/scope.js";

/** The longest an exported AP2 mandate lives (`E-10`). */
export const AP2_EXPORT_MAX_TTL_SECONDS = 3600;

/** The payment instrument type AgentPey's UCP handler uses (`com.agentpey.stellar_x402`, T120). */
export const AP2_STELLAR_X402_INSTRUMENT = "stellar_x402";

/** Seven-decimal Stellar units per AP2 minor unit (cents, `E-12`). */
const STELLAR_UNITS_PER_CENT = 100_000n;

export interface Ap2Issuer {
  /** `iss` of the mandates. */
  readonly did: string;
  readonly signer: Ap2Signer;
  /** What a verifier must be told to trust. */
  readonly publicJwk: Ap2PublicJwk;
}

/**
 * The real export's issuer: a Stellar key this codebase already holds, signing
 * EdDSA, `kid` = its `did:stellar` (`E-9`: no new key).
 */
export function stellarAp2Issuer(keypair: Keypair, network: StellarNetwork): Ap2Issuer {
  const did = stellarAddressToDid(keypair.publicKey(), network);
  const { x, d } = stellarKeypairToJWK(keypair);
  return { did, signer: { alg: "EdDSA", privateJwk: { kty: "OKP", crv: "Ed25519", x, d }, kid: did }, publicJwk: { kty: "OKP", crv: "Ed25519", x } };
}

/** The two on-chain checks the export needs. `AgentPass` and `createOnChainMandateVerifier` satisfy them. */
export interface Ap2ExportVerifiers {
  readonly credentials: CredentialVerifier;
  readonly mandates: MandateVerifier;
}

/**
 * The display text that ends up inside a document AgentPey signs. It comes
 * from a venue's catalogue (third-party text), so it is bounded here: AgentPey
 * restates it, it does not vouch for it.
 */
const displaySchema = z.strictObject({
  merchant: z.strictObject({ name: z.string().trim().min(1).max(120), website: z.url().max(200).optional() }),
  itemTitle: z.string().trim().min(1).max(200),
});

export interface ExportMandateAsAp2Input {
  /** The agent's AgentPass credential, a JWS. */
  readonly credential: string;
  /** The principal's Mandate: a JWS, or a wallet-signed pair. */
  readonly mandate: MandateSource;
  /** The agent-signed purchase intent this export is for. */
  readonly intentJws: string;
  /** The merchant as AP2 shows it. Its `id` is the intent's venue; only the name and website come from here. */
  readonly merchant: { readonly name: string; readonly website?: string };
  /** The product's display title. Its id is the intent's `productId`. */
  readonly itemTitle: string;
  readonly issuer: Ap2Issuer;
  readonly now?: Date;
  readonly ttlSeconds?: number;
}

export interface ExportedAp2Mandates extends OpenMandatePair {
  readonly credential: VerifiedOwnCredential;
  readonly mandate: VerifiedOwnMandate;
  readonly intent: PurchaseIntent;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

function intentMismatch(message: string, details: Readonly<Record<string, unknown>>): AgentPassError {
  return new AgentPassError("InvalidIntent", message, { details });
}

/**
 * The real export: `cnf` is the intent's own `did:stellar` key, the one the
 * credential and the Mandate name. No caller can bind the pair to another key.
 *
 * @throws AgentPassError whatever the credential check throws (`CredentialRevoked`, `CredentialExpired`, …)
 * @throws AgentPassError whatever the Mandate check throws (`MandateRevoked`, `MandateExpired`, …)
 * @throws AgentPassError whatever `verifyIntent` throws (`InvalidIntent`, `IntentExpired`, …)
 * @throws AgentPassError `InvalidIntent` if the intent names another credential, agent or principal
 * @throws AgentPassError the code of `checkScope` or `checkMandate` (`ScopeVenueNotAllowed`, `MandateAmountExceeded`, …)
 * @throws AgentPassError `InvalidArguments` for display text out of bounds or a bad lifetime
 * @throws AgentPassError `Ap2MandateInvalid` if the limits leave nothing representable, or the result could not be a valid AP2 mandate
 */
export async function exportMandateAsAp2(verifiers: Ap2ExportVerifiers, input: ExportMandateAsAp2Input): Promise<ExportedAp2Mandates> {
  return exportPair(verifiers, input, undefined);
}

/**
 * Shared by {@link exportMandateAsAp2} and the cross-check variant
 * (`cross-check.ts`), which alone may bind `cnf` to a key other than the
 * intent's own. Not exported from the package index.
 */
export async function exportPair(verifiers: Ap2ExportVerifiers, input: ExportMandateAsAp2Input, agentKeyOverride: Ap2PublicJwk | undefined): Promise<ExportedAp2Mandates> {
  const now = input.now ?? new Date();
  const ttl = input.ttlSeconds ?? AP2_EXPORT_MAX_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > AP2_EXPORT_MAX_TTL_SECONDS) {
    throw new AgentPassError("InvalidArguments", `an AP2 export lives between 1 and ${AP2_EXPORT_MAX_TTL_SECONDS} seconds`, { details: { ttlSeconds: ttl } });
  }
  const display = displaySchema.safeParse({ merchant: input.merchant, itemTitle: input.itemTitle });
  if (!display.success) {
    throw new AgentPassError("InvalidArguments", "the merchant name, website or item title is out of bounds", { details: { issues: display.error.issues } });
  }

  const credential = await verifiers.credentials.verify(input.credential, { now });
  const mandate = await verifiers.mandates.verify(input.mandate, { now });
  const { intent } = await verifyIntent(input.intentJws, { now });

  // The intent must be this agent's, under this credential, for this principal.
  if (intent.credential.hash !== credential.hash || intent.credential.registry !== credential.credential.credentialStatus.registry) {
    throw intentMismatch("the intent names a different credential than the one given", { intent: intent.credential, credential: credential.hash });
  }
  if (intent.agent !== credential.subject) {
    throw intentMismatch("the intent's agent is not the credential's subject", { agent: intent.agent, subject: credential.subject });
  }
  if (intent.principal !== credential.credential.credentialSubject.principal) {
    throw intentMismatch("the intent's principal is not the credential's principal", { principal: intent.principal });
  }

  // The export names one item and one display title (T123); a cart (T148) closes its own mandate in the UCP checkout.
  const purchase = intent.purchase;
  if ("lines" in purchase) {
    throw new AgentPassError("Ap2MandateInvalid", "ap2:export exports one product; a cart's AP2 mandate is closed in the UCP checkout (T134, T148)", { details: { lines: purchase.lines.length } });
  }

  // Both authorities must allow (M-4); neither function is changed here.
  const { scope } = credential.credential.credentialSubject;
  const scoped = checkScope(scope, { venue: intent.venue, asset: intent.purchase.asset, unitAmount: purchase.unitAmount, quantity: purchase.quantity });
  if (!scoped.allowed) throw new AgentPassError(scoped.code, scoped.reason, { details: scoped.details });
  const decision = checkMandate(mandate.mandate, intent);
  if (!decision.allowed) throw mandateCheckError(decision);

  const { grant } = mandate.mandate.credentialSubject;
  const ceiling = [scope.limits.perTx, scope.limits.perDay, grant.limits.perTx, grant.limits.perDay].map(toScaledAmount).reduce((a, b) => (b < a ? b : a));
  const maxCents = ceiling / STELLAR_UNITS_PER_CENT; // bigint division rounds down: never wider (E-12)
  if (maxCents <= 0n) {
    throw new AgentPassError("Ap2MandateInvalid", "the limits allow less than one cent, so there is nothing an AP2 mandate could permit", {
      details: { perTx: [scope.limits.perTx, grant.limits.perTx], perDay: [scope.limits.perDay, grant.limits.perDay] },
    });
  }

  const expiresAt = new Date(
    Math.min(now.getTime() + ttl * 1000, Date.parse(intent.expiresAt), Date.parse(credential.credential.validUntil), Date.parse(mandate.mandate.validUntil)),
  );
  const asset = parseAssetId(intent.purchase.asset);

  const pair = await issueOpenMandatePair(
    {
      issuer: input.issuer.did,
      source: { mandate_id: mandate.mandate.mandateId, hash: mandate.hash, registry: mandate.mandate.credentialStatus.registry },
      agentKey: agentKeyOverride ?? didToPublicJWK(intent.agent),
      merchant: { ...display.data.merchant, id: intent.venue },
      item: { id: purchase.productId, title: display.data.itemTitle },
      quantity: purchase.quantity,
      maxAmount: maxCents,
      currency: grant.limits.currency,
      paymentInstrument: { id: intent.purchase.asset, type: AP2_STELLAR_X402_INSTRUMENT, description: `${asset.code} on Stellar, paid with x402 (exact)` },
      issuedAt: now,
      expiresAt,
    },
    input.issuer.signer,
  );

  return { ...pair, credential, mandate, intent, issuedAt: now, expiresAt };
}
