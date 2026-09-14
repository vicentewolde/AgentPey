#!/usr/bin/env node
/**
 * The F9 acceptance suite (T85): cases 2 to 10 of the pilot brief § 7, run
 * against the three services as deployed — not against local copies, because
 * `venues.json` resolves SignalDesk by its exact public origin, and because T84
 * showed that the defects that matter live on the edges between services.
 *
 * **It plays a person, not a partner.** Everything a person does goes through
 * RealOps' own pages (sign in, hire an agent, sign, ask, read "Mis servicios")
 * and AgentPey's own consent and revocation routes — the exact calls
 * `consent.html` and `revocar.html` make, with a throwaway testnet `Keypair`
 * standing in for Freighter. The only calls made with RealOps' partner key
 * directly are the ones that stand for *a platform asking for something it
 * should not get* — another venue, another product, a Mandate that already
 * expired. "RealOps pide, AgentPey decide", exercised from the side that asks.
 *
 * **What it does not prove.** The pages' JavaScript is not run; the routes it
 * calls are. That half is covered by the user's own Freighter run in T84 and
 * by the external-person test of `PILOTO-F9.md` § 10.
 *
 * **What it spends.** Two sponsored rails (personas A and C) and a handful of
 * testnet purchases. Persona C's rail is emptied back into the reserve (case
 * 8). Wallets are created per run and their secrets are never written down.
 *
 * **What it cannot force.** A 402 invoice with a different price, asset or
 * payee, and a catalogue that is down, would need a failure switch inside the
 * public services — ruled out in T84. Those parts are reported as `declared`,
 * with the tests that cover them, never as passed.
 *
 *   pnpm run acceptance:f9
 *   pnpm run acceptance:f9 -- --phase=day2
 *   pnpm run acceptance:f9 -- --only=B,D
 */
import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { AgentPassError, isAgentPassError, signStellarMessage, ulid } from "@agentpass/core";
import { toScaledAmount } from "@agentpey/agent";
import { createDirectory } from "@agentpey/directory";
import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { type AssembledTransaction, Client, basicNodeSigner } from "@stellar/stellar-sdk/contract";
import { z } from "zod";

import { EXPLAINED_CODES, explainRefusal } from "../apps/realops/src/refusals.js";
import { readEnvFile } from "./lib/env-file.js";
import {
  type Check,
  type CheckStatus,
  type CookieJar,
  type PersonaId,
  agentIdFromLocation,
  checkCode,
  checkThat,
  consentSessionIdFromUrl,
  createCookieJar,
  declared,
  pageSays,
  parseAcceptanceArgs,
  personaEmail,
  readExternalRef,
  readOnScreenMagicLink,
  readRequestKey,
  readSignedMandateId,
  redact,
  tally,
} from "./lib/f9-acceptance.js";
import { fundWithFriendbot } from "./lib/network.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUT_DIR = resolve(ROOT, ".f9-acceptance");
const DAY2_STATE_PATH = resolve(OUT_DIR, "day2-state.json");
const CLI_BIN = resolve(ROOT, "packages/cli/dist/bin.js");

const env = await readEnvFile(resolve(ROOT, ".env.local"));

function required(name: string): string {
  const value = env.get(name);
  if (value === undefined || value === "") {
    throw new AgentPassError("ConfigError", `${name} is missing from .env.local`, { details: { name } });
  }
  return value;
}

const trimSlash = (url: string): string => url.replace(/\/+$/, "");
const WEB = trimSlash(env.get("F9_WEB_URL") ?? "https://agentpay-web.onrender.com");
const REALOPS = trimSlash(env.get("F9_REALOPS_URL") ?? "https://agentpey-realops.onrender.com");
const SIGNALDESK = trimSlash(env.get("F9_SIGNALDESK_URL") ?? "https://agentpey-signaldesk.onrender.com");
const HORIZON = "https://horizon-testnet.stellar.org";
const RPC_URL = "https://soroban-testnet.stellar.org";
const FRIENDBOT = "https://friendbot.stellar.org";

const API_KEY = required("REALOPS_AGENTPEY_API_KEY");
const RUN_ID = ulid();

/** A first purchase deploys and funds a rail and settles on testnet: 20–40 s measured in T84. */
const HTTP_TIMEOUT_MS = 150_000;
/** How long persona E's Mandate lives: enough to sign it, short enough to wait out. */
const EXPIRING_WINDOW_MS = 6 * 60 * 1000;

// ---- The pilot's venue, read from the same file AgentPey resolves against ----

const venueRowsSchema = z.array(
  z.looseObject({
    slug: z.string(),
    address: z.string(),
    baseUrl: z.string().optional(),
    assets: z.array(z.looseObject({ code: z.string(), issuer: z.string() })),
  }),
);

const venues = venueRowsSchema.safeParse(
  JSON.parse(await readFile(resolve(ROOT, "apps/agent/src/catalog/venues.json"), "utf8")),
);
if (!venues.success) {
  throw new AgentPassError("ConfigError", "venues.json does not match the expected shape", {
    details: { issues: venues.error.issues.map((issue) => issue.message) },
  });
}

function venueRow(slug: string): z.infer<typeof venueRowsSchema>[number] {
  const row = venues.success ? venues.data.find((candidate) => candidate.slug === slug) : undefined;
  if (row === undefined) throw new AgentPassError("ConfigError", `venues.json has no "${slug}" row`, { details: { slug } });
  return row;
}

const signalDeskRow = venueRow("signaldesk");
const bazaarRow = venueRow("stellar-bazaar");
const usdc = signalDeskRow.assets.find((asset) => asset.code === "USDC");
if (usdc === undefined) throw new AgentPassError("ConfigError", "SignalDesk's venue row names no USDC asset", {});

const SIGNALDESK_VENUE_ID = `${signalDeskRow.slug}:${signalDeskRow.address}`;
const BAZAAR_VENUE_ID = `${bazaarRow.slug}:${bazaarRow.address}`;
const ASSET_ID = `USDC:${usdc.issuer}`;
const PAY_TO = signalDeskRow.address;
const PRODUCT = {
  market_brief: "signaldesk:market-brief-xlm-usdc",
  ai_credits: "signaldesk:ai-credits-1000",
} as const;

type AgentKind = keyof typeof PRODUCT;

const ASK_BRIEF = { instruction: "comprá el informe XLM/USDC" } as const;
const ASK_CREDITS = { instruction: "comprá 1000 créditos de IA" } as const;

// ---- HTTP -----------------------------------------------------------------

interface HttpResult {
  readonly status: number;
  readonly location: string | undefined;
  readonly text: string;
  readonly ms: number;
}

async function http(
  method: string,
  url: string,
  options: {
    readonly jar?: CookieJar;
    readonly form?: Readonly<Record<string, string>>;
    readonly json?: unknown;
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { ...options.headers };
  const cookie = options.jar?.header();
  if (cookie !== undefined) headers.cookie = cookie;

  let body: string | undefined;
  if (options.form !== undefined) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(options.form).toString();
  } else if (options.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  }

  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(url, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (error) {
    throw new AgentPassError("NetworkError", `${method} ${new URL(url).pathname} did not answer`, {
      cause: error,
      details: { url },
    });
  }
  options.jar?.absorb(response.headers.getSetCookie());
  const text = await response.text();
  return { status: response.status, location: response.headers.get("location") ?? undefined, text, ms: Date.now() - started };
}

function parseRaw(result: HttpResult, what: string): unknown {
  try {
    return JSON.parse(result.text);
  } catch (error) {
    throw new AgentPassError("NetworkError", `${what}: the answer was not JSON`, {
      cause: error,
      details: { status: result.status, body: result.text.slice(0, 300) },
    });
  }
}

function parseWith<S extends z.ZodType>(schema: S, raw: unknown, result: HttpResult, what: string): z.output<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentPassError("InvalidArguments", `${what}: the answer does not match the expected shape`, {
      details: { status: result.status, issues: parsed.error.issues.map((issue) => issue.message), body: result.text.slice(0, 300) },
    });
  }
  return parsed.data;
}

/** A web API step either worked or was refused with a typed code. Refusals are data here, not exceptions. */
type Step<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly status: number };

const failureSchema = z.looseObject({ ok: z.literal(false), code: z.string(), message: z.string().optional() });

function readStep<S extends z.ZodType>(schema: S, result: HttpResult, what: string): Step<z.output<S>> {
  const raw = parseRaw(result, what);
  const failure = failureSchema.safeParse(raw);
  if (failure.success) return { ok: false, code: failure.data.code, message: failure.data.message ?? "", status: result.status };
  return { ok: true, value: parseWith(schema, raw, result, what) };
}

function requireStep<T>(step: Step<T>, what: string): T {
  if (!step.ok) {
    throw new AgentPassError("CommandFailed", `${what} was refused: ${step.code} — ${step.message}`, {
      details: { code: step.code, status: step.status },
    });
  }
  return step.value;
}

const envelopeSchema = z.looseObject({
  ok: z.boolean(),
  data: z.unknown().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
});

/** `/v1`, with RealOps' partner key. The key is never logged and is redacted from evidence. */
async function v1<S extends z.ZodType>(
  method: string,
  path: string,
  schema: S,
  options: { readonly body?: unknown; readonly idempotencyKey?: string } = {},
): Promise<z.output<S>> {
  const headers: Record<string, string> = { authorization: `Bearer ${API_KEY}` };
  if (options.idempotencyKey !== undefined) headers["idempotency-key"] = options.idempotencyKey;
  const result = await http(method, `${WEB}${path}`, { headers, json: options.body });
  const envelope = envelopeSchema.safeParse(parseRaw(result, path));
  if (!envelope.success || !envelope.data.ok) {
    throw new AgentPassError("CommandFailed", `${method} ${path} was refused`, {
      details: {
        status: result.status,
        code: envelope.success ? envelope.data.code : undefined,
        message: envelope.success ? envelope.data.message : undefined,
      },
    });
  }
  return parseWith(schema, envelope.data.data, result, path);
}

// ---- Shapes read from the services ------------------------------------------

const challengeSchema = z.looseObject({ ok: z.literal(true), nonce: z.string(), message: z.string() });
const verifiedSchema = z.looseObject({ ok: z.literal(true), address: z.string() });
const startedSchema = z.looseObject({ ok: z.literal(true), pending: z.string(), challengeMessage: z.string() });
const preparedSchema = z.looseObject({ ok: z.literal(true), requestId: z.string(), xdr: z.string() });
const anchoredSchema = z.looseObject({ ok: z.literal(true), mandateId: z.string(), transactionHash: z.string() });
const revocationViewSchema = z.looseObject({ ok: z.literal(true), status: z.string(), validUntil: z.string() });
const revokedSchema = z.looseObject({ ok: z.literal(true), revokeTx: z.string() });

const tenantSchema = z.looseObject({ id: z.string(), external_ref: z.string() });
const consentSessionSchema = z.looseObject({
  id: z.string(),
  status: z.string(),
  consent_url: z.string().nullable(),
  mandate_id: z.string().nullable(),
});
const mandatesSchema = z.array(z.looseObject({ id: z.string(), status: z.string(), valid_until: z.string() }));
const purchaseSchema = z.looseObject({
  id: z.string(),
  outcome: z.enum(["settled", "refused"]),
  code: z.string().nullable(),
  reason: z.string().nullable(),
  product_id: z.string(),
  total: z.string().nullable(),
  pay_to: z.string().nullable().optional(),
  transaction_hash: z.string().nullable(),
  delivery: z
    .looseObject({
      delivery_id: z.string().nullable(),
      artifact_url: z.string().nullable(),
      receipt_hash: z.string().nullable(),
    })
    .nullable(),
  created_at: z.string(),
});
type Purchase = z.infer<typeof purchaseSchema>;

const activitySchema = z.looseObject({
  tenant_id: z.string(),
  mandate: z.looseObject({ id: z.string(), status: z.string(), valid_until: z.string() }).nullable(),
  per_day: z.looseObject({ limit: z.string(), spent_today: z.string() }).nullable(),
  rail: z.looseObject({ contract_id: z.string(), balance: z.string() }).nullable(),
  purchases: z.array(purchaseSchema),
});
type Activity = z.infer<typeof activitySchema>;

const horizonTransactionSchema = z.looseObject({ successful: z.boolean(), ledger: z.number() });
const bazaarSearchSchema = z.looseObject({
  ok: z.literal(true),
  results: z.array(z.looseObject({ resource: z.looseObject({ id: z.string(), routeTemplate: z.string().optional() }) })),
});
const day2StateSchema = z.strictObject({
  runId: z.string(),
  email: z.string(),
  agentId: z.string(),
  mandateId: z.string(),
  tenantId: z.string(),
  validUntil: z.iso.datetime(),
});

// ---- A person, and what they do ---------------------------------------------

interface Persona {
  readonly id: PersonaId;
  readonly email: string;
  readonly jar: CookieJar;
  readonly wallet: Keypair;
}

function newPersona(id: PersonaId, email?: string): Persona {
  return { id, email: email ?? personaEmail(RUN_ID, id), jar: createCookieJar(), wallet: Keypair.random() };
}

async function fundWallet(wallet: Keypair): Promise<void> {
  await fundWithFriendbot(FRIENDBOT, wallet.publicKey());
}

const isRedirect = (result: HttpResult): boolean => result.status === 302;

/** Signs in through the on-screen magic link. Returns the link, so case 10 can try to reuse it. */
async function signIn(persona: Persona): Promise<string> {
  const sent = await http("POST", `${REALOPS}/entrar`, {
    jar: persona.jar,
    form: { email: persona.email, alias: `Suite T85 ${persona.id}` },
  });
  const link = readOnScreenMagicLink(sent.text);
  if (link === undefined) {
    throw new AgentPassError(
      "ConfigError",
      "RealOps did not show the sign-in link on screen — it is sending email, which this suite cannot read",
      { details: { status: sent.status } },
    );
  }
  const redeemed = await http("GET", link, { jar: persona.jar });
  if (!isRedirect(redeemed) || persona.jar.header() === undefined) {
    throw new AgentPassError("CommandFailed", "the sign-in link did not start a RealOps session", {
      details: { status: redeemed.status },
    });
  }
  return link;
}

async function externalRefOf(persona: Persona): Promise<string> {
  const page = await http("GET", `${REALOPS}/servicios`, { jar: persona.jar });
  const ref = readExternalRef(page.text);
  if (ref === undefined) throw new AgentPassError("CommandFailed", "Mis servicios shows no external reference", { details: { status: page.status } });
  return ref;
}

interface Limits {
  readonly perTx: string;
  readonly perDay: string;
  readonly validForDays: number;
}

async function hireAgent(persona: Persona, kind: AgentKind, label: string, limits: Limits): Promise<string> {
  const result = await http("POST", `${REALOPS}/agentes`, {
    jar: persona.jar,
    form: { kind, label, perTx: limits.perTx, perDay: limits.perDay, validForDays: String(limits.validForDays) },
  });
  const agentId = agentIdFromLocation(result.location);
  if (agentId === undefined) {
    throw new AgentPassError("CommandFailed", "RealOps did not create the agent", {
      details: { status: result.status, body: result.text.slice(0, 300) },
    });
  }
  return agentId;
}

/** "Firmar" in RealOps: returns the consent session AgentPey minted. */
async function startSigning(persona: Persona, agentId: string): Promise<string> {
  const result = await http("POST", `${REALOPS}/agentes/${agentId}/firmar`, { jar: persona.jar });
  const consentId = consentSessionIdFromUrl(result.location);
  if (!isRedirect(result) || consentId === undefined || !result.location!.startsWith(`${WEB}/consent/`)) {
    throw new AgentPassError("CommandFailed", "RealOps did not send the person to AgentPey's consent page", {
      details: { status: result.status, location: result.location, body: result.text.slice(0, 300) },
    });
  }
  return consentId;
}

interface WalletProof {
  readonly address: string;
  readonly nonce: string;
  readonly signature: string;
}

/** What Freighter's `signMessage` produces on the consent and revocation pages. */
async function walletProof(signer: Keypair): Promise<WalletProof> {
  const challenge = requireStep(
    readStep(challengeSchema, await http("POST", `${WEB}/api/wallet/challenge`), "wallet challenge"),
    "wallet challenge",
  );
  return { address: signer.publicKey(), nonce: challenge.nonce, signature: signStellarMessage(signer, challenge.message) };
}

/** What Freighter's `signTransaction` produces. */
function signXdr(xdr: string, signer: Keypair): string {
  const transaction = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
  transaction.sign(signer);
  return transaction.toXDR();
}

const consentPath = (consentId: string): string => `${WEB}/api/consent/${encodeURIComponent(consentId)}`;

async function consentVerify(consentId: string, signer: Keypair): Promise<Step<z.output<typeof verifiedSchema>>> {
  const proof = await walletProof(signer);
  return readStep(verifiedSchema, await http("POST", `${consentPath(consentId)}/wallet-verify`, { json: proof }), "wallet-verify");
}

async function consentStart(consentId: string): Promise<Step<z.output<typeof startedSchema>>> {
  return readStep(startedSchema, await http("POST", `${consentPath(consentId)}/start`), "consent start");
}

async function consentSign(
  consentId: string,
  challengeMessage: string,
  signer: Keypair,
): Promise<Step<z.output<typeof preparedSchema>>> {
  return readStep(
    preparedSchema,
    await http("POST", `${consentPath(consentId)}/wallet-consent`, {
      json: { signature: signStellarMessage(signer, challengeMessage) },
    }),
    "wallet-consent",
  );
}

async function consentAnchor(
  consentId: string,
  prepared: { readonly requestId: string; readonly xdr: string },
  signer: Keypair,
): Promise<Step<z.output<typeof anchoredSchema>>> {
  return readStep(
    anchoredSchema,
    await http("POST", `${consentPath(consentId)}/wallet-anchor`, {
      json: { requestId: prepared.requestId, signedXdr: signXdr(prepared.xdr, signer) },
    }),
    "wallet-anchor",
  );
}

/** The whole of `consent.html`'s happy path, with one wallet. */
async function completeConsent(consentId: string, wallet: Keypair): Promise<{ readonly mandateId: string; readonly anchorTx: string }> {
  requireStep(await consentVerify(consentId, wallet), "wallet-verify");
  const started = requireStep(await consentStart(consentId), "consent start");
  const prepared = requireStep(await consentSign(consentId, started.challengeMessage, wallet), "wallet-consent");
  const anchored = requireStep(await consentAnchor(consentId, prepared, wallet), "wallet-anchor");
  return { mandateId: anchored.mandateId, anchorTx: anchored.transactionHash };
}

/** The return leg of T81: RealOps asks AgentPey what happened and shows the stored Mandate. */
async function returnFromSigning(persona: Persona, agentId: string): Promise<string | undefined> {
  const back = await http("GET", `${REALOPS}/agentes/${agentId}/volver`, { jar: persona.jar });
  if (!isRedirect(back)) {
    throw new AgentPassError("CommandFailed", "RealOps' return route did not redirect", { details: { status: back.status } });
  }
  const page = await http("GET", `${REALOPS}/agentes/${agentId}`, { jar: persona.jar });
  return readSignedMandateId(page.text);
}

interface Signed {
  readonly consentId: string;
  readonly mandateId: string;
  readonly anchorTx: string;
  readonly realopsMandateId: string | undefined;
}

async function signAgent(persona: Persona, agentId: string): Promise<Signed> {
  const consentId = await startSigning(persona, agentId);
  const { mandateId, anchorTx } = await completeConsent(consentId, persona.wallet);
  const realopsMandateId = await returnFromSigning(persona, agentId);
  return { consentId, mandateId, anchorTx, realopsMandateId };
}

interface Asked {
  readonly requestKey: string;
  readonly status: number;
  readonly location: string | undefined;
  readonly text: string;
  readonly ms: number;
}

/**
 * Asks for a purchase from "Mis servicios", as the form does. Pass
 * `requestKey` to resend a form already drawn — a double click, or a resubmit
 * after a timeout.
 */
async function buy(
  persona: Persona,
  what: { readonly instruction: string } | { readonly kind: AgentKind },
  requestKey?: string,
): Promise<Asked> {
  let key = requestKey;
  if (key === undefined) {
    const page = await http("GET", `${REALOPS}/servicios`, { jar: persona.jar });
    key = readRequestKey(page.text);
    if (key === undefined) {
      throw new AgentPassError("CommandFailed", "Mis servicios shows no purchase form", { details: { status: page.status } });
    }
  }
  const form: Readonly<Record<string, string>> =
    "instruction" in what ? { request_key: key, instruction: what.instruction } : { request_key: key, kind: what.kind };
  const result = await http("POST", `${REALOPS}/instruccion`, { jar: persona.jar, form });
  return { requestKey: key, status: result.status, location: result.location, text: result.text, ms: result.ms };
}

async function readRequestKeyOf(persona: Persona): Promise<string> {
  const page = await http("GET", `${REALOPS}/servicios`, { jar: persona.jar });
  const key = readRequestKey(page.text);
  if (key === undefined) throw new AgentPassError("CommandFailed", "Mis servicios shows no purchase form", { details: { status: page.status } });
  return key;
}

/** The tenant RealOps created for this account — same body and key RealOps uses, so it replays. */
async function tenantOf(externalRef: string): Promise<string> {
  const tenant = await v1("POST", "/v1/tenants", tenantSchema, {
    body: { external_ref: externalRef },
    idempotencyKey: `tenant-${externalRef}`,
  });
  return tenant.id;
}

async function activityOf(tenantId: string): Promise<Activity> {
  return v1("GET", `/v1/tenants/${encodeURIComponent(tenantId)}/activity`, activitySchema);
}

function newPurchases(before: Activity, after: Activity): Purchase[] {
  const seen = new Set(before.purchases.map((purchase) => purchase.id));
  return after.purchases.filter((purchase) => !seen.has(purchase.id));
}

/** A platform asking directly — the calls that stand for a RealOps asking for the wrong thing. */
async function purchaseV1(
  tenantId: string,
  venue: string,
  productId: string,
  routeParams: Readonly<Record<string, string>>,
  label: string,
): Promise<Purchase> {
  return v1("POST", "/v1/purchases", purchaseSchema, {
    body: { tenant_id: tenantId, venue, product_id: productId, quantity: 1, route_params: routeParams },
    idempotencyKey: `t85-${RUN_ID}-${label}`,
  });
}

function pilotGrant(kind: AgentKind): Record<string, unknown> {
  return {
    actions: ["intent:create"],
    venues: [SIGNALDESK_VENUE_ID],
    assets: [ASSET_ID],
    products: [PRODUCT[kind]],
    payTo: [PAY_TO],
    limits: { perTx: "0.30", perDay: "0.60", currency: "USDC" },
  };
}

type Attempt<T> = ({ readonly ok: true } & T) | { readonly ok: false; readonly step: string; readonly code: string; readonly message: string };

/** The whole of `revocar.html`: prove the wallet, prepare, sign, submit. */
async function revokeHosted(mandateId: string, signer: Keypair): Promise<Attempt<{ readonly revokeTx: string }>> {
  const base = `${WEB}/api/revoke/${encodeURIComponent(mandateId)}`;
  const prepared = readStep(preparedSchema, await http("POST", `${base}/prepare`, { json: await walletProof(signer) }), "revoke prepare");
  if (!prepared.ok) return { ok: false, step: "prepare", code: prepared.code, message: prepared.message };
  const submitted = readStep(
    revokedSchema,
    await http("POST", `${base}/submit`, {
      json: { requestId: prepared.value.requestId, signedXdr: signXdr(prepared.value.xdr, signer) },
    }),
    "revoke submit",
  );
  if (!submitted.ok) return { ok: false, step: "submit", code: submitted.code, message: submitted.message };
  return { ok: true, revokeTx: submitted.value.revokeTx };
}

async function revocationStatus(mandateId: string): Promise<string> {
  const view = await http("GET", `${WEB}/api/revoke/${encodeURIComponent(mandateId)}`);
  const step = readStep(revocationViewSchema, view, "revocation view");
  return step.ok ? step.value.status : `refused:${step.code}`;
}

interface RailContract {
  withdraw(args: { readonly to: string; readonly amount: bigint }): Promise<AssembledTransaction<null>>;
}

/** `policy_rail.withdraw`, signed by the principal: the escape hatch of T57, used here to empty a rail. */
async function withdrawRail(contractId: string, principal: Keypair, to: string, amount: string): Promise<string> {
  const { signTransaction } = basicNodeSigner(principal, Networks.TESTNET);
  try {
    const rail = await Client.from<RailContract>({
      contractId,
      rpcUrl: RPC_URL,
      networkPassphrase: Networks.TESTNET,
      publicKey: principal.publicKey(),
      signTransaction,
    });
    const assembled = await rail.withdraw({ to, amount: toScaledAmount(amount) });
    const sent = await assembled.signAndSend();
    const hash = sent.sendTransactionResponse?.hash;
    if (hash === undefined) throw new AgentPassError("NetworkError", "the withdrawal returned no transaction hash", { details: { contractId } });
    return hash;
  } catch (error) {
    if (isAgentPassError(error)) throw error;
    throw new AgentPassError("NetworkError", "withdrawing from the rail failed", { cause: error, details: { contractId, to, amount } });
  }
}

/** Read-only: the tenant's latest credential hash, which no route exposes (there is no product path to revoke one). */
async function credentialHashOf(tenantId: string): Promise<string> {
  const directory = await createDirectory({ connectionString: required("DATABASE_URL") });
  try {
    const credential = await directory.findLatestCredential(tenantId);
    if (credential === undefined) {
      throw new AgentPassError("CommandFailed", "this tenant has no credential on file", { details: { tenantId } });
    }
    return credential.credentialHash;
  } finally {
    await directory.close();
  }
}

const execFileAsync = promisify(execFile);

/** Decided with the user: the Phase 1 CLI, with the issuer key, exactly as an operator would. */
async function revokeCredentialWithCli(credentialHash: string): Promise<string> {
  try {
    await access(CLI_BIN);
  } catch (error) {
    throw new AgentPassError("ConfigError", "the CLI is not built — run `pnpm build` first", { cause: error, details: { path: CLI_BIN } });
  }
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(process.execPath, [CLI_BIN, "revoke", credentialHash], { cwd: ROOT }));
  } catch (error) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : "";
    throw new AgentPassError("CommandFailed", "the CLI refused to revoke the credential", {
      cause: error,
      details: { stderr: stderr.slice(0, 500) },
    });
  }
  const transactionHash = /transactionHash\s+(\S+)/.exec(stdout)?.[1];
  if (transactionHash === undefined) {
    throw new AgentPassError("CommandFailed", "the CLI printed no transaction hash", { details: { stdout: stdout.slice(0, 300) } });
  }
  return transactionHash;
}

async function onChainCheck(name: string, hash: string): Promise<Check> {
  const result = await http("GET", `${HORIZON}/transactions/${hash}`);
  if (result.status !== 200) return checkThat(name, false, "successful en Horizon", `HTTP ${result.status}`);
  const transaction = parseWith(horizonTransactionSchema, parseRaw(result, "horizon"), result, "horizon");
  return checkThat(name, transaction.successful, "successful en Horizon", `successful=${transaction.successful} · ledger ${transaction.ledger}`);
}

async function firstBazaarProduct(): Promise<string> {
  if (bazaarRow.baseUrl === undefined) throw new AgentPassError("ConfigError", "stellar-bazaar has no baseUrl in venues.json", {});
  const result = await http("GET", `${trimSlash(bazaarRow.baseUrl)}/api/discovery/search?query=*`);
  const search = parseWith(bazaarSearchSchema, parseRaw(result, "bazaar discovery"), result, "bazaar discovery");
  const card = search.results.find((row) => row.resource.routeTemplate !== undefined);
  if (card === undefined) throw new AgentPassError("CommandFailed", "the bazaar lists no paid route", {});
  return card.resource.id;
}

const summarise = (purchases: readonly Purchase[]): string =>
  purchases.map((purchase) => `${purchase.outcome}${purchase.code === null ? "" : `:${purchase.code}`}`).join(", ") || "(ninguna)";

const unpaid = (purchases: readonly Purchase[]): boolean => purchases.every((purchase) => purchase.transaction_hash === null);

// ---- Cases ------------------------------------------------------------------

interface Recorder {
  check(check: Check): void;
  note(key: string, value: unknown): void;
}

interface CaseResult {
  readonly id: string;
  readonly title: string;
  readonly persona: PersonaId | null;
  readonly seconds: number;
  readonly checks: readonly Check[];
  readonly evidence: Readonly<Record<string, unknown>>;
}

const results: CaseResult[] = [];
const SYMBOL: Readonly<Record<CheckStatus, string>> = { pass: "✓", fail: "✗", declared: "·" };

function describeError(error: unknown): string {
  return isAgentPassError(error) ? `${error.code}: ${error.message}` : String(error);
}

/** Runs one case. An exception becomes a failed check, so one broken case never hides the rest. */
async function runCase<T>(
  id: string,
  title: string,
  persona: PersonaId | null,
  body: (record: Recorder) => Promise<T>,
): Promise<T | undefined> {
  const checks: Check[] = [];
  const evidence: Record<string, unknown> = {};
  const started = Date.now();
  process.stdout.write(`\n▶ ${id} · ${title}\n`);

  const recorder: Recorder = {
    check(check) {
      checks.push(check);
      process.stdout.write(`  ${SYMBOL[check.status]} ${check.name} — ${check.observed}\n`);
    },
    note(key, value) {
      evidence[key] = value;
    },
  };

  let value: T | undefined;
  try {
    value = await body(recorder);
  } catch (error) {
    recorder.check(checkThat("el caso terminó sin excepción", false, "sin excepción", describeError(error)));
    evidence.error = isAgentPassError(error) ? { code: error.code, message: error.message, details: error.details } : String(error);
    value = undefined;
  }
  results.push({ id, title, persona, seconds: Math.round((Date.now() - started) / 1000), checks, evidence });
  return value;
}

/**
 * "Cada caso debe dejar un mensaje comprensible para la persona, código tipado
 * para integradores" (brief § 7). Two checks: RealOps has a sentence of its own
 * for the code, and "Mis servicios" actually shows it next to the code.
 */
async function checkExplained(record: Recorder, persona: Persona | null, purchase: Purchase | undefined): Promise<void> {
  const code = purchase?.code ?? null;
  record.check(
    checkThat(
      `"${code ?? "-"}" tiene frase propia en RealOps`,
      code !== null && EXPLAINED_CODES.includes(code),
      "un código de refusals.ts",
      code === null ? "(sin código)" : EXPLAINED_CODES.includes(code) ? "traducido" : "sin traducir",
    ),
  );
  if (persona === null || purchase === undefined || code === null) return;
  const page = await http("GET", `${REALOPS}/servicios`, { jar: persona.jar });
  const sentence = explainRefusal(code, purchase.reason).what;
  const shows = pageSays(page.text, sentence) && pageSays(page.text, code);
  record.check(checkThat("Mis servicios muestra la frase y el código", shows, `"${sentence}" + ${code}`, shows ? "se muestran" : "no aparecen"));
}

async function wake(): Promise<void> {
  await runCase("W", "Despertar los tres servicios, con una lectura de la base", null, async (record) => {
    const targets = {
      web: `${WEB}/discovery/search?query=informe`,
      realops: `${REALOPS}/`,
      signaldesk: `${SIGNALDESK}/`,
    };
    for (const [name, url] of Object.entries(targets)) {
      const result = await http("GET", url);
      record.note(name, { status: result.status, ms: result.ms });
      record.check(checkThat(`${name} responde`, result.status === 200, "200", `${result.status} en ${result.ms} ms`));
    }
  });
}

async function setupPersona(
  persona: Persona,
  kind: AgentKind,
  limits: Limits,
  record: Recorder,
): Promise<{ readonly externalRef: string; readonly agentId: string; readonly tenantId: string; readonly magicLink: string; readonly signed: Signed }> {
  await fundWallet(persona.wallet);
  const magicLink = await signIn(persona);
  const externalRef = await externalRefOf(persona);
  const agentId = await hireAgent(persona, kind, `T85 ${persona.id} ${kind}`, limits);
  const signed = await signAgent(persona, agentId);
  const tenantId = await tenantOf(externalRef);
  record.note("persona", {
    email: persona.email,
    wallet: persona.wallet.publicKey(),
    externalRef,
    agentId,
    tenantId,
    limits,
    consentId: signed.consentId,
    mandateId: signed.mandateId,
    anchorTx: signed.anchorTx,
  });
  record.check(
    checkThat(
      "RealOps guardó el mismo Mandato que AgentPey ancló",
      signed.realopsMandateId === signed.mandateId,
      signed.mandateId,
      signed.realopsMandateId ?? "(nada)",
    ),
  );
  record.check(await onChainCheck("el anclaje está en la red", signed.anchorTx));
  return { externalRef, agentId, tenantId, magicLink, signed };
}

/** B: a report agent with a 0.20 per-purchase cap. Never pays, so it never consumes a rail. */
async function personaB(): Promise<void> {
  const b = newPersona("B");
  const ctx = await runCase("B0", "Preparación: agente de informes con máximo por compra 0.20", "B", (record) =>
    setupPersona(b, "market_brief", { perTx: "0.20", perDay: "0.60", validForDays: 30 }, record),
  );
  if (ctx === undefined) return;

  await runCase("4a", "Monto sobre el máximo por compra", "B", async (record) => {
    const before = await activityOf(ctx.tenantId);
    const asked = await buy(b, ASK_BRIEF);
    const after = await activityOf(ctx.tenantId);
    const fresh = newPurchases(before, after);
    record.note("realops", { status: asked.status, location: asked.location, ms: asked.ms });
    record.note("purchases", fresh);
    record.check(checkThat("RealOps vuelve a Mis servicios", isRedirect(asked) && asked.location === "/servicios", "302 → /servicios", `${asked.status} → ${asked.location ?? "-"}`));
    record.check(checkThat("una sola compra nueva, rechazada", fresh.length === 1 && fresh[0]?.outcome === "refused", "1 rechazada", summarise(fresh)));
    record.check(checkCode("código del rechazo", fresh[0]?.code, ["ScopeAmountExceeded", "MandateAmountExceeded"]));
    record.check(checkThat("no se pagó ni se desplegó rail", unpaid(fresh) && after.rail === null, "sin transacción, rail null", after.rail?.contract_id ?? "rail null"));
    await checkExplained(record, b, fresh[0]);
  });

  await runCase("9", "Producto ausente, sin intento de pago", "B", async (record) => {
    const before = await activityOf(ctx.tenantId);
    const asked = await buy(b, { instruction: "comprá un mate de calabaza" });
    record.check(
      checkThat(
        "RealOps no reconoce el producto y lo dice",
        asked.status === 200 && pageSays(asked.text, "no reconoci ningun producto"),
        "200 con el aviso",
        `${asked.status}`,
      ),
    );
    const middle = await activityOf(ctx.tenantId);
    record.check(checkThat("RealOps no le pidió nada a AgentPey", newPurchases(before, middle).length === 0, "0 compras nuevas", String(newPurchases(before, middle).length)));

    const absent = await purchaseV1(ctx.tenantId, SIGNALDESK_VENUE_ID, "signaldesk:informe-que-no-existe", { pair: "XLM/USDC" }, "9-producto-ausente");
    record.note("absent", absent);
    record.check(checkCode("un producto que el comercio no tiene", absent.code, ["ProductNotFound"]));
    const after = await activityOf(ctx.tenantId);
    record.check(checkThat("no se pagó ni se desplegó rail", absent.transaction_hash === null && after.rail === null, "sin transacción, rail null", after.rail?.contract_id ?? "rail null"));
    await checkExplained(record, b, absent);
    record.check(
      declared(
        "catálogo caído",
        "CatalogUnavailable: apps/agent/src/catalog/discovery.test.ts:189, apps/agent/src/catalog/agentpey-discovery.test.ts:117, apps/web/src/discovery-route.test.ts:91. En el camino de pago, createX402Catalog sigue sin timeout (deuda anotada).",
      ),
    );
  });

  await runCase("3", "Comercio, producto, activo o payTo no permitidos", "B", async (record) => {
    const foreignVenue = `malvado:${Keypair.random().publicKey()}`;
    const unregistered = await purchaseV1(ctx.tenantId, foreignVenue, PRODUCT.market_brief, { pair: "XLM/USDC" }, "3-no-registrado");
    record.check(checkCode("comercio que AgentPey no tiene registrado", unregistered.code, ["VenueNotRegistered"]));

    const bazaarProduct = await firstBazaarProduct();
    const unsigned = await purchaseV1(ctx.tenantId, BAZAAR_VENUE_ID, bazaarProduct, {}, "3-no-firmado");
    record.check(checkCode("comercio registrado pero no firmado", unsigned.code, ["ScopeVenueNotAllowed", "MandateVenueNotAllowed"]));

    const otherProduct = await purchaseV1(ctx.tenantId, SIGNALDESK_VENUE_ID, PRODUCT.ai_credits, { account: b.wallet.publicKey() }, "3-producto");
    record.check(checkCode("otro producto del mismo comercio", otherProduct.code, ["MandateProductNotAllowed"]));

    const refused = [unregistered, unsigned, otherProduct];
    record.note("bazaarProduct", bazaarProduct);
    record.note("purchases", refused);
    const after = await activityOf(ctx.tenantId);
    record.check(checkThat("ninguno pagó ni desplegó rail", unpaid(refused) && after.rail === null, "sin transacción, rail null", summarise(refused)));
    for (const purchase of refused) await checkExplained(record, b, purchase);
    record.check(declared("activo distinto en la factura (TermsAssetMismatch)", "apps/agent/src/policy/terms.test.ts:81"));
    record.check(
      declared(
        "payTo distinto en la factura (TermsPayeeNotAllowed)",
        "apps/agent/src/policy/terms.test.ts:138 y :147, apps/agent/src/policy/policy-rail.test.ts:184",
      ),
    );
  });

  await runCase("7a", "Una wallet distinta del principal intenta revocar", "B", async (record) => {
    const stranger = Keypair.random();
    await fundWallet(stranger);
    const attempt = await revokeHosted(ctx.signed.mandateId, stranger);
    record.note("stranger", stranger.publicKey());
    record.note("attempt", attempt);
    record.check(checkCode("rechazo al probar la wallet", attempt.ok ? null : attempt.code, ["MandatePrincipalMismatch"]));
    const status = await revocationStatus(ctx.signed.mandateId);
    record.check(checkThat("el permiso sigue activo", status === "active", "active", status));
  });

  await runCase("6a", "Mandato revocado", "B", async (record) => {
    const revoked = await revokeHosted(ctx.signed.mandateId, b.wallet);
    record.note("revocation", revoked);
    record.check(checkThat("la wallet principal revoca", revoked.ok, "revokeTx", revoked.ok ? revoked.revokeTx : `${revoked.step}: ${revoked.code}`));
    if (revoked.ok) record.check(await onChainCheck("la revocación está en la red", revoked.revokeTx));
    const status = await revocationStatus(ctx.signed.mandateId);
    record.check(checkThat("AgentPey lo muestra revocado", status === "revoked", "revoked", status));

    const again = await revokeHosted(ctx.signed.mandateId, b.wallet);
    record.check(checkCode("revocar otra vez se rechaza", again.ok ? null : again.code, ["MandateRevoked"]));

    const before = await activityOf(ctx.tenantId);
    const asked = await buy(b, ASK_BRIEF);
    const after = await activityOf(ctx.tenantId);
    const fresh = newPurchases(before, after);
    record.note("realops", { status: asked.status, location: asked.location });
    record.note("purchases", fresh);
    record.check(checkCode("comprar con el permiso revocado", fresh[0]?.code, ["MandateRevoked"]));
    record.check(checkThat("no se pagó", fresh.length > 0 && unpaid(fresh), "rechazo sin transacción", summarise(fresh)));
    await checkExplained(record, b, fresh[0]);
  });
}

/** D: wrong signers at consent time, then a credential revoked by the issuer. Never pays. */
async function personaD(): Promise<void> {
  const d = newPersona("D");
  const stranger = Keypair.random();

  const ctx = await runCase("D0", "Preparación: agente de informes, invitación a firmar", "D", async (record) => {
    await fundWallet(d.wallet);
    await fundWallet(stranger);
    await signIn(d);
    const externalRef = await externalRefOf(d);
    const agentId = await hireAgent(d, "market_brief", "T85 D market_brief", { perTx: "0.30", perDay: "0.60", validForDays: 30 });
    const consentId = await startSigning(d, agentId);
    record.note("persona", { email: d.email, wallet: d.wallet.publicKey(), stranger: stranger.publicKey(), externalRef, agentId, consentId });
    return { externalRef, agentId, consentId };
  });
  if (ctx === undefined) return;

  const signed = await runCase("7b", "Firmar el Mandato con una wallet distinta de la verificada", "D", async (record) => {
    requireStep(await consentVerify(ctx.consentId, d.wallet), "wallet-verify");
    const started = requireStep(await consentStart(ctx.consentId), "consent start");

    const wrongMessage = await consentSign(ctx.consentId, started.challengeMessage, stranger);
    record.note("wrongMandateSignature", wrongMessage.ok ? "aceptada" : { code: wrongMessage.code, message: wrongMessage.message });
    record.check(checkThat("el Mandato firmado por otra wallet se rechaza", !wrongMessage.ok, "rechazo tipado", wrongMessage.ok ? "aceptado" : wrongMessage.code));

    const rightMessage = await consentSign(ctx.consentId, started.challengeMessage, d.wallet);
    if (rightMessage.ok) {
      const wrongAnchor = await consentAnchor(ctx.consentId, rightMessage.value, stranger);
      record.note("wrongAnchorSigner", wrongAnchor.ok ? "aceptada" : { code: wrongAnchor.code, message: wrongAnchor.message });
      record.check(checkThat("la transacción de anclaje firmada por otra wallet se rechaza", !wrongAnchor.ok, "rechazo", wrongAnchor.ok ? "aceptada" : wrongAnchor.code));
    } else {
      record.note("rightMandateSignatureAfterRefusal", { code: rightMessage.code, message: rightMessage.message });
    }

    const session = await v1("GET", `/v1/consent_sessions/${encodeURIComponent(ctx.consentId)}`, consentSessionSchema);
    record.check(
      checkThat(
        "la invitación sigue pendiente y sin Mandato",
        session.status === "pending" && session.mandate_id === null,
        "pending, sin Mandato",
        `${session.status}, ${session.mandate_id ?? "sin Mandato"}`,
      ),
    );

    // What a person does next on the page: press "Firmar" again, with the right wallet.
    const restarted = await consentStart(ctx.consentId);
    if (!restarted.ok) {
      record.check(checkThat("volver a firmar desde la página funciona", false, "firma completa", `start: ${restarted.code}`));
      return undefined;
    }
    const prepared = await consentSign(ctx.consentId, restarted.value.challengeMessage, d.wallet);
    const anchored = prepared.ok ? await consentAnchor(ctx.consentId, prepared.value, d.wallet) : prepared;
    record.check(checkThat("volver a firmar con la wallet correcta completa la firma", anchored.ok, "Mandato anclado", anchored.ok ? anchored.value.mandateId : anchored.code));
    if (!anchored.ok) return undefined;
    const realopsMandateId = await returnFromSigning(d, ctx.agentId);
    record.check(checkThat("RealOps guardó ese Mandato", realopsMandateId === anchored.value.mandateId, anchored.value.mandateId, realopsMandateId ?? "(nada)"));
    return { mandateId: anchored.value.mandateId };
  });
  if (signed === undefined) return;

  await runCase("6c", "Credencial revocada por el emisor", "D", async (record) => {
    const tenantId = await tenantOf(ctx.externalRef);
    const credentialHash = await credentialHashOf(tenantId);
    const revokeTx = await revokeCredentialWithCli(credentialHash);
    record.note("credential", { tenantId, credentialHash, revokeTx });
    record.check(await onChainCheck("la revocación de la credencial está en la red", revokeTx));

    const before = await activityOf(tenantId);
    const asked = await buy(d, ASK_BRIEF);
    const after = await activityOf(tenantId);
    const fresh = newPurchases(before, after);
    record.note("realops", { status: asked.status, location: asked.location });
    record.note("purchases", fresh);
    record.check(checkCode("comprar con la credencial revocada", fresh[0]?.code, ["CredentialRevoked"]));
    record.check(checkThat("no se pagó ni se desplegó rail", fresh.length > 0 && unpaid(fresh) && after.rail === null, "rechazo sin transacción", summarise(fresh)));
    await checkExplained(record, d, fresh[0]);
  });
}

/** C: the credits product end to end, then an emptied rail. Consumes one sponsored rail. */
async function personaC(): Promise<void> {
  const c = newPersona("C");
  const ctx = await runCase("C0", "Preparación: agente de créditos", "C", (record) =>
    setupPersona(c, "ai_credits", { perTx: "0.30", perDay: "0.60", validForDays: 30 }, record),
  );
  if (ctx === undefined) return;

  const settled = await runCase("2", "Compra de créditos de IA y entrega visible", "C", async (record) => {
    const before = await activityOf(ctx.tenantId);
    const asked = await buy(c, ASK_CREDITS);
    const after = await activityOf(ctx.tenantId);
    const fresh = newPurchases(before, after);
    record.note("realops", { status: asked.status, location: asked.location, ms: asked.ms, body: isRedirect(asked) ? undefined : asked.text.slice(0, 400) });
    record.note("purchases", fresh);
    record.note("rail", after.rail);
    const purchase = fresh[0];
    record.check(checkThat("RealOps vuelve a Mis servicios", isRedirect(asked) && asked.location === "/servicios", "302 → /servicios", `${asked.status} → ${asked.location ?? "-"}`));
    record.check(
      checkThat(
        "una compra de créditos liquidada",
        fresh.length === 1 && purchase?.outcome === "settled" && purchase.product_id === PRODUCT.ai_credits,
        "1 liquidada",
        summarise(fresh),
      ),
    );
    if (purchase?.outcome === "refused") await checkExplained(record, c, purchase);
    if (purchase?.transaction_hash) record.check(await onChainCheck("el pago está en la red", purchase.transaction_hash));
    record.check(checkThat("cobró la cuenta de SignalDesk", purchase?.pay_to === PAY_TO, PAY_TO, purchase?.pay_to ?? "(nada)"));
    record.check(
      checkThat(
        "la entrega trae id y recibo",
        Boolean(purchase?.delivery?.delivery_id) && Boolean(purchase?.delivery?.receipt_hash),
        "delivery_id y receipt_hash",
        JSON.stringify(purchase?.delivery ?? null),
      ),
    );
    const artifactUrl = purchase?.delivery?.artifact_url;
    if (artifactUrl) {
      const artifact = await http("GET", artifactUrl);
      record.check(checkThat("la entrega se abre", artifact.status === 200, "200", String(artifact.status)));
    }
    const deliveryId = purchase?.delivery?.delivery_id;
    if (deliveryId) {
      const page = await http("GET", `${REALOPS}/servicios`, { jar: c.jar });
      record.check(checkThat("Mis servicios muestra la entrega", pageSays(page.text, deliveryId), deliveryId, pageSays(page.text, deliveryId) ? "se muestra" : "no aparece"));
    }
    return purchase?.outcome === "settled" ? purchase : undefined;
  });

  await runCase("8b", "Rail sin saldo", "C", async (record) => {
    const reserve = required("RESERVE_ADDRESS");
    const before = await activityOf(ctx.tenantId);
    if (before.rail === null) {
      throw new AgentPassError("CommandFailed", "this tenant has no rail to empty — case 2 did not deploy one", {
        details: { settledInCase2: settled !== undefined },
      });
    }
    record.note("railBefore", before.rail);
    record.note("perDayBefore", before.per_day);
    if (Number(before.rail.balance) > 0) {
      const withdrawTx = await withdrawRail(before.rail.contract_id, c.wallet, reserve, before.rail.balance);
      record.note("withdrawal", { to: reserve, amount: before.rail.balance, transaction: withdrawTx });
      record.check(await onChainCheck("el retiro a la reserva está en la red", withdrawTx));
    }
    const emptied = await activityOf(ctx.tenantId);
    record.check(checkThat("el rail quedó en cero", Number(emptied.rail?.balance ?? Number.NaN) === 0, "0", emptied.rail?.balance ?? "rail null"));

    const asked = await buy(c, ASK_CREDITS);
    const after = await activityOf(ctx.tenantId);
    const fresh = newPurchases(emptied, after);
    record.note("realops", { status: asked.status, location: asked.location, ms: asked.ms, body: isRedirect(asked) ? undefined : asked.text.slice(0, 400) });
    record.note("purchases", fresh);
    record.note("perDayAfter", after.per_day);
    record.check(checkThat("no se liquidó ninguna compra", fresh.every((purchase) => purchase.outcome !== "settled"), "ninguna liquidada", summarise(fresh)));
    record.check(checkThat("no hay entrega nueva", fresh.every((purchase) => !purchase.delivery?.delivery_id), "sin entrega", summarise(fresh)));
    record.check(checkThat("el intento quedó registrado como rechazo", fresh.length === 1 && fresh[0]?.outcome === "refused", "1 rechazada", summarise(fresh)));
    record.check(
      checkThat(
        "el gasto del día no cuenta un pago que no ocurrió",
        after.per_day?.spent_today === emptied.per_day?.spent_today,
        emptied.per_day?.spent_today ?? "-",
        after.per_day?.spent_today ?? "-",
      ),
    );
    await checkExplained(record, c, fresh[0]);
  });
}

/** A: idempotency, the daily cap, two agents in one account, and coming back. Consumes one sponsored rail. */
async function personaA(): Promise<void> {
  const a = newPersona("A");
  const ctx = await runCase("A0", "Preparación: agente de informes con tope diario 0.40", "A", (record) =>
    setupPersona(a, "market_brief", { perTx: "0.30", perDay: "0.40", validForDays: 30 }, record),
  );
  if (ctx === undefined) return;

  const settled = await runCase("8a", "Idempotencia: reenviar el mismo formulario no paga ni entrega dos veces", "A", async (record) => {
    const before = await activityOf(ctx.tenantId);
    const key = await readRequestKeyOf(a);
    const first = await buy(a, ASK_BRIEF, key);
    const afterFirst = await activityOf(ctx.tenantId);
    const firstNew = newPurchases(before, afterFirst);
    record.note("first", { status: first.status, location: first.location, ms: first.ms, purchases: firstNew });
    const purchase = firstNew[0];
    record.check(checkThat("la primera compra se liquida", firstNew.length === 1 && purchase?.outcome === "settled", "1 liquidada", summarise(firstNew)));
    if (purchase?.transaction_hash) record.check(await onChainCheck("el pago está en la red", purchase.transaction_hash));

    const replay = await buy(a, ASK_BRIEF, key);
    const afterReplay = await activityOf(ctx.tenantId);
    const replayNew = newPurchases(afterFirst, afterReplay);
    record.note("replay", { status: replay.status, location: replay.location, ms: replay.ms, purchases: replayNew });
    record.check(checkThat("RealOps vuelve a Mis servicios", isRedirect(replay) && replay.location === "/servicios", "302 → /servicios", `${replay.status} → ${replay.location ?? "-"}`));
    record.check(checkThat("el reenvío no crea otra compra", replayNew.length === 0, "0 compras nuevas", summarise(replayNew)));
    const settledCount = afterReplay.purchases.filter((row) => row.outcome === "settled").length;
    record.check(checkThat("una sola transacción y una sola entrega", settledCount === 1, "1", String(settledCount)));
    record.check(
      checkThat(
        "el gasto del día cuenta una sola compra",
        afterReplay.per_day?.spent_today === afterFirst.per_day?.spent_today,
        afterFirst.per_day?.spent_today ?? "-",
        afterReplay.per_day?.spent_today ?? "-",
      ),
    );
    return purchase?.outcome === "settled" ? purchase : undefined;
  });

  await runCase("4b", "Segunda compra que supera el máximo diario", "A", async (record) => {
    const before = await activityOf(ctx.tenantId);
    const asked = await buy(a, ASK_BRIEF);
    const after = await activityOf(ctx.tenantId);
    const fresh = newPurchases(before, after);
    record.note("realops", { status: asked.status, location: asked.location });
    record.note("purchases", fresh);
    record.note("perDay", after.per_day);
    record.check(checkCode("código del rechazo", fresh[0]?.code, ["ScopeDailyLimitExceeded", "MandateDailyLimitExceeded"]));
    record.check(checkThat("no se pagó", fresh.length > 0 && unpaid(fresh), "rechazo sin transacción", summarise(fresh)));
    await checkExplained(record, a, fresh[0]);
  });

  await runCase("A2", "Una cuenta con dos agentes compra con el segundo", "A", async (record) => {
    const creditsAgent = await hireAgent(a, "ai_credits", "T85 A ai_credits", { perTx: "0.30", perDay: "0.60", validForDays: 30 });
    const signed = await signAgent(a, creditsAgent);
    record.note("creditsAgent", { agentId: creditsAgent, mandateId: signed.mandateId, anchorTx: signed.anchorTx });
    const before = await activityOf(ctx.tenantId);
    const asked = await buy(a, ASK_CREDITS);
    const after = await activityOf(ctx.tenantId);
    const fresh = newPurchases(before, after);
    record.note("realops", { status: asked.status, location: asked.location, ms: asked.ms });
    record.note("purchases", fresh);
    record.check(checkThat("la compra de créditos se liquida", fresh.length === 1 && fresh[0]?.outcome === "settled", "1 liquidada", summarise(fresh)));
    if (fresh[0]?.outcome === "refused") await checkExplained(record, a, fresh[0]);
  });

  await runCase("10", "Volver a RealOps con estado durable", "A", async (record) => {
    a.jar.clear();
    const anonymous = await http("GET", `${REALOPS}/agentes`, { jar: a.jar });
    record.check(checkThat("sin sesión, RealOps pide entrar", isRedirect(anonymous) && anonymous.location === "/entrar", "302 → /entrar", `${anonymous.status} → ${anonymous.location ?? "-"}`));
    const replayedLink = await http("GET", ctx.magicLink, { jar: a.jar });
    record.check(checkThat("el enlace de entrada no sirve dos veces", replayedLink.status === 400 && pageSays(replayedLink.text, "ya se usó"), "400, ya se usó", String(replayedLink.status)));

    await signIn(a);
    const agentPage = await http("GET", `${REALOPS}/agentes/${ctx.agentId}`, { jar: a.jar });
    const storedMandate = readSignedMandateId(agentPage.text);
    record.check(checkThat("el agente conserva su Mandato", storedMandate === ctx.signed.mandateId, ctx.signed.mandateId, storedMandate ?? "(nada)"));
    const externalRef = await externalRefOf(a);
    record.check(checkThat("la misma identidad ante AgentPey", externalRef === ctx.externalRef, ctx.externalRef, externalRef));
    if (settled !== undefined) {
      const activity = await activityOf(ctx.tenantId);
      const kept = activity.purchases.some((row) => row.id === settled.id && row.transaction_hash === settled.transaction_hash);
      record.check(checkThat("la compra sigue en el historial con su transacción", kept, settled.transaction_hash ?? "-", kept ? "presente" : "falta"));
      const deliveryId = settled.delivery?.delivery_id;
      if (deliveryId) {
        const page = await http("GET", `${REALOPS}/servicios`, { jar: a.jar });
        record.check(checkThat("Mis servicios muestra la entrega", pageSays(page.text, deliveryId), deliveryId, pageSays(page.text, deliveryId) ? "se muestra" : "no aparece"));
      }
    }
  });
}

interface Expiring {
  readonly persona: Persona;
  readonly tenantId: string;
  readonly mandateId: string;
  readonly validUntil: Date;
}

/** E, first half: a Mandate valid for minutes, proposed directly through `/v1` because RealOps' minimum is a day. */
async function prepareExpiring(): Promise<Expiring | undefined> {
  const e = newPersona("E");
  return runCase("E0", "Preparación: Mandato de minutos pedido por /v1", "E", async (record) => {
    await fundWallet(e.wallet);
    await signIn(e);
    const externalRef = await externalRefOf(e);
    const tenantId = await tenantOf(externalRef);
    const validUntil = new Date(Date.now() + EXPIRING_WINDOW_MS);
    const session = await v1("POST", "/v1/consent_sessions", consentSessionSchema, {
      body: { tenant_id: tenantId, grant: pilotGrant("market_brief"), valid_until: validUntil.toISOString() },
      idempotencyKey: `t85-${RUN_ID}-e-consent`,
    });
    const { mandateId, anchorTx } = await completeConsent(session.id, e.wallet);
    record.note("persona", { email: e.email, wallet: e.wallet.publicKey(), externalRef, tenantId, consentId: session.id, mandateId, anchorTx, validUntil: validUntil.toISOString() });
    record.check(await onChainCheck("el anclaje está en la red", anchorTx));
    return { persona: e, tenantId, mandateId, validUntil };
  });
}

/** E, second half: once the window closed, ask to buy. */
async function finishExpiring(expiring: Expiring): Promise<void> {
  await runCase("6b", "Mandato vencido (vigencia de minutos, por /v1)", "E", async (record) => {
    const waitMs = expiring.validUntil.getTime() + 15_000 - Date.now();
    if (waitMs > 0) {
      process.stdout.write(`  … esperando ${Math.ceil(waitMs / 1000)} s a que venza ${expiring.mandateId}\n`);
      await new Promise((done) => setTimeout(done, waitMs));
    }
    const refused = await purchaseV1(expiring.tenantId, SIGNALDESK_VENUE_ID, PRODUCT.market_brief, { pair: "XLM/USDC" }, "6b-vencido");
    const after = await activityOf(expiring.tenantId);
    record.note("purchase", refused);
    record.check(checkCode("comprar con el Mandato vencido", refused.code, ["MandateExpired"]));
    record.check(checkThat("no se pagó ni se desplegó rail", refused.transaction_hash === null && after.rail === null, "sin transacción, rail null", after.rail?.contract_id ?? "rail null"));
    // This account has no RealOps agent, so "Mis servicios" has no tenant to show: the page half runs in day2.
    await checkExplained(record, null, refused);
  });
}

/** F, day 1: a Mandate signed from RealOps with the shortest validity RealOps allows. */
async function prepareDay2(): Promise<void> {
  const f = newPersona("F");
  await runCase("F0", "Preparación de la corrida de mañana: Mandato de 1 día firmado desde RealOps", "F", async (record) => {
    const ctx = await setupPersona(f, "market_brief", { perTx: "0.30", perDay: "0.60", validForDays: 1 }, record);
    const mandates = await v1("GET", `/v1/mandates?tenant_id=${encodeURIComponent(ctx.tenantId)}`, mandatesSchema);
    const mandate = mandates.find((row) => row.id === ctx.signed.mandateId);
    if (mandate === undefined) throw new AgentPassError("CommandFailed", "AgentPey does not list the Mandate just signed", { details: { mandateId: ctx.signed.mandateId } });
    const state = day2StateSchema.parse({
      runId: RUN_ID,
      email: f.email,
      agentId: ctx.agentId,
      mandateId: ctx.signed.mandateId,
      tenantId: ctx.tenantId,
      validUntil: new Date(mandate.valid_until).toISOString(),
    });
    await writeFile(DAY2_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
    record.note("state", state);
    record.check(checkThat("estado de mañana guardado (sin secretos)", true, DAY2_STATE_PATH, `vence ${state.validUntil}`));
  });
}

/** F, day 2: the RealOps path to an expired Mandate, a day later. */
async function runDay2(): Promise<void> {
  const raw = await readFile(DAY2_STATE_PATH, "utf8").catch((error: unknown) => {
    throw new AgentPassError("ConfigError", "no day2 state — run the day1 phase first", { cause: error, details: { path: DAY2_STATE_PATH } });
  });
  const parsed = day2StateSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new AgentPassError("ConfigError", "the day2 state file does not match the expected shape", { details: { path: DAY2_STATE_PATH } });
  const state = parsed.data;
  // Checked before anything touches a service: running early must spend nothing.
  if (Date.now() < new Date(state.validUntil).getTime() + 60_000) {
    throw new AgentPassError("ConfigError", `the Mandate is still valid until ${state.validUntil} — run --phase=day2 after that`, {
      details: { mandateId: state.mandateId },
    });
  }
  const f = newPersona("F", state.email);

  await runCase("6d", "Mandato vencido firmado desde RealOps, un día después", "F", async (record) => {
    record.note("state", state);
    await signIn(f);
    const agentPage = await http("GET", `${REALOPS}/agentes/${state.agentId}`, { jar: f.jar });
    const stored = readSignedMandateId(agentPage.text);
    record.check(checkThat("un día después, el agente conserva su Mandato", stored === state.mandateId, state.mandateId, stored ?? "(nada)"));

    const before = await activityOf(state.tenantId);
    const asked = await buy(f, ASK_BRIEF);
    const after = await activityOf(state.tenantId);
    const fresh = newPurchases(before, after);
    record.note("realops", { status: asked.status, location: asked.location, body: isRedirect(asked) ? undefined : asked.text.slice(0, 400) });
    record.note("purchases", fresh);
    record.check(checkCode("comprar con el Mandato vencido", fresh[0]?.code, ["MandateExpired"]));
    record.check(checkThat("no se pagó ni se desplegó rail", fresh.length > 0 && unpaid(fresh) && after.rail === null, "rechazo sin transacción", summarise(fresh)));
    await checkExplained(record, f, fresh[0]);
  });
}

// ---- Main -------------------------------------------------------------------

const args = parseAcceptanceArgs(process.argv.slice(2));
const wants = (persona: PersonaId): boolean => args.only === null || args.only.includes(persona);
const startedAt = new Date();
await mkdir(OUT_DIR, { recursive: true });

process.stdout.write(`F9 acceptance · ${args.phase} · run ${RUN_ID}\nweb ${WEB}\nrealops ${REALOPS}\nsignaldesk ${SIGNALDESK}\n`);

await wake();

if (args.phase === "day1") {
  const expiring = wants("E") ? await prepareExpiring() : undefined;
  if (wants("B")) await personaB();
  if (wants("D")) await personaD();
  if (wants("C")) await personaC();
  if (wants("A")) await personaA();
  if (wants("F")) await prepareDay2();
  if (expiring !== undefined) await finishExpiring(expiring);
  await runCase("5", "Factura 402 con precio distinto", null, async (record) => {
    record.check(
      declared(
        "precio de la factura distinto del de la intención (TermsAmountMismatch)",
        "apps/agent/src/policy/terms.test.ts:89, :101 y :111; apps/agent/src/payment/x402.test.ts:199",
      ),
    );
  });
} else {
  await runDay2();
}

const allChecks = results.flatMap((result) => result.checks);
const totals = tally(allChecks);
const evidencePath = resolve(OUT_DIR, `${args.phase}-${RUN_ID}.json`);
const evidence = {
  runId: RUN_ID,
  phase: args.phase,
  only: args.only,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  services: { web: WEB, realops: REALOPS, signaldesk: SIGNALDESK },
  totals,
  results,
};
const secrets = [API_KEY, env.get("DATABASE_URL") ?? "", env.get("ISSUER_SECRET_KEY") ?? "", env.get("AGENT_SECRET_KEY") ?? ""];
await writeFile(evidencePath, `${redact(JSON.stringify(evidence, null, 2), secrets)}\n`);

process.stdout.write(`\n${totals.pass} ✓ · ${totals.fail} ✗ · ${totals.declared} declarados\nevidencia: ${evidencePath}\n`);
for (const result of results) {
  const failed = result.checks.filter((check) => check.status === "fail");
  if (failed.length === 0) continue;
  process.stdout.write(`\n✗ ${result.id} · ${result.title}\n`);
  for (const check of failed) process.stdout.write(`    ${check.name}: esperado ${check.expected} · observado ${check.observed}\n`);
}
process.exitCode = totals.fail > 0 ? 1 : 0;
