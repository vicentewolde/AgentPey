/**
 * The principal's Mandate, exported as AP2 v0.2 open mandates — T123.
 *
 * AgentPey signs these as AP2's "Trusted Agent Provider" (`E-8`): a wallet
 * signs SEP-53, not JWS, so the principal cannot sign an AP2 mandate
 * themselves, and AP2 lets the agent's provider do it on the condition that it
 * "MUST ensure that mandates are not created without explicit user consent
 * from trusted, deterministic channels". This function is that channel, and
 * it issues nothing the principal's own Mandate does not already allow:
 *
 * 1. the Mandate is verified, on chain — signature, window, anchored and not
 *    revoked — through the same `MandateVerifier` the agent uses to buy;
 * 2. the purchase intent is verified, offline, against the agent's own key;
 * 3. `checkMandate` (unchanged) must allow that intent under that Mandate.
 *
 * Only then is a pair issued, for that purchase alone (`E-11`). What the pair
 * says is a narrower restatement of the Mandate: the intent's item and venue,
 * the Mandate's `perTx` as the amount ceiling, and an expiry of at most an
 * hour (`E-10`) because nothing can revoke an AP2 mandate once it is out.
 * `perDay` is not carried (`E-10`); the `policy_rail` keeps enforcing it on
 * chain. Nothing here touches `checkMandate`, `scope.limits` or `perDay`.
 */
import { AgentPassError, didToPublicJWK, stellarAddressToDid, stellarKeypairToJWK } from "@agentpass/core";
import type { StellarNetwork } from "@agentpass/core";
import { issueOpenMandatePair } from "@agentpey/ap2";
import type { Ap2PublicJwk, Ap2Signer, OpenMandatePair } from "@agentpey/ap2";
import type { Keypair } from "@stellar/stellar-sdk/base";

import { parseAssetId } from "../catalog/ids.js";
import { verifyIntent } from "../intent/sign.js";
import type { PurchaseIntent } from "../intent/intent.js";
import { checkMandate, mandateCheckError } from "../mandate/check-mandate.js";
import type { MandateSource, MandateVerifier, VerifiedOwnMandate } from "../mandate/verifier.js";
import { toScaledAmount } from "../scope/amount.js";

/** The longest an exported AP2 mandate lives (`E-10`). */
export const AP2_EXPORT_MAX_TTL_SECONDS = 3600;

/** The payment instrument type AgentPey's UCP handler uses (`com.agentpey.stellar_x402`, T120). */
export const AP2_STELLAR_X402_INSTRUMENT = "stellar_x402";

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

export interface ExportMandateAsAp2Input {
  /** The principal's Mandate: a JWS, or a wallet-signed pair. */
  readonly mandate: MandateSource;
  /** The agent-signed purchase intent this export is for. */
  readonly intentJws: string;
  /** The merchant as AP2 shows it. Its `id` is the intent's venue; only the name and website come from here. */
  readonly merchant: { readonly name: string; readonly website?: string };
  /** The product's display title. Its id is the intent's `productId`. */
  readonly itemTitle: string;
  readonly issuer: Ap2Issuer;
  /**
   * The key the agent will close the mandates with (`cnf`). Defaults to the
   * intent's own `did:stellar` key. Overridden by the P-256 cross-check
   * (`E-9`): the AP2 reference SDK verifies an Ed25519 `cnf` in an open
   * mandate, but follows only a P-256 one when the agent closes it.
   */
  readonly agentKey?: Ap2PublicJwk;
  readonly now?: Date;
  readonly ttlSeconds?: number;
}

export interface ExportedAp2Mandates extends OpenMandatePair {
  readonly mandate: VerifiedOwnMandate;
  readonly intent: PurchaseIntent;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

/**
 * @throws AgentPassError whatever `verifier.verify` throws for the Mandate (`MandateRevoked`, `MandateExpired`, …)
 * @throws AgentPassError whatever `verifyIntent` throws (`InvalidIntent`, `IntentExpired`, …)
 * @throws AgentPassError the `MandateDenied` code of `checkMandate` (`MandateVenueNotAllowed`, `MandateAmountExceeded`, …)
 * @throws AgentPassError `Ap2MandateInvalid` if the result could not be a valid AP2 mandate
 */
export async function exportMandateAsAp2(verifier: MandateVerifier, input: ExportMandateAsAp2Input): Promise<ExportedAp2Mandates> {
  const now = input.now ?? new Date();
  const ttl = input.ttlSeconds ?? AP2_EXPORT_MAX_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > AP2_EXPORT_MAX_TTL_SECONDS) {
    throw new AgentPassError("InvalidArguments", `an AP2 export lives between 1 and ${AP2_EXPORT_MAX_TTL_SECONDS} seconds`, { details: { ttlSeconds: ttl } });
  }

  const mandate = await verifier.verify(input.mandate, { now });
  const { intent } = await verifyIntent(input.intentJws, { now });

  const decision = checkMandate(mandate.mandate, intent);
  if (!decision.allowed) throw mandateCheckError(decision);

  const { grant } = mandate.mandate.credentialSubject;
  const expiresAt = new Date(Math.min(now.getTime() + ttl * 1000, Date.parse(mandate.mandate.validUntil)));
  const asset = parseAssetId(intent.purchase.asset);

  const pair = await issueOpenMandatePair(
    {
      issuer: input.issuer.did,
      source: { mandate_id: mandate.mandate.mandateId, hash: mandate.hash, registry: mandate.mandate.credentialStatus.registry },
      agentKey: input.agentKey ?? didToPublicJWK(intent.agent),
      merchant: { ...input.merchant, id: intent.venue },
      item: { id: intent.purchase.productId, title: input.itemTitle },
      quantity: intent.purchase.quantity,
      maxAmount: toScaledAmount(grant.limits.perTx),
      currency: grant.limits.currency,
      paymentInstrument: { id: intent.purchase.asset, type: AP2_STELLAR_X402_INSTRUMENT, description: `${asset.code} on Stellar, paid with x402 (exact)` },
      issuedAt: now,
      expiresAt,
    },
    input.issuer.signer,
  );

  return { ...pair, mandate, intent, issuedAt: now, expiresAt };
}
