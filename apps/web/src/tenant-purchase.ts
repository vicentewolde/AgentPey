/**
 * One purchase, for one tenant, with no browser session anywhere in sight.
 *
 * **What this replaces, and why it had to move.** Until T74 the only code in
 * this repo that could execute a purchase was `buy()` in `server.ts`: it took
 * a `DemoSession` held in memory behind a cookie, and it could buy exactly
 * one product (`PAYABLE_PRODUCT_ID`, a fixed bazaar item) at one URL with
 * three hardcoded route parameters. Every authorisation layer F9 needs was
 * already there and already correct — what was missing was any way to reach
 * them without being a browser holding that cookie.
 *
 * So this module moves the *reaching*, and deliberately moves nothing else.
 * The decision layers are called in the same order, by the same functions,
 * with the same arguments they have had since T21:
 *
 *   create_purchase_intent  →  checkScope + checkMandate + perDay (PolicyRail)
 *   402 challenge           →  reconcileTerms (price, asset, payTo)
 *   pay                     →  PolicyRail again, then the contract's own limits
 *
 * Nothing here decides anything. If a line in this file ever looks like it is
 * making an authorisation decision, that is the bug.
 *
 * **Fail-closed by construction, restated for this path.** `createAgent`
 * withholds `create_purchase_intent` entirely unless both the credential and
 * the mandate verified (T11/T21). This module therefore cannot pay for
 * something whose documents did not check out — not because it remembers to
 * ask, but because the tool it would have to call does not exist on an agent
 * that failed either check.
 *
 * **What it refuses to believe.** The caller (a partner, over `/v1`) names a
 * venue and a product. Neither is taken on faith:
 *
 * - The venue must be a row in the venue registry (`venues.json`). A venue a
 *   public catalogue advertised and the registry does not know is refused
 *   with `VenueNotRegistered` *before any network call to it is made* — a
 *   catalogue suggests candidates, it never grants permission (`C-77`).
 * - The price is never the caller's, and never the catalogue's. It is the
 *   venue's own quote, re-fetched here, and then compared against the signed
 *   Mandate by `reconcileTerms`.
 * - `maxTotal`, when the caller supplies one, can only ever refuse *earlier*
 *   than the Mandate would. It is a ceiling the partner sets on itself.
 */
import { AgentPassError, agentPassCredentialSchema, didToStellarAddress, isAgentPassError, type Scope } from "@agentpass/core";
import {
  DEFAULT_VENUE_REGISTRY,
  baseUrlForVenue,
  createAgent,
  createLocalPolicyRail,
  createOnChainMandateVerifier,
  createX402Catalog,
  executeBazaarPayment,
  fillRouteTemplate,
  getX402ServiceRoute,
  parseVenueId,
  requestPaymentChallenge,
  toScaledAmount,
  verifyIntent,
  withVault,
  type MandateSource,
  type VenueId,
  type VenueRegistry,
} from "@agentpey/agent";
import { createPostgresMandateVault } from "@agentpey/vault";
import type { AgentPass } from "@agentpass/sdk";
import type { CredentialRecord, Directory, MandateRecord } from "@agentpey/directory";
import { agentPayMandateSchema } from "@agentpey/mandate";
import { Keypair } from "@stellar/stellar-sdk";

import { ensureTenantAgent, type TenantAgentDirectory } from "./tenant-agent.js";
import { ensureTenantPolicyRail, type TenantRailDirectory } from "./tenant-rail.js";

/** What a caller asks for. Every field is a claim, none is an authorisation. */
export interface TenantPurchaseRequest {
  readonly tenantId: string;
  /** `<slug>:<contract id>` — must be a row in the venue registry. */
  readonly venue: string;
  readonly productId: string;
  readonly quantity: number;
  /** A ceiling the partner sets on itself. Can only refuse earlier, never later. */
  readonly maxTotal?: string;
  /**
   * Values for the `{name}` placeholders in the venue's paid route. A route
   * that declares a required input this does not cover is refused with
   * `RouteParamMissing` rather than fetched with a hole in the URL: a venue
   * asked for a parameter, and sending it an empty one is guessing.
   */
  readonly routeParams?: Readonly<Record<string, string | number>>;
}

export interface PurchaseSettled {
  readonly kind: "settled";
  /** The tenant's own agent row that acted — recorded with the purchase. */
  readonly agentId: string;
  readonly intentId: string;
  readonly total: string;
  readonly asset: string;
  readonly payTo: string | undefined;
  readonly transactionHash: string | undefined;
  readonly resourceUrl: string;
  /** What the venue released once it was paid. */
  readonly resource: unknown;
}

export interface PurchaseRefused {
  readonly kind: "refused";
  /** `null` when the refusal happened before this tenant's agent was resolved. */
  readonly agentId: string | null;
  /** The typed code of whichever layer said no. */
  readonly code: string;
  readonly reason: string;
  readonly details: Readonly<Record<string, unknown>>;
  /** Present when the refusal happened after an intent had been signed. */
  readonly intentId: string | undefined;
}

export type TenantPurchaseOutcome = PurchaseSettled | PurchaseRefused;

/**
 * The slice of {@link Directory} a purchase reads. Narrow on purpose, and
 * narrow in one direction: there is no write here beyond the two `ensure*`
 * helpers' own idempotent writes, which take their own narrower ports.
 */
export type TenantPurchaseDirectory = TenantAgentDirectory &
  TenantRailDirectory &
  Pick<Directory, "findLatestCredential" | "listActiveMandates" | "listMandates" | "findAgent">;

export interface TenantPurchaseDeps {
  readonly directory: TenantPurchaseDirectory;
  readonly agentpass: AgentPass;
  readonly masterMnemonic: string;
  readonly databaseUrl: string;
  /** Funds a freshly deployed rail — the sponsored testnet credit of F9 §6. */
  readonly reserve: Keypair;
  readonly policyRailWasmHash: string;
  /**
   * Reads an address's USDC — used for the reserve's pre-flight check before
   * a new rail is sponsored. Injected so this module, and the tests below it,
   * never need a network.
   */
  readonly readUsdcBalance: (address: string) => Promise<string>;
  /** Defaults to `venues.json`. Injected so a test can register its own venue. */
  readonly registry?: VenueRegistry;
  readonly now?: Date;
  /**
   * How the venue is asked for its quote — before a rail is touched, and again
   * during payment. Injected for tests; defaults to the global `fetch`.
   */
  readonly fetchImpl?: typeof fetch;
}

function refuse(
  code: string,
  reason: string,
  details: Readonly<Record<string, unknown>> = {},
  intentId?: string,
  agentId: string | null = null,
): PurchaseRefused {
  return { kind: "refused", agentId, code, reason, details, intentId };
}

/**
 * Turns anything thrown by a decision layer into a refusal, and lets
 * everything else keep throwing.
 *
 * The distinction matters more than it looks: "your Mandate does not permit
 * this" and "Postgres is unreachable" must not arrive at a caller wearing the
 * same clothes. The first is an answer; the second is an outage. Only a typed
 * `AgentPassError` becomes an answer.
 */
function asRefusal(error: unknown, intentId?: string, agentId: string | null = null): PurchaseRefused {
  if (!isAgentPassError(error)) throw error;
  return refuse(error.code, error.message, error.details ?? {}, intentId, agentId);
}

/**
 * Whether a stored Mandate names this product — read only to choose between
 * rows, never to authorise anything. A document that does not parse names
 * nothing here; if it is the row that ends up chosen, `mandateSourceFrom`
 * still refuses it, typed. A grant with no `products` is not narrowed here
 * either: whether that permits a product is `checkMandate`'s call.
 */
function namesProduct(record: MandateRecord, productId: string): boolean {
  const parsed = agentPayMandateSchema.safeParse(record.document);
  if (!parsed.success) return false;
  const products = parsed.data.credentialSubject.grant.products;
  return products === undefined || products.includes(productId);
}

/**
 * Which of this agent's active Mandates a purchase goes through.
 *
 * T85 found the first version of this — "the first active Mandate of this
 * agent" — wrong in production. A tenant has exactly one agent
 * (`ensureTenantAgent`), and RealOps signs one Mandate per product for that
 * tenant, so an account with a report agent and a credits agent bought credits
 * through the report's Mandate every time, and was refused with
 * `MandateProductNotAllowed`.
 *
 * **This chooses; it does not decide.** The newest active Mandate that names
 * the product wins. When none names it, the first active one is still handed
 * on, so `checkMandate` refuses it with its own code: this module never turns
 * "no Mandate covers that product" into a refusal of its own making.
 */
export function selectMandateFor(
  activeMandates: readonly MandateRecord[],
  agentId: string,
  productId: string,
): MandateRecord | undefined {
  const own = activeMandates.filter((row) => row.agentId === agentId);
  return [...own].reverse().find((row) => namesProduct(row, productId)) ?? own[0];
}

export interface MissingMandate {
  readonly code: "MandateRevoked" | "MandateExpired" | "MandateNotYetValid" | "MandateNotFound";
  readonly reason: string;
  readonly mandateId: string | null;
}

/**
 * Why this agent has no active Mandate, read from its own history.
 *
 * `listActiveMandates` answers "is there one", and filters revoked and expired
 * rows out to do it — so on its own this path could only ever say
 * `MandateNotFound`. That is what a person read after revoking their Mandate,
 * and again after it expired, when the suite ran against production (T85). The
 * newest of this agent's Mandates for this product — or for anything, if none
 * names it — says which of the three happened.
 *
 * @param agentMandates This agent's Mandates, any status, oldest first
 * (`listMandates` orders by id, and ids are ULIDs).
 */
export function explainMissingMandate(
  agentMandates: readonly MandateRecord[],
  productId: string,
  now: Date,
): MissingMandate {
  const forProduct = agentMandates.filter((row) => namesProduct(row, productId));
  const candidates = forProduct.length > 0 ? forProduct : agentMandates;
  const latest = candidates[candidates.length - 1];
  const notFound = "this agent has no active mandate — nothing authorises a purchase";
  if (latest === undefined) return { code: "MandateNotFound", reason: notFound, mandateId: null };
  if (latest.revokedAt !== null) {
    return { code: "MandateRevoked", reason: "the mandate that authorised this agent was revoked", mandateId: latest.id };
  }
  if (latest.validUntil.getTime() < now.getTime()) {
    return { code: "MandateExpired", reason: "the mandate that authorised this agent has expired", mandateId: latest.id };
  }
  if (latest.validFrom.getTime() > now.getTime()) {
    return { code: "MandateNotYetValid", reason: "the mandate that authorises this agent is not valid yet", mandateId: latest.id };
  }
  return { code: "MandateNotFound", reason: notFound, mandateId: latest.id };
}

/** The two startup checks `createAgent` keeps on the agent it returns. */
export type AgentDocumentStates = Pick<Awaited<ReturnType<typeof createAgent>>, "credential" | "mandate">;

/**
 * Why the agent was not given `create_purchase_intent`, when it was not.
 *
 * `createAgent` does not throw for a credential revoked on chain or a Mandate
 * that no longer verifies: it withholds the tool and keeps the reason in its
 * state. This module used to ignore that state and invoke the tool anyway, so
 * a credential the issuer had revoked reached a person as `UnknownTool` — "no
 * tool named create_purchase_intent" (T85). The tool is still withheld exactly
 * as before; this only reads out why.
 */
export function withheldBecause(agent: AgentDocumentStates): AgentPassError | undefined {
  if (!agent.credential.usable) return agent.credential.problem;
  if (agent.mandate !== undefined && !agent.mandate.usable) return agent.mandate.problem;
  return undefined;
}

/**
 * Rebuilds this tenant's Mandate from what the directory persisted, parsing
 * it back through `agentPayMandateSchema` rather than trusting the stored
 * `Record<string, unknown>`. Same reasoning `mandateFromRecord` in
 * `server.ts` already applies: the directory promises to store bytes
 * faithfully (`C-5`), not that they still describe a well-formed Mandate.
 */
function mandateSourceFrom(record: MandateRecord): MandateSource {
  const parsed = agentPayMandateSchema.safeParse(record.document);
  if (!parsed.success) {
    throw new AgentPassError("ConfigError", "this tenant's stored mandate does not match the expected shape", {
      details: { mandateHash: record.mandateHash, issues: parsed.error.issues.map((issue) => issue.message) },
    });
  }
  if (record.signatureKind === "wallet-sep53") {
    if (record.signature === null) {
      throw new AgentPassError("ConfigError", "this tenant's wallet-signed mandate is missing its signature", {
        details: { mandateHash: record.mandateHash },
      });
    }
    return { mandate: parsed.data, signature: record.signature };
  }
  if (record.jws === null) {
    throw new AgentPassError("ConfigError", "this tenant's platform-signed mandate is missing its JWS", {
      details: { mandateHash: record.mandateHash },
    });
  }
  return record.jws;
}

/**
 * The scope the agent's own credential carries, read back out of the document
 * rather than from a config file.
 *
 * `buy()` used to take this from `readScope()` — the repo's `examples/scope.json`
 * — which was fine when every session was the same demo. It is not fine per
 * tenant: the scope that governs a purchase has to be the one inside the
 * credential that was actually issued and anchored for *this* tenant, not
 * whatever a file on disk says today.
 */
function scopeFromCredential(record: CredentialRecord): Scope {
  const payload = record.jws.split(".")[1];
  if (payload === undefined) {
    throw new AgentPassError("ConfigError", "this tenant's stored credential is not a compact JWS", {
      details: { credentialHash: record.credentialHash },
    });
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch (cause) {
    throw new AgentPassError("ConfigError", "this tenant's stored credential has an unreadable payload", {
      cause,
      details: { credentialHash: record.credentialHash },
    });
  }
  // The payload *is* the credential — `verifyCredential` parses it straight
  // through `agentPassCredentialSchema`, with no `vc` wrapper. Parsed here
  // through the same schema rather than reached into: a scope is about to
  // govern what may be spent, and the project's rule is that anything
  // crossing a boundary is validated, not cast.
  const parsed = agentPassCredentialSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new AgentPassError("ConfigError", "this tenant's stored credential does not match the expected shape", {
      details: { credentialHash: record.credentialHash, issues: parsed.error.issues.map((issue) => issue.message) },
    });
  }
  return parsed.data.credentialSubject.scope;
}

/**
 * Checks the caller covered every input the venue's paid route declares as
 * required, before a URL is built from it.
 *
 * @throws AgentPassError `RouteParamMissing`
 */
function requireRouteParams(
  route: { readonly input: readonly { readonly name: string; readonly required: boolean }[] },
  supplied: Readonly<Record<string, string | number>>,
): void {
  const missing = route.input.filter((field) => field.required && supplied[field.name] === undefined).map((field) => field.name);
  if (missing.length > 0) {
    throw new AgentPassError("RouteParamMissing", "this product's paid route needs inputs this purchase did not supply", {
      details: { missing },
    });
  }
}

/**
 * Executes one purchase for one tenant, or explains why it did not happen.
 *
 * Refusals come back as a value, not an exception, because a Mandate saying
 * no is this system working. Only a genuine failure — a database down, a
 * network that never answered — is allowed to throw.
 */
export async function executeTenantPurchase(
  deps: TenantPurchaseDeps,
  request: TenantPurchaseRequest,
): Promise<TenantPurchaseOutcome> {
  const registry = deps.registry ?? DEFAULT_VENUE_REGISTRY;

  // 1. Is this a venue anyone may be paid at? Before any network call to it:
  //    an unregistered venue never even learns we were asked about it.
  let venueId: VenueId;
  try {
    venueId = parseVenueId(request.venue).venueId;
  } catch (error) {
    return asRefusal(error);
  }
  // `baseUrlForVenue` **throws** `InvalidProduct` for a venue it does not
  // hold, and returns `undefined` only for a venue registered without a base
  // URL. Both mean the same thing here — this platform cannot pay it — and
  // both have to arrive at the caller as a refusal, not as an exception: an
  // unknown venue is an answer about permission, not an outage. (The first
  // version of this function only handled the `undefined` case; the test
  // below for a registered slug paired with a foreign contract id is what
  // caught it.)
  let baseUrl: string | undefined;
  try {
    baseUrl = baseUrlForVenue(registry, venueId);
  } catch {
    baseUrl = undefined;
  }
  if (baseUrl === undefined) {
    return refuse("VenueNotRegistered", "this venue is not one this platform can pay", {
      venue: request.venue,
      // Named out loud: a catalogue listing a venue is not the same as this
      // platform being able to pay it, and that is the point (`C-77`).
      hint: "a public catalogue may list it; only the venue registry authorises paying it",
    });
  }

  // 2. This tenant's own identity, credential and consent — all from the
  //    directory, none from a session.
  const tenantAgent = await ensureTenantAgent(deps.directory, deps.masterMnemonic, request.tenantId);
  const now = deps.now ?? new Date();
  const [credential, activeMandates] = await Promise.all([
    deps.directory.findLatestCredential(request.tenantId),
    deps.directory.listActiveMandates(request.tenantId, now),
  ]);
  const agentId = tenantAgent.instance.id;
  if (credential === undefined) {
    return refuse("CredentialNotFound", "this tenant has no credential to act with", { tenantId: request.tenantId }, undefined, agentId);
  }
  if (credential.revokedAt !== null) {
    return refuse("CredentialRevoked", "this tenant's credential was revoked", { tenantId: request.tenantId }, undefined, agentId);
  }
  // Strictly this agent's own mandate. There is no fallback to "some other
  // active mandate of this tenant": a tenant may hold several agents, and a
  // consent signed for one of them is not consent for another. `checkMandate`
  // would catch it a layer later with `MandateAgentMismatch`, but a purchase
  // path should not hand the enforcement layer a document it already knows is
  // the wrong one and hope. Among this agent's own, the one that names the
  // product goes first (`selectMandateFor`, T85).
  const mandateRecord = selectMandateFor(activeMandates, agentId, request.productId);
  if (mandateRecord === undefined) {
    // Nothing active — say whether it was revoked, expired, or never signed,
    // instead of one code for all three (T85).
    const history = (await deps.directory.listMandates(request.tenantId)).filter((row) => row.agentId === agentId);
    const missing = explainMissingMandate(history, request.productId, now);
    return refuse(
      missing.code,
      missing.reason,
      { tenantId: request.tenantId, agentId, mandateId: missing.mandateId, otherActiveMandates: activeMandates.length },
      undefined,
      agentId,
    );
  }

  let mandateSource: MandateSource;
  let scope: Scope;
  try {
    mandateSource = mandateSourceFrom(mandateRecord);
    scope = scopeFromCredential(credential);
  } catch (error) {
    return asRefusal(error, undefined, agentId);
  }

  // 3. The same engine `finishSession` builds, assembled per tenant. The
  //    vault is this tenant's own (`tenantId`), so `perDay` counts this
  //    tenant's spending and nobody else's.
  const vault = await createPostgresMandateVault({ connectionString: deps.databaseUrl, tenantId: request.tenantId });
  const policyRail = withVault(createLocalPolicyRail({ ledger: vault }), vault);
  const catalog = createX402Catalog({ venueId, registry, baseUrl });

  let agent;
  try {
    agent = await createAgent({
      credential: credential.jws,
      mandate: mandateSource,
      catalog,
      verifier: deps.agentpass,
      mandateVerifier: createOnChainMandateVerifier(deps.agentpass),
      signer: tenantAgent.keypair,
      ledger: vault,
      policyRail,
      now,
    });
  } catch (error) {
    return asRefusal(error, undefined, agentId);
  }

  // A credential or Mandate that failed its on-chain check leaves the agent
  // without `create_purchase_intent`. Say why, rather than invoking a tool
  // that is not there and reporting `UnknownTool` (T85).
  const withheld = withheldBecause(agent);
  if (withheld !== undefined) {
    return refuse(withheld.code, withheld.message, withheld.details ?? {}, undefined, agentId);
  }

  // 4. The intent. This is where `checkScope`, `checkMandate` — including the
  //    product allowlist of `C-75` — and `perDay` all run. The tool does not
  //    exist at all if the documents failed to verify, so reaching this line
  //    already means they did.
  let intentResult: { intent_id: string; jws: string; total_amount: string; asset: string };
  try {
    intentResult = (await agent.tools.invoke("create_purchase_intent", {
      product_id: request.productId,
      quantity: request.quantity,
    })) as typeof intentResult;
  } catch (error) {
    return asRefusal(error, undefined, agentId);
  }

  // 5. The partner's own ceiling, if it set one. Only ever refuses earlier
  //    than the Mandate already would.
  if (request.maxTotal !== undefined && toScaledAmount(intentResult.total_amount) > toScaledAmount(request.maxTotal)) {
    return refuse(
      "PurchaseCeilingExceeded",
      "the venue's total is above the ceiling this purchase declared",
      { total: intentResult.total_amount, maxTotal: request.maxTotal },
      intentResult.intent_id,
      agentId,
    );
  }

  // 6. Where to actually pay. The route comes from the venue's own catalogue,
  //    not from a constant in this repo — the hardcoding T74 exists to remove.
  let resourceUrl: string;
  try {
    const route = await getX402ServiceRoute({ venueId, registry, baseUrl }, request.productId);
    requireRouteParams(route, request.routeParams ?? {});
    resourceUrl = fillRouteTemplate(baseUrl, route, request.routeParams ?? {});
  } catch (error) {
    return asRefusal(error, intentResult.intent_id, agentId);
  }

  // 6b. Ask the venue for its quote before anything is spent on this purchase
  //     (D2, T85). In production a venue refused a request for its input only
  //     after this tenant's sponsored rail had been deployed and funded for
  //     it. Nothing is authorised or signed here — the challenge is fetched
  //     again, and reconciled against the Mandate, in step 8.
  try {
    await requestPaymentChallenge(resourceUrl, deps.fetchImpl);
  } catch (error) {
    return asRefusal(error, intentResult.intent_id, agentId);
  }

  // 7. Who pays: this tenant's own `policy_rail`, deployed and funded from
  //    the sponsored reserve on its first purchase (T58).
  //
  //    `principal` — the only address that can ever withdraw from that rail
  //    or rotate its owner (T57, `C-61`) — is taken from the **signed
  //    Mandate's own issuer**, not from a directory row. `mandateRecord`
  //    carries a `principalId` (a `prc_…` row id) and the rail needs a
  //    Stellar address; the document's `issuer` is that address's DID, and
  //    it is the value the principal themselves signed. Deriving custody
  //    from anything less than the signed document would mean a bad row in
  //    Postgres could hand withdrawal rights to the wrong account.
  const parsedMandate = agentPayMandateSchema.parse(mandateRecord.document);
  let payer;
  try {
    const principalAddress = didToStellarAddress(parsedMandate.issuer);
    const agentInstance = await deps.directory.findAgent(tenantAgent.instance.id);
    if (agentInstance === undefined) {
      return refuse("AgentNotFound", "this tenant has no agent row to own a rail", { tenantId: request.tenantId }, intentResult.intent_id, agentId);
    }
    const contractId = await ensureTenantPolicyRail(
      deps.directory,
      { instance: agentInstance, keypair: tenantAgent.keypair },
      principalAddress,
      deps.reserve,
      deps.policyRailWasmHash,
      deps.readUsdcBalance,
    );
    payer = { contractId, ownerSecret: tenantAgent.keypair.secret() };
  } catch (error) {
    return asRefusal(error, intentResult.intent_id, agentId);
  }

  // 8. The payment itself: the 402 challenge, `reconcileTerms` against the
  //    signed grant, and the rail's own on-chain limits on top.
  let receipt;
  try {
    // Verified, not merely decoded: the intent this agent just signed is
    // checked against its own signature before it is used to authorise a
    // payment, exactly as `buy()` did. Decoding the payload by hand here
    // would have quietly removed a check.
    const verified = await verifyIntent(intentResult.jws);
    receipt = await executeBazaarPayment(
      {
        policyRail,
        signerSecret: tenantAgent.keypair.secret(),
        payer,
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      },
      { resourceUrl, intent: verified.intent, scope, mandate: parsedMandate, venueId },
    );
  } catch (error) {
    return asRefusal(error, intentResult.intent_id, agentId);
  }

  return {
    kind: "settled",
    agentId: tenantAgent.instance.id,
    intentId: intentResult.intent_id,
    total: intentResult.total_amount,
    asset: intentResult.asset,
    // The payee the challenge named and reconcileTerms checked against the
    // Mandate — not `receipt.payer`, which is who paid (the tenant's rail).
    payTo: receipt.payTo,
    transactionHash: receipt.transaction,
    resourceUrl,
    resource: receipt.resourceBody,
  };
}

