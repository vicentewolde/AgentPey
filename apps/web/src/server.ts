#!/usr/bin/env node
/**
 * `pnpm run web` — T25, the simple frontend.
 *
 * A Node server (no framework — `node:http` is enough for five routes) that
 * wraps exactly what T9–T24 already built, and a static page with no build
 * step. Every secret (`ISSUER_SECRET_KEY`, `AGENT_SECRET_KEY`) stays here;
 * the browser only ever sees JSON responses.
 *
 * One demo session per browser, held in memory and keyed by a cookie — this
 * is still not a real multi-tenant app (every session signs with the same
 * `AGENT_SECRET_KEY`/`ISSUER_SECRET_KEY`, so two visitors share one Stellar
 * identity), but two people clicking through the demo at the same time no
 * longer stomp on each other's in-memory state or spend ledger. Clicking
 * "Iniciar" issues a fresh credential and Mandate, exactly like `pnpm demo`
 * does on every run.
 *
 * T34 adds real wallet-connect: a visitor who signs a one-time challenge
 * with Freighter (SEP-0053, verified server-side without ever seeing their
 * secret key) gets a cookie derived from their wallet address instead of a
 * random one, so the same wallet reconnecting lands on the same MandateVault
 * `tenant_id`. Since T35, that connected wallet also signs its own Mandate
 * — see `wallet-session-store.ts` for where that flow's state lives (T69,
 * `G12`).
 *
 * The one product this can actually pay for is `swap-risk-quote` — the same
 * one `scripts/demo-real-payment.ts` (T24) proved end to end. The catalogue
 * shows the bazaar's other real products too, read-only, rather than
 * pretending every one of them is a verified payment path.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CredentialRequest, Scope } from "@agentpass/core";
import {
  AgentPassError,
  credentialRequestSchema,
  isAgentPassError,
  stellarAddressToDid,
  verifyStellarMessage,
} from "@agentpass/core";
import { createAgentPass, type AgentPass, type CredStatus } from "@agentpass/sdk";
import { Keypair, Networks } from "@stellar/stellar-sdk";

import { createDirectory, type ConsentSessionRecord, type Directory, type MandateRecord } from "@agentpey/directory";
import {
  agentPayMandateSchema,
  anchorMandate,
  grantToScope,
  mandateChallengeMessage,
  mandateGrantSchema,
  prepareWalletAnchor,
  prepareWalletRevoke,
  revokeMandate,
  walletMandateHash,
  type AgentPayMandate,
} from "@agentpey/mandate";
import { createPostgresMandateVault, type MandateVault } from "@agentpey/vault";
import { AUTHORIZATION_HEADER, computeConsentSessionStatus, IDEMPOTENCY_KEY_HEADER } from "@agentpey/partner-api";

import type { Agent, CatalogAdapter, CreatePurchaseIntentResult, MandateSource, VenueId } from "@agentpey/agent";
import {
  anchorPaymentDecision,
  createAgent,
  createBazaarCatalog,
  createLocalPolicyRail,
  createOnChainMandateVerifier,
  executeBazaarPayment,
  fillRouteTemplate,
  getBazaarServiceRoute,
  interpretPurchase,
  verifyIntent,
  withVault,
  type PolicyRail,
  type PolicyRailPayer,
  readRailUsdcBalance,} from "@agentpey/agent";

import { readEnv as readEnvFrom, requireEnv, requireSecretKey } from "./env.js";
import { createPublicDiscovery, handleDiscoverySearch } from "./discovery-route.js";
import { createIssuerRegistrationLimiter } from "./issuer-registration-limit.js";
import { log, logError } from "./logging.js";
import { routePartnerRequest } from "./partner-routes.js";
import { createPostgresPendingWriteStore, type PostgresPendingWriteStore } from "./pending-write-store.js";
import {
  proveOwnership,
  readPublicView,
  requireRevocable,
  toPrivateView,
} from "./revocation.js";
import { decideRehydration } from "./session-rehydration.js";
import { buildSessionDocuments } from "./session-documents.js";
import { ensureSharedPayerIdentity, ensureVisitorTenant } from "./shared-identity.js";
import { ensureTenantAgent } from "./tenant-agent.js";
import { ensureTenantPolicyRail } from "./tenant-rail.js";
import { executeTenantPurchase } from "./tenant-purchase.js";
import { readTenantActivity } from "./tenant-activity.js";
import {
  createPostgresWalletSessionStore,
  type PendingConsentSessionPayload,
  type PendingWalletSessionPayload,
  type WalletSessionStore,
} from "./wallet-session-store.js";
import {
  PENDING_WALLET_SESSION_TTL_MS,
  SESSION_COOKIE,
  WALLET_CHALLENGE_TTL_MS,
  challengeMessage,
  isValidSessionId,
  parseCookies,
} from "./wallet-session.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const ENV_PATH = resolve(REPO_ROOT, ".env.local");
const SCOPE_PATH = resolve(REPO_ROOT, "examples/scope-stellar-bazaar.json");
const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));

const DEFAULT_BAZAAR_BASE_URL = "https://stellar-bazaar-x402.vercel.app";
const CREDENTIAL_VALID_DAYS = 1;
const PAYABLE_PRODUCT_ID = "swap-risk-quote";
const ROUTE_PARAMS = { pair: "XLM/USDC", amount: 100, side: "buy" };
const PORT = Number(process.env.PORT ?? 8787);

const TESTNET = {
  network: "testnet",
  passphrase: Networks.TESTNET,
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
} as const;

/**
 * What the session needs of its own Mandate — deliberately without `.jws`,
 * unlike `AnchoredMandate` (`@agentpey/mandate`): a wallet-anchored mandate
 * has no JWS at all (T35), and everything here reads identically whichever
 * path produced it. `principalAddress` and `signature` are what a later
 * revoke needs to know whether it must go through the wallet-signed path
 * too — `signature` is `undefined` for a platform-signed mandate.
 */
interface DemoSessionMandate {
  readonly hash: string;
  readonly mandate: AgentPayMandate;
  readonly transactionHash: string;
  readonly principalAddress: string;
  readonly signature: string | undefined;
}

interface DemoSession {
  readonly agentpass: AgentPass;
  readonly agent: Agent;
  readonly catalog: CatalogAdapter;
  readonly policyRail: PolicyRail;
  readonly vault: MandateVault;
  readonly scope: Scope;
  readonly mandate: DemoSessionMandate;
  readonly credentialHash: string;
  /**
   * The agent's own identity — the credential subject, the Mandato's
   * `agent`, and the purchase-intent signer. Since F4 (T40) this is the
   * tenant's own derived key on the wallet path, not the shared
   * `AGENT_SECRET_KEY` — see `tenant-agent.ts`. The classic path still uses
   * the shared key here, unchanged (`C-34`).
   */
  readonly agentSecret: string;
  /**
   * Who actually pays — `signerSecret`/`policy_rail` owner in `buy()`.
   * Always the shared `AGENT_SECRET_KEY` today, on both paths: F4 only
   * separates *identity* from *payment*, it does not yet give any tenant its
   * own funded account (F6's job, `C-20`). Deliberately its own field rather
   * than reusing `agentSecret`, so that day's change is additive here, not a
   * rename.
   */
  readonly paymentSecret: string;
  readonly issuerSecret: string;
  readonly baseUrl: string;
  readonly venueId: VenueId;
  /** The connected wallet that is this session's mandate principal, if any (T35). Absent is the classic, platform-signed path. */
  readonly walletAddress: string | undefined;
  /**
   * The **shared, classic-path** `policy_rail` (`POLICY_RAIL_CONTRACT_ID`,
   * written by `pnpm run deploy:policy-rail`) — used only when there is no
   * wallet-connected tenant to own a rail of its own (`C-34`). A
   * wallet-connected session resolves its own rail lazily in `buy()`
   * (`ensureTenantPolicyRail`, F6/T58) instead of reading this field.
   */
  readonly railContractId: string | undefined;
  /** This tenant's own `directory_agents` row id (F4/T40) — `undefined` on the classic, no-wallet path. */
  readonly tenantAgentId: string | undefined;
}

const sessions = new Map<string, DemoSession>();

// ---- Wallet connect (T34), wallet-signed Mandate (T35), hosted consent
// sessions (T51) — all on Postgres since T69 (`G12`). `PendingWalletSession`/
// `PendingConsentSession`'s payload shapes live in `wallet-session-store.ts`
// now, not here — see that file's own docstring for why neither carries a
// secret (`C-69` traced every field that used to look like one).

/**
 * Same memoised-pool pattern as `getDirectory`/`getPendingWriteStore`: one
 * `Pool`, reused across requests, opened the first time any of the wallet
 * flow's Postgres-backed state is touched.
 */
let walletSessionStorePromise: Promise<WalletSessionStore> | undefined;
function getWalletSessionStore(env: ReadonlyMap<string, string>): Promise<WalletSessionStore> {
  walletSessionStorePromise ??= createPostgresWalletSessionStore({ connectionString: requireEnv(env, "DATABASE_URL") });
  return walletSessionStorePromise;
}

/**
 * Server-wide across every session, on purpose (`G10`/`C-63`): the thing
 * being bounded is how many Soroban writes the admin key pays for in a
 * stretch of time, not how many any one visitor asks for.
 */
const issuerRegistrationLimiter = createIssuerRegistrationLimiter();

/**
 * Anchoring a mandate under a wallet's address needs that address to be a
 * registered, active issuer first — the contract's own rule (`M-17`),
 * unchanged since T20. A wallet that just proved it controls its address
 * (T34) gets registered automatically, no manual approval step: this pilot
 * treats "connected and verified" as sufficient trust, a deliberate choice
 * for a testnet demo, not a production policy (`docs/fase-6-agentguard-comercializacion/DECISIONES.md`
 * → `C-15`). `G10` flagged the unbounded cost of that choice — anyone can
 * mint a fresh keypair for free and make the admin key pay for registering
 * it — so `issuerRegistrationLimiter` caps how many of these the admin key
 * will fund per window (`C-63`), without adding the approval step `C-15`
 * deliberately chose not to have yet.
 *
 * @throws AgentPassError `IssuerRegistrationRateLimited` if the server-wide
 * cap for this window is already spent.
 */
async function ensureWalletIsRegisteredIssuer(
  agentpass: AgentPass,
  env: ReadonlyMap<string, string>,
  walletAddress: string,
): Promise<void> {
  const existing = await agentpass.issuerStatus(walletAddress);
  if (existing.registered && existing.active) return;
  // Checked only once a real registration is actually needed — a wallet
  // that is already registered never touches the cap, no matter how often
  // it reconnects.
  issuerRegistrationLimiter.consume();
  // Read the admin key here rather than at session start: only a wallet that
  // is not registered yet needs it at all, so one already registered keeps
  // working even if `ADMIN_SECRET_KEY` is unset or wrong on this deploy.
  const admin = requireSecretKey(env, "ADMIN_SECRET_KEY");
  const metaHash = createHash("sha256").update(walletAddress, "utf8").digest("hex");
  await agentpass.registerIssuer({ admin, issuer: walletAddress, metaHash });
}

function readSessionId(req: IncomingMessage): string | undefined {
  const raw = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
  return isValidSessionId(raw) ? raw : undefined;
}

function getSession(req: IncomingMessage): DemoSession | undefined {
  const sessionId = readSessionId(req);
  return sessionId === undefined ? undefined : sessions.get(sessionId);
}

function withSessionCookie(res: ServerResponse, sessionId: string): void {
  res.setHeader("set-cookie", `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax`);
}

async function readScope(): Promise<CredentialRequest> {
  const raw = await readFile(SCOPE_PATH, "utf8").catch((error: unknown) => {
    throw new AgentPassError("ConfigError", `could not read ${SCOPE_PATH}`, { cause: error });
  });
  const parsed = credentialRequestSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new AgentPassError("ConfigError", `${SCOPE_PATH} does not match the expected shape`, {
      details: { issues: parsed.error.issues.map((issue) => issue.message) },
    });
  }
  return parsed.data;
}

/** This server's own `.env.local`, with `process.env` behind it — see `env.ts`. */
function readEnv(): Promise<Map<string, string>> {
  return readEnvFrom(ENV_PATH);
}

/**
 * This deployment's own origin — the first time `apps/web` has needed to
 * refer to itself rather than to Stellar or the bazaar. `PUBLIC_BASE_URL`
 * is the explicit override (set once on Render); without it, the `Host`
 * header (and `X-Forwarded-Proto` behind a reverse proxy) is what's actually
 * true of the request that arrived, which is right for local dev too.
 */
function resolveBaseUrl(req: IncomingMessage, env: ReadonlyMap<string, string>): string {
  const configured = env.get("PUBLIC_BASE_URL");
  if (configured !== undefined && configured.length > 0) return configured.replace(/\/+$/, "");

  const host = req.headers.host ?? `localhost:${PORT}`;
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto =
    typeof forwardedProto === "string"
      ? (forwardedProto.split(",")[0] ?? "https")
      : host.startsWith("localhost") || host.startsWith("127.0.0.1")
        ? "http"
        : "https";
  return `${proto}://${host}`;
}

// ---- Persistent directory (T39) --------------------------------------------

/**
 * Held across requests, unlike `agentpass`/the vault above (each of those is
 * rebuilt per request — not touched here, out of scope for this milestone).
 * A `Directory`'s `Pool` is meant to outlive a single request the way any
 * connection pool is; recreating it per call would re-run the thirteen
 * `create table if not exists` statements on every single API call for no
 * benefit. One promise, memoised: the first caller pays for opening the pool
 * and initialising the schema, everyone after just awaits the same result.
 */
let directoryPromise: Promise<Directory> | undefined;
function getDirectory(env: ReadonlyMap<string, string>): Promise<Directory> {
  directoryPromise ??= createDirectory({ connectionString: requireEnv(env, "DATABASE_URL") });
  return directoryPromise;
}

/**
 * Same memoised-pool shape as `getDirectory` — one `Pool` per process,
 * reused across requests. Unlike `agentpass` itself (rebuilt per request,
 * see below), this is what actually needs to persist: it is the shared
 * storage that lets a `prepareAnchor`/`prepareRevoke` on one process finish
 * with `submitSigned` on another (T67/T68, G12).
 */
let pendingWriteStorePromise: Promise<PostgresPendingWriteStore> | undefined;
function getPendingWriteStore(env: ReadonlyMap<string, string>): Promise<PostgresPendingWriteStore> {
  pendingWriteStorePromise ??= createPostgresPendingWriteStore({ connectionString: requireEnv(env, "DATABASE_URL") });
  return pendingWriteStorePromise;
}

/**
 * A fresh `AgentPass` for the wallet two-phase write (`prepareAnchor`/
 * `prepareRevoke`/`submitSigned`) — deliberately not the same instance
 * `startSession`/`startConsentSession` built when the flow began. G12: the
 * old code kept that original instance alive in `PendingWalletSession`/
 * `PendingConsentSession` for exactly this reason, which is what tied the
 * whole flow to one process. With a shared `PendingWriteStore` behind it,
 * any instance built from the same config can finish what another started.
 */
async function createWalletAgentPass(env: ReadonlyMap<string, string>): Promise<AgentPass> {
  const contractId = requireEnv(env, "AGENT_REGISTRY_CONTRACT_ID");
  const pendingWriteStore = await getPendingWriteStore(env);
  return createAgentPass(
    { contractId, rpcUrl: TESTNET.rpcUrl, networkPassphrase: TESTNET.passphrase, network: TESTNET.network },
    { pendingWriteStore },
  );
}

interface FinishSessionParams {
  readonly sessionId: string;
  readonly env: ReadonlyMap<string, string>;
  readonly agentpass: AgentPass;
  readonly agentKeypair: Keypair;
  /** Who pays — see `DemoSession.paymentSecret`'s docstring. Equals `agentKeypair.secret()` on the classic path. */
  readonly paymentSecret: string;
  readonly demoScope: CredentialRequest;
  readonly baseUrl: string;
  readonly issuedCredentialJws: string;
  readonly credentialHash: string;
  readonly issuerSecret: string;
  readonly mandate: DemoSessionMandate;
  readonly mandateSource: MandateSource;
  readonly walletAddress: string | undefined;
  /** This tenant's own `directory_agents` row id (F4/T40) — `undefined` on the classic, no-wallet path, which has no tenant row at all. */
  readonly tenantAgentId: string | undefined;
}

/**
 * The part of starting a session that never differs between a classic
 * (platform-signed) Mandate and a wallet-signed one (T35): the catalogue,
 * the vault, `PolicyRail`, and the agent itself only ever need a
 * `MandateSource` the agent's own `MandateVerifier` can re-check — they do
 * not know or care which kind produced it.
 */
async function finishSession(params: FinishSessionParams): Promise<DemoSession> {
  const catalog = createBazaarCatalog({ baseUrl: params.baseUrl });
  // Same vault backs both PolicyRail instances (G-5, T24) — the two
  // authorise() calls a purchase makes (structural, then against the real
  // 402) record the same intentId once, not twice. A MandateVault satisfies
  // SpendLedger structurally (T27), so it drops in wherever the ledger did;
  // withVault additionally keeps every refusal, not just every grant.
  const vault = await createPostgresMandateVault({
    connectionString: requireEnv(params.env, "DATABASE_URL"),
    tenantId: params.sessionId,
  });
  const policyRail = withVault(createLocalPolicyRail({ ledger: vault }), vault);

  const agent = await createAgent({
    credential: params.issuedCredentialJws,
    mandate: params.mandateSource,
    catalog,
    verifier: params.agentpass,
    mandateVerifier: createOnChainMandateVerifier(params.agentpass),
    signer: params.agentKeypair,
    ledger: vault,
    policyRail,
  });

  return {
    agentpass: params.agentpass,
    agent,
    catalog,
    policyRail,
    vault,
    scope: params.demoScope.scope,
    mandate: params.mandate,
    credentialHash: params.credentialHash,
    agentSecret: params.agentKeypair.secret(),
    paymentSecret: params.paymentSecret,
    issuerSecret: params.issuerSecret,
    baseUrl: params.baseUrl,
    venueId: catalog.venueId,
    walletAddress: params.walletAddress,
    railContractId: params.env.get("POLICY_RAIL_CONTRACT_ID"),
    tenantAgentId: params.tenantAgentId,
  };
}

export type StartSessionResult =
  | { readonly kind: "ready"; readonly session: DemoSession }
  | { readonly kind: "pending-wallet-consent"; readonly credentialHash: string; readonly challengeMessage: string };

/**
 * Mirrors `pnpm demo`'s step 2: issue a credential, then a Mandate with its
 * own (tighter) perDay. The credential's issuer is always the platform
 * (`ISSUER_SECRET_KEY`) — but if this session has a wallet connected and
 * verified (T34), the Mandate's principal becomes that wallet instead of the
 * platform, and this returns `"pending-wallet-consent"` rather than a
 * finished session: only the wallet itself can sign its own consent and its
 * own anchor transaction, which cannot happen inside this one request.
 * `/api/session/wallet-consent` and `/api/session/wallet-anchor` finish it.
 */
/**
 * Rebuilds a `DemoSession`'s mandate half from what the directory persisted
 * — the piece rehydration needs and issuing a fresh Mandate produces fresh,
 * so it only exists on this path. Parses `document` back through
 * `agentPayMandateSchema` rather than trusting the stored `Record<string,
 * unknown>` blindly: the directory only promises to store bytes faithfully
 * (`C-5`'s `json`-not-`jsonb` reasoning), not that they still describe a
 * well-formed Mandate.
 *
 * @throws AgentPassError `ConfigError` if the stored document does not parse,
 * or if a wallet-signed mandate record is missing its signature — either
 * would mean this row was never actually completed, which should be
 * unreachable (`recordMandate` is only ever called after a real SEP-0053
 * signature came back), but a rehydration path must fail loud rather than
 * silently hand a purchase engine a mandate that cannot be used.
 */
function mandateFromRecord(
  record: MandateRecord,
  walletAddress: string,
): { readonly mandate: DemoSessionMandate; readonly mandateSource: MandateSource } {
  const parsed = agentPayMandateSchema.safeParse(record.document);
  if (!parsed.success) {
    throw new AgentPassError("ConfigError", "a persisted mandate's document does not match the expected shape", {
      details: { mandateHash: record.mandateHash, issues: parsed.error.issues.map((issue) => issue.message) },
    });
  }
  if (record.signature === null) {
    throw new AgentPassError("ConfigError", "a persisted wallet-signed mandate is missing its signature", {
      details: { mandateHash: record.mandateHash },
    });
  }
  return {
    mandate: {
      hash: record.mandateHash,
      mandate: parsed.data,
      transactionHash: record.anchorTx,
      principalAddress: walletAddress,
      signature: record.signature,
    },
    mandateSource: { mandate: parsed.data, signature: record.signature },
  };
}

async function startSession(sessionId: string): Promise<StartSessionResult> {
  const env = await readEnv();
  const issuer = requireSecretKey(env, "ISSUER_SECRET_KEY");
  const issuerSecret = issuer.secret();
  const agentKeypair = requireSecretKey(env, "AGENT_SECRET_KEY");
  const contractId = requireEnv(env, "AGENT_REGISTRY_CONTRACT_ID");
  const baseUrl = env.get("BAZAAR_BASE_URL") ?? DEFAULT_BAZAAR_BASE_URL;

  const [agentpass, demoScope] = await Promise.all([
    createAgentPass({
      contractId,
      rpcUrl: TESTNET.rpcUrl,
      networkPassphrase: TESTNET.passphrase,
      network: TESTNET.network,
    }),
    readScope(),
  ]);

  const now = new Date();
  const walletSessionStore = await getWalletSessionStore(env);
  const walletAddress = await walletSessionStore.getWalletAddressForSession(sessionId);

  if (walletAddress !== undefined) {
    // T39: `sessionId` is this tenant's own id in `@agentpey/directory`
    // (set by `/api/wallet/verify`) — check whether it already has a live
    // credential and mandate before issuing anything new. This is the check
    // that makes "volver desde otro navegador" not mint a fresh identity.
    const directory = await getDirectory(env);

    // F4 (T40): this tenant's own derived identity — the credential subject,
    // the Mandato's `agent`, the intent signer. `AGENT_SECRET_KEY` (read as
    // `agentKeypair` above) stops being anyone's identity from here on; it
    // only pays (`tenant-agent.ts`'s docstring explains why that split is
    // safe). Resolved before the rehydrate/issue decision because both
    // branches need it — rehydrating still has to reconstruct `agentKeypair`
    // for `finishSession`, and it must be *this* tenant's key, not the
    // shared one, or `createAgent()`'s own subject/signer check (fail-closed
    // by construction) would refuse the session outright.
    const masterMnemonic = requireEnv(env, "MASTER_MNEMONIC");
    const tenantAgent = await ensureTenantAgent(directory, masterMnemonic, sessionId);
    const paymentSecret = agentKeypair.secret();

    const [latestCredential, activeMandates, latestMandate] = await Promise.all([
      directory.findLatestCredential(sessionId),
      directory.listActiveMandates(sessionId, now),
      directory.findLatestMandate(sessionId),
    ]);
    const decision = decideRehydration({
      latestCredential,
      activeMandates,
      latestMandate,
      currentAgentId: tenantAgent.instance.id,
    });

    if (decision.kind === "rehydrate") {
      const { mandate, mandateSource } = mandateFromRecord(decision.mandate, walletAddress);
      const session = await finishSession({
        sessionId,
        env,
        agentpass,
        agentKeypair: tenantAgent.keypair,
        paymentSecret,
        demoScope,
        baseUrl,
        issuedCredentialJws: decision.credential.jws,
        credentialHash: decision.credential.credentialHash,
        issuerSecret,
        mandate,
        mandateSource,
        walletAddress,
        tenantAgentId: tenantAgent.instance.id,
      });
      return { kind: "ready", session };
    }

    // No active mandate for this tenant — issue fresh documents, same as
    // before T39, carrying `decision.supersedes` so `wallet-anchor` can
    // record the new mandate as a renewal rather than an orphan. Named as
    // this tenant's own derived identity (`tenantAgent.keypair`), not the
    // shared `AGENT_SECRET_KEY` — the change F4 makes.
    const { credential, mandate: mandateDocument } = buildSessionDocuments({
      issuerAddress: issuer.publicKey(),
      agentAddress: tenantAgent.keypair.publicKey(),
      walletAddress,
      scope: demoScope,
      registryContractId: agentpass.config.contractId,
      now,
      validUntil: new Date(now.getTime() + CREDENTIAL_VALID_DAYS * 24 * 60 * 60 * 1000),
    });
    const issued = await agentpass.issue({ credential, issuer });

    // A wallet is connected — it must anchor its own Mandate as issuer,
    // which needs it registered first (`M-17`, automated here — `C-8`).
    await ensureWalletIsRegisteredIssuer(agentpass, env, walletAddress);

    await walletSessionStore.setPendingWalletSession(
      sessionId,
      {
        issuedCredentialJws: issued.jws,
        credentialHash: issued.hash,
        credentialAnchorTx: issued.transactionHash,
        credential,
        mandate: mandateDocument,
        walletAddress,
        demoScope,
        baseUrl,
        supersedesId: decision.supersedes?.id,
      },
      PENDING_WALLET_SESSION_TTL_MS,
    );

    return { kind: "pending-wallet-consent", credentialHash: issued.hash, challengeMessage: mandateChallengeMessage(mandateDocument) };
  }

  // Classic (platform-signed) path — unchanged since T35, including its
  // identity: it still uses the shared `AGENT_SECRET_KEY` for everything.
  // F4 only gives *wallet* sessions their own derived identity — the classic
  // path has no wallet to anchor a distinct one to, the same reason `C-34`
  // already gives for why it stays unpersisted.
  const { credential, mandate: mandateDocument } = buildSessionDocuments({
    issuerAddress: issuer.publicKey(),
    agentAddress: agentKeypair.publicKey(),
    walletAddress: undefined,
    scope: demoScope,
    registryContractId: agentpass.config.contractId,
    now,
    validUntil: new Date(now.getTime() + CREDENTIAL_VALID_DAYS * 24 * 60 * 60 * 1000),
  });
  const issued = await agentpass.issue({ credential, issuer });
  const anchoredMandate = await anchorMandate(agentpass, { mandate: mandateDocument, principal: issuer });
  const session = await finishSession({
    sessionId,
    env,
    agentpass,
    agentKeypair,
    paymentSecret: agentKeypair.secret(),
    demoScope,
    baseUrl,
    issuedCredentialJws: issued.jws,
    credentialHash: issued.hash,
    issuerSecret,
    mandate: {
      hash: anchoredMandate.hash,
      mandate: anchoredMandate.mandate,
      transactionHash: anchoredMandate.transactionHash,
      principalAddress: issuer.publicKey(),
      signature: undefined,
    },
    mandateSource: anchoredMandate.jws,
    walletAddress: undefined,
    tenantAgentId: undefined,
  });
  return { kind: "ready", session };
}

interface StartConsentSessionResult {
  readonly pending: "wallet-consent";
  readonly credentialHash: string;
  readonly challengeMessage: string;
}

/**
 * The consent-session analogue of `startSession`'s wallet branch, without
 * `finishSession`: this never buys anything, so it never needs a catalogue,
 * a vault, or a `PolicyRail` — only the credential and the unsigned Mandate,
 * built from the partner's own proposed grant instead of the demo's
 * `scope-stellar-bazaar.json`.
 *
 * @throws AgentPassError `ConfigError` if no wallet has verified control yet
 * (`/api/consent/{id}/wallet-verify` first).
 * @throws AgentPassError `ConsentSessionNotFound`, `ConsentSessionExpired`,
 * `ConsentSessionAlreadyCompleted` — the three ways this invitation can be
 * unusable.
 */
async function startConsentSession(consentSessionId: string): Promise<StartConsentSessionResult> {
  const env = await readEnv();
  const walletSessionStore = await getWalletSessionStore(env);
  const walletAddress = await walletSessionStore.getWalletAddressForConsentSession(consentSessionId);
  if (walletAddress === undefined) {
    throw new AgentPassError("ConfigError", "conectá la wallet primero", { details: { consentSessionId } });
  }

  const directory = await getDirectory(env);
  const session = await directory.findConsentSession(consentSessionId);
  if (session === undefined) {
    throw new AgentPassError("ConsentSessionNotFound", "no existe esa invitación", { details: { consentSessionId } });
  }
  if (session.status !== "pending") {
    throw new AgentPassError("ConsentSessionAlreadyCompleted", "esta invitación ya se firmó", { details: { consentSessionId } });
  }
  const now = new Date();
  if (now > session.expiresAt) {
    throw new AgentPassError("ConsentSessionExpired", "esta invitación venció", { details: { consentSessionId } });
  }

  const tenant = await directory.findTenant(session.tenantId);
  if (tenant === undefined) {
    // The session's own foreign key guarantees this — reaching here would
    // mean the directory's referential integrity broke.
    throw new AgentPassError("TenantNotFound", "el tenant de esta invitación ya no existe", { details: { consentSessionId } });
  }
  const partner = await directory.findPartner(tenant.partnerId);
  if (partner === undefined) {
    throw new AgentPassError("PartnerNotFound", "el partner de esta invitación ya no existe", { details: { consentSessionId } });
  }

  const issuer = requireSecretKey(env, "ISSUER_SECRET_KEY");
  const contractId = requireEnv(env, "AGENT_REGISTRY_CONTRACT_ID");
  const masterMnemonic = requireEnv(env, "MASTER_MNEMONIC");
  const agentpass = await createAgentPass({
    contractId,
    rpcUrl: TESTNET.rpcUrl,
    networkPassphrase: TESTNET.passphrase,
    network: TESTNET.network,
  });
  const tenantAgent = await ensureTenantAgent(directory, masterMnemonic, session.tenantId);

  // Validated here, not trusted from storage: `@agentpey/directory` stores
  // `grant` unvalidated by design (`C-5`-style separation of storing from
  // judging) — this is the point where it is actually about to be signed
  // into a real Mandate, so it is the point that has to be sure.
  const grant = mandateGrantSchema.parse(session.grant);
  // The credential's `scope` is a plain `Scope` — it cannot carry `payTo`
  // (`M-14`) or `products` (`C-75`) — so it gets the grant minus both, via
  // `grantToScope`; the Mandate gets the grant exactly as the partner
  // proposed it.
  const scopeOnly = grantToScope(grant);

  const { credential, mandate: mandateDocument } = buildSessionDocuments({
    issuerAddress: issuer.publicKey(),
    agentAddress: tenantAgent.keypair.publicKey(),
    walletAddress,
    scope: {
      agent: { name: `consent-${session.id}`, model: "partner-managed", operator: partner.name },
      scope: scopeOnly,
    },
    grant,
    registryContractId: agentpass.config.contractId,
    now,
    validUntil: session.validUntil,
  });
  const issued = await agentpass.issue({ credential, issuer });

  await ensureWalletIsRegisteredIssuer(agentpass, env, walletAddress);

  await walletSessionStore.setPendingConsentSession(
    consentSessionId,
    {
      issuedCredentialJws: issued.jws,
      credentialHash: issued.hash,
      credentialAnchorTx: issued.transactionHash,
      credential,
      mandate: mandateDocument,
      walletAddress,
      tenantId: session.tenantId,
    },
    PENDING_WALLET_SESSION_TTL_MS,
  );

  return { pending: "wallet-consent", credentialHash: issued.hash, challengeMessage: mandateChallengeMessage(mandateDocument) };
}

interface Step {
  readonly label: string;
  readonly value: string;
}

/**
 * Which `policy_rail` pays for this session, and whose key authorises it
 * (F6/T58). A wallet-connected session gets its own — deployed lazily, right
 * here, the first time it actually pays — because it has a real tenant
 * identity (`tenantAgentId`) and a real bound wallet (`walletAddress`) to be
 * `owner` and `principal` with. The classic, no-wallet demo path (`C-34`) has
 * neither, so it keeps paying from the shared rail, exactly as before F6.
 */
async function resolveRailPayer(current: DemoSession): Promise<PolicyRailPayer> {
  if (current.tenantAgentId !== undefined && current.walletAddress !== undefined) {
    const env = await readEnv();
    const directory = await getDirectory(env);
    const agentInstance = await directory.findAgent(current.tenantAgentId);
    if (agentInstance === undefined) {
      throw new AgentPassError("AgentNotFound", "esta sesión no tiene un agente propio para desplegar su rail", {
        details: { tenantAgentId: current.tenantAgentId },
      });
    }
    const reserve = requireSecretKey(env, "AGENT_SECRET_KEY");
    const wasmHash = requireEnv(env, "POLICY_RAIL_WASM_HASH");
    const contractId = await ensureTenantPolicyRail(
      directory,
      { instance: agentInstance, keypair: Keypair.fromSecret(current.agentSecret) },
      current.walletAddress,
      reserve,
      wasmHash,
      readRailUsdcBalance,
    );
    // The tenant's own key is both the Mandato's agent and this rail's
    // `owner` — never `paymentSecret` (`AGENT_SECRET_KEY`), which the
    // deployed contract does not recognise as its owner.
    return { contractId, ownerSecret: current.agentSecret };
  }

  if (current.railContractId === undefined) {
    throw new AgentPassError(
      "ConfigError",
      "no hay ningún policy_rail desplegado — corré `pnpm run deploy:policy-rail` primero",
      { details: { missing: "POLICY_RAIL_CONTRACT_ID" } },
    );
  }
  return { contractId: current.railContractId, ownerSecret: current.paymentSecret };
}

/**
 * Mirrors `pnpm run demo:pay-real`'s steps 3-5: sign the intent, then pay for
 * real. With `viaRail`, the `policy_rail` smart account pays instead of the
 * agent's classic account (T31) — same intent, same authorisation, same
 * challenge, and one more gate: the contract re-checks `perTx`/`perDay` inside
 * the transfer itself.
 */
async function buy(
  current: DemoSession,
  instruction: string,
  viaRail: boolean,
): Promise<readonly Step[]> {
  const steps: Step[] = [];

  const products = await current.catalog.listProducts();
  const { productId, productName, quantity } = interpretPurchase(instruction, products);
  steps.push({ label: "entendido", value: `${quantity} x ${productName} (${productId})` });

  if (productId !== PAYABLE_PRODUCT_ID) {
    throw new AgentPassError(
      "NotImplemented",
      `"${productName}" está en el catálogo pero esta demo solo puede pagar "Swap Risk Quote" de verdad`,
      { details: { productId, payable: PAYABLE_PRODUCT_ID } },
    );
  }

  const intentResult = (await current.agent.tools.invoke("create_purchase_intent", {
    product_id: productId,
    quantity,
  })) as CreatePurchaseIntentResult;
  steps.push({ label: "intent_id", value: intentResult.intent_id });
  steps.push({
    label: "total",
    value: `${intentResult.total_amount} ${intentResult.asset.split(":")[0] ?? ""}`,
  });

  const verified = await verifyIntent(intentResult.jws);
  const route = await getBazaarServiceRoute({ baseUrl: current.baseUrl }, PAYABLE_PRODUCT_ID);
  const resourceUrl = fillRouteTemplate(current.baseUrl, route, ROUTE_PARAMS);
  steps.push({ label: "recurso", value: resourceUrl });

  const payer = viaRail ? await resolveRailPayer(current) : undefined;
  steps.push({
    label: "pagador",
    value:
      payer === undefined
        ? `${Keypair.fromSecret(current.paymentSecret).publicKey()} (cuenta clásica)`
        : `${payer.contractId} (policy_rail, límites on-chain)`,
  });

  const receipt = await executeBazaarPayment(
    { policyRail: current.policyRail, signerSecret: current.paymentSecret, payer },
    {
      resourceUrl,
      intent: verified.intent,
      scope: current.scope,
      mandate: current.mandate.mandate,
      venueId: current.venueId,
    },
  );

  steps.push({ label: "settled", value: String(receipt.settled) });
  if (receipt.transaction !== undefined) {
    steps.push({ label: "tx", value: receipt.transaction });
    steps.push({
      label: "explorer",
      value: `https://stellar.expert/explorer/testnet/tx/${receipt.transaction}`,
    });
    await anchorSettledPayment(current, intentResult.intent_id, receipt.transaction, steps);
  }
  return steps;
}

/**
 * T28: anchors `paymentLinkHash(record, paymentTx)` against `agent_registry`
 * — the companion transaction `V-3` describes, closing the loop T27 could
 * not (`@x402/stellar` exposes no memo on the payment transaction itself).
 *
 * Best-effort, on purpose: the real payment already settled by the time this
 * runs. A failure here (network, a registry hiccup) must never unwind or
 * hide that — it is reported as its own step, not thrown, so `buy()`'s
 * caller still sees the payment succeeded even if the anchor did not.
 */
async function anchorSettledPayment(
  current: DemoSession,
  intentId: string,
  paymentTx: string,
  steps: Step[],
): Promise<void> {
  const agentKeypair = Keypair.fromSecret(current.agentSecret);
  const agentAddress = agentKeypair.publicKey();
  // The vault stores `intent.agent`, a DID (`stellarDidSchema`) — not the raw
  // address `anchorPaymentDecision`'s `subject` needs for the on-chain call.
  const agentDid = stellarAddressToDid(agentAddress, "testnet");
  const record = current.vault
    .list(agentDid)
    .find((r) => r.entry.kind === "granted" && r.entry.intentId === intentId);
  if (record === undefined) {
    // Fail-closed-by-construction (T24) guarantees `authorise()` — and so
    // `vault.record()` — ran before any payment was signed; reaching this
    // means something about that guarantee broke, worth surfacing loudly.
    steps.push({ label: "vault_anchor", value: "sin registro en el vault para este intent" });
    return;
  }

  try {
    const anchored = await anchorPaymentDecision(current.agentpass, {
      record,
      paymentTx,
      subject: agentAddress,
      expiresAt: new Date(current.mandate.mandate.validUntil),
      issuer: Keypair.fromSecret(current.issuerSecret),
    });
    await current.vault.recordAnchor({
      subject: agentDid,
      intentId,
      paymentTx,
      linkHash: anchored.linkHash,
      anchorTx: anchored.transactionHash,
    });
    steps.push({ label: "vault_anchor_hash", value: anchored.linkHash });
    steps.push({ label: "vault_anchor_tx", value: anchored.transactionHash });
  } catch (error) {
    const message = isAgentPassError(error) ? `${error.code}: ${error.message}` : String(error);
    steps.push({ label: "vault_anchor", value: `no se pudo anclar: ${message}` });
  }
}

interface RevokeResult {
  readonly mandateHash: string;
  readonly revokeTx: string;
  readonly credentialStatus: string;
}

type RevokeOutcome =
  | { readonly kind: "done"; readonly result: RevokeResult }
  | { readonly kind: "pending-wallet-signature"; readonly requestId: string; readonly xdr: string };

/**
 * The platform can revoke its own Mandate outright — it holds
 * `ISSUER_SECRET_KEY`, the key that signed it. A wallet-anchored Mandate
 * (T35) has no such key on this server: only the wallet itself, as the
 * registered issuer, can sign the revoke transaction, so this returns the
 * same "prepare, don't finish" shape `startSession`'s wallet branch does —
 * `/api/session/wallet-revoke-submit` finishes it once the wallet signs.
 */
async function revoke(current: DemoSession): Promise<RevokeOutcome> {
  if (current.walletAddress === undefined) {
    const revokeTx = await revokeMandate(current.agentpass, {
      mandateHash: current.mandate.hash,
      principal: Keypair.fromSecret(current.issuerSecret),
    });
    const credentialStatus = await current.agentpass.status(current.credentialHash);
    return { kind: "done", result: { mandateHash: current.mandate.hash, revokeTx, credentialStatus } };
  }
  const prepared = await prepareWalletRevoke(current.agentpass, {
    mandateHash: current.mandate.hash,
    principalAddress: current.walletAddress,
  });
  return { kind: "pending-wallet-signature", requestId: prepared.requestId, xdr: prepared.xdr };
}

interface WireVaultRecord {
  readonly seq: number;
  readonly kind: "granted" | "refused" | "anchored";
  readonly hash: string;
  readonly at: string;
  readonly intentId: string;
  readonly detail: string;
  /** Only for `kind: "anchored"` — a live read from the registry, not just what the vault file says. */
  readonly onChainStatus?: CredStatus;
}

interface WireIdentityRecord {
  readonly kind: "credential" | "mandate";
  readonly hash: string;
  readonly issuer: string;
  readonly subject: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revoked: boolean;
}

interface VaultReport {
  readonly chain: { readonly ok: boolean; readonly brokenAtSeq?: number };
  /**
   * What `agent_registry` itself says about the credential and the Mandato
   * — T30, indexed from the same on-chain source the vault's anchors already
   * read, not from anything this server remembers locally.
   */
  readonly identity: readonly WireIdentityRecord[];
  readonly records: readonly WireVaultRecord[];
}

/**
 * T29: turns the vault's own chain (T27) plus its anchors (T28) into
 * something a human can read — the "evidencia consultable" §4.5 asks for.
 * The anchored entries' `onChainStatus` is a live call to the registry, not
 * a cached value, so the page proves the anchor still holds rather than
 * repeating what the vault file merely claims. T30 adds the credential's
 * and the Mandato's own anchored records, from the same registry — the
 * "eventos on-chain que PolicyRail/Mandato/MandateGate ya producen" the
 * phase's own spec (`ROADMAP.md §4.5`) named as this fase's raw material.
 */
async function vaultReport(current: DemoSession): Promise<VaultReport> {
  const agentDid = stellarAddressToDid(Keypair.fromSecret(current.agentSecret).publicKey(), "testnet");
  const records = current.vault.list(agentDid);
  const chain = current.vault.verify();

  const identitySources: readonly ["credential" | "mandate", string][] = [
    ["credential", current.credentialHash],
    ["mandate", current.mandate.hash],
  ];
  const identity = (
    await Promise.all(
      identitySources.map(async ([kind, hash]): Promise<WireIdentityRecord | undefined> => {
        const record = await current.agentpass.getRecord(hash);
        if (record === undefined) return undefined;
        return {
          kind,
          hash,
          issuer: record.issuer,
          subject: record.subject,
          issuedAt: record.issuedAt.toISOString(),
          expiresAt: record.expiresAt.toISOString(),
          revoked: record.revoked,
        };
      }),
    )
  ).filter((r): r is WireIdentityRecord => r !== undefined);

  const wireRecords = await Promise.all(
    records.map(async (record): Promise<WireVaultRecord> => {
      const { entry } = record;
      const base = { seq: record.seq, hash: record.hash, kind: entry.kind, at: entry.at, intentId: entry.intentId };
      if (entry.kind === "granted") {
        return { ...base, detail: `${entry.amount} ${entry.currency}` };
      }
      if (entry.kind === "refused") {
        return { ...base, detail: `${entry.code}: ${entry.reason}` };
      }
      const onChainStatus = await current.agentpass.status(entry.linkHash).catch(() => "Unknown" as const);
      return {
        ...base,
        detail: `pago ${entry.paymentTx} · ancla ${entry.anchorTx}`,
        onChainStatus,
      };
    }),
  );

  return { chain, identity, records: wireRecords };
}

// ---- HTTP plumbing -------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

function errorBody(error: unknown): { readonly code: string; readonly message: string; readonly details: unknown } {
  if (isAgentPassError(error)) {
    return { code: error.code, message: error.message, details: error.details };
  }
  return { code: "unknown", message: String(error), details: {} };
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  // `/consent/{id}` (T51's consent_url) has no file of its own — the id is
  // read client-side from the URL path, same as any single-page route.
  // `consent.html` itself is T52, not this hito: until it exists, visiting
  // a real consent_url 404s here exactly like any other missing file — the
  // backend behind it is already complete and verified without a browser.
  const relative =
    pathname === "/"
      ? "/index.html"
      : pathname === "/landing"
        ? "/landing.html"
        : pathname.startsWith("/consent/")
          ? "/consent.html"
          : // T83: hosted revocation, same single-page shape as consent — the
            // mandate id is read client-side from the path.
            pathname.startsWith("/revocar/")
            ? "/revocar.html"
            : pathname;
  const filePath = join(PUBLIC_DIR, relative);
  // No user input reaches this join beyond the URL pathname of a same-origin
  // GET, and every route below is fixed — but refuse a path that escapes
  // PUBLIC_DIR outright rather than trust that.
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 400, { code: "InvalidArguments", message: "bad path" });
    return;
  }
  try {
    await stat(filePath);
  } catch {
    sendJson(res, 404, { code: "NotFound", message: `no route for ${pathname}` });
    return;
  }
  res.writeHead(200, { "content-type": MIME_TYPES[extname(filePath)] ?? "application/octet-stream" });
  createReadStream(filePath).pipe(res);
}

/**
 * The public discovery index (T78), built once: it holds a short-lived cache
 * of the registered venues' catalogues, so one per process is the point.
 * A venue that fails is logged and skipped — one merchant being down must not
 * hide the others, and must not be silent either.
 */
const publicDiscovery = createPublicDiscovery({
  onVenueError: (venueId, error) => {
    logError("[discovery] a registered venue did not answer its catalogue", error, { venueId });
  },
});

const server = createServer((req, res) => {
  void handle(req, res).catch((error: unknown) => {
    logError("unhandled web request error", error, { method: req.method ?? "unknown", path: req.url ?? "", status: 500 });
    sendJson(res, 500, { ok: false, ...errorBody(error) });
  });
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const { pathname } = url;

  // Before the static fallback: every GET that is not `/api/` or `/v1/` is
  // served as a file, so a public route has to be claimed ahead of it.
  if (req.method === "GET" && pathname === "/discovery/search") {
    const result = await handleDiscoverySearch(publicDiscovery, url.searchParams.get("query"));
    sendJson(res, result.status, result.body);
    return;
  }

  if (req.method === "GET" && !pathname.startsWith("/api/") && !pathname.startsWith("/v1/")) {
    await serveStatic(pathname, res);
    return;
  }

  if (pathname.startsWith("/v1/")) {
    const env = await readEnv();
    const directory = await getDirectory(env);
    const authorizationHeader = req.headers[AUTHORIZATION_HEADER];
    const idempotencyKeyHeader = req.headers[IDEMPOTENCY_KEY_HEADER];
    const result = await routePartnerRequest({
      method: req.method ?? "GET",
      pathname,
      searchParams: url.searchParams,
      authorizationHeader: typeof authorizationHeader === "string" ? authorizationHeader : undefined,
      idempotencyKeyHeader: typeof idempotencyKeyHeader === "string" ? idempotencyKeyHeader : undefined,
      body: await readJsonBody(req),
      directory,
      baseUrl: resolveBaseUrl(req, env),
      readActivity: async (tenantId) =>
        readTenantActivity(
          {
            directory,
            vaultFactory: (id) =>
              createPostgresMandateVault({ connectionString: requireEnv(env, "DATABASE_URL"), tenantId: id }),
            readBalance: readRailUsdcBalance,
          },
          tenantId,
        ),
      executePurchase: async (purchase) =>
        executeTenantPurchase(
          {
            directory,
            agentpass: await createWalletAgentPass(env),
            masterMnemonic: requireEnv(env, "MASTER_MNEMONIC"),
            databaseUrl: requireEnv(env, "DATABASE_URL"),
            reserve: requireSecretKey(env, "AGENT_SECRET_KEY"),
            policyRailWasmHash: requireEnv(env, "POLICY_RAIL_WASM_HASH"),
            readUsdcBalance: readRailUsdcBalance,
          },
          purchase,
        ),
    });
    sendJson(res, result.status, result.body);
    return;
  }

  if (req.method === "GET" && pathname === "/api/products") {
    const env = await readEnv();
    const baseUrl = env.get("BAZAAR_BASE_URL") ?? DEFAULT_BAZAAR_BASE_URL;
    const products = await createBazaarCatalog({ baseUrl }).listProducts();
    sendJson(res, 200, { ok: true, products, payableProductId: PAYABLE_PRODUCT_ID });
    return;
  }

  if (req.method === "POST" && pathname === "/api/wallet/challenge") {
    const nonce = randomUUID();
    const env = await readEnv();
    const walletSessionStore = await getWalletSessionStore(env);
    await walletSessionStore.issueChallenge(nonce, WALLET_CHALLENGE_TTL_MS);
    sendJson(res, 200, { ok: true, nonce, message: challengeMessage(nonce) });
    return;
  }

  if (req.method === "POST" && pathname === "/api/wallet/verify") {
    const body = await readJsonBody(req);
    const address = typeof body.address === "string" ? body.address : undefined;
    const nonce = typeof body.nonce === "string" ? body.nonce : undefined;
    const signature = typeof body.signature === "string" ? body.signature : undefined;

    if (address === undefined || nonce === undefined || signature === undefined) {
      sendJson(res, 400, { ok: false, code: "InvalidArguments", message: "falta address, nonce o signature" });
      return;
    }
    const env = await readEnv();
    const walletSessionStore = await getWalletSessionStore(env);
    // Consumed here, before the signature is checked: a nonce is spent by
    // being presented at all, so a wrong signature cannot be retried against
    // the same challenge.
    if (!(await walletSessionStore.takeChallenge(nonce))) {
      sendJson(res, 400, {
        ok: false,
        code: "InvalidArguments",
        message: "ese challenge no existe, ya se usó, o venció — pedí uno nuevo",
      });
      return;
    }
    if (!verifyStellarMessage(address, challengeMessage(nonce), signature)) {
      sendJson(res, 400, { ok: false, code: "InvalidSignature", message: "la firma no corresponde a esa wallet" });
      return;
    }

    // T39: the session id is now this wallet's real tenant id in
    // `@agentpey/directory` — not `sha256(address)` (`C-25`/`D4`) — resolved
    // (or created, on this wallet's very first connection) here, once, so
    // every later request can find the same tenant by cookie alone.
    try {
      const directory = await getDirectory(env);
      const agentAddress = requireSecretKey(env, "AGENT_SECRET_KEY").publicKey();

      const { partnerId } = await ensureSharedPayerIdentity(directory, agentAddress);
      const [principal, tenant] = await Promise.all([
        directory.upsertPrincipal({ address, did: stellarAddressToDid(address, "testnet") }),
        ensureVisitorTenant(directory, partnerId, address),
      ]);
      await directory.bindPrincipal({
        tenantId: tenant.id,
        principalId: principal.id,
        proofNonce: nonce,
        proofSignature: signature,
      });

      await walletSessionStore.setWalletAddressForSession(tenant.id, address);
      withSessionCookie(res, tenant.id);
      sendJson(res, 200, { ok: true, address });
    } catch (error) {
      logError("wallet verification request failed", error, { method: req.method ?? "unknown", path: pathname, status: 400 });
      sendJson(res, 400, { ok: false, ...errorBody(error) });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/session/start") {
    try {
      const sessionId = readSessionId(req) ?? randomUUID();
      withSessionCookie(res, sessionId);
      const started = await startSession(sessionId);

      if (started.kind === "pending-wallet-consent") {
        sendJson(res, 200, {
          ok: true,
          pending: "wallet-consent",
          credentialHash: started.credentialHash,
          challengeMessage: started.challengeMessage,
        });
        return;
      }

      sessions.set(sessionId, started.session);
      sendJson(res, 200, {
        ok: true,
        credentialHash: started.session.credentialHash,
        mandateHash: started.session.mandate.hash,
        agentStatus: started.session.agent.credential.usable ? "Active" : "unusable",
        tools: started.session.agent.tools.list().map((tool) => tool.name),
        venue: started.session.venueId,
        perTx: `${started.session.scope.limits.perTx} ${started.session.scope.limits.currency}`,
        perDay: `${started.session.scope.limits.perDay} ${started.session.scope.limits.currency}`,
        policyRail: started.session.railContractId ?? null,
        walletAddress: started.session.walletAddress ?? null,
      });
    } catch (error) {
      logError("session start request failed", error, { method: req.method ?? "unknown", path: pathname, status: 400 });
      sendJson(res, 400, { ok: false, ...errorBody(error) });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/session/wallet-consent") {
    const sessionId = readSessionId(req);
    const env = await readEnv();
    const walletSessionStore = await getWalletSessionStore(env);
    const pending = sessionId === undefined ? undefined : await walletSessionStore.getPendingWalletSession(sessionId);
    if (sessionId === undefined || pending === undefined) {
      sendJson(res, 400, {
        ok: false,
        code: "ConfigError",
        message: "no hay ninguna sesión esperando la firma de la wallet — iniciá primero",
      });
      return;
    }
    const body = await readJsonBody(req);
    const signature = typeof body.signature === "string" ? body.signature : undefined;
    if (signature === undefined) {
      sendJson(res, 400, { ok: false, code: "InvalidArguments", message: "falta signature" });
      return;
    }
    try {
      const agentpass = await createWalletAgentPass(env);
      const prepared = await prepareWalletAnchor(agentpass, {
        mandate: pending.mandate,
        signature,
      });
      await walletSessionStore.updatePendingWalletSession(sessionId, { signature, requestId: prepared.requestId });
      sendJson(res, 200, { ok: true, requestId: prepared.requestId, xdr: prepared.xdr });
    } catch (error) {
      sendJson(res, 400, { ok: false, ...errorBody(error) });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/session/wallet-anchor") {
    const sessionId = readSessionId(req);
    const env = await readEnv();
    const walletSessionStore = await getWalletSessionStore(env);
    const pending = sessionId === undefined ? undefined : await walletSessionStore.getPendingWalletSession(sessionId);
    if (sessionId === undefined || pending === undefined || pending.signature === undefined) {
      sendJson(res, 400, {
        ok: false,
        code: "ConfigError",
        message: "no hay ninguna sesión esperando el anclaje — empezá el flujo de nuevo",
      });
      return;
    }
    const body = await readJsonBody(req);
    const requestId = typeof body.requestId === "string" ? body.requestId : undefined;
    const signedXdr = typeof body.signedXdr === "string" ? body.signedXdr : undefined;
    if (requestId === undefined || signedXdr === undefined || requestId !== pending.requestId) {
      sendJson(res, 400, { ok: false, code: "InvalidArguments", message: "falta requestId o signedXdr, o no coincide" });
      return;
    }
    try {
      const agentpass = await createWalletAgentPass(env);
      const transactionHash = await agentpass.submitSigned(requestId, signedXdr);

      // T39: persist now that both documents are genuinely anchored — before
      // `finishSession`, so an unrelated failure wiring the live session
      // afterwards never costs the evidence the wallet already paid gas for.
      // F4 (T40): `agentId` is this tenant's own row, not the shared payer's
      // — `tenantAgent.keypair` already *is* that tenant's derived identity
      // (set in `startSession`), so this re-resolves the same row
      // `ensureTenantAgent` created or found there, rather than threading its
      // id through the pending session — idempotent, so re-calling it here
      // costs one query, not a second row.
      const directory = await getDirectory(env);
      const masterMnemonic = requireEnv(env, "MASTER_MNEMONIC");
      const tenantAgent = await ensureTenantAgent(directory, masterMnemonic, sessionId);
      const principal = await directory.upsertPrincipal({
        address: pending.walletAddress,
        did: stellarAddressToDid(pending.walletAddress, "testnet"),
      });
      await directory.recordCredential({
        agentId: tenantAgent.instance.id,
        tenantId: sessionId,
        credentialHash: pending.credentialHash,
        issuerDid: pending.credential.issuer,
        principalDid: pending.credential.credentialSubject.principal,
        jws: pending.issuedCredentialJws,
        validFrom: new Date(pending.credential.validFrom),
        validUntil: new Date(pending.credential.validUntil),
        anchorTx: pending.credentialAnchorTx,
      });
      await directory.recordMandate({
        tenantId: sessionId,
        agentId: tenantAgent.instance.id,
        principalId: principal.id,
        mandateHash: walletMandateHash(pending.mandate),
        signatureKind: "wallet-sep53",
        document: { ...pending.mandate },
        signature: pending.signature,
        validFrom: new Date(pending.mandate.validFrom),
        validUntil: new Date(pending.mandate.validUntil),
        anchorTx: transactionHash,
        supersedesId: pending.supersedesId,
      });

      const session = await finishSession({
        sessionId,
        env,
        agentpass,
        agentKeypair: tenantAgent.keypair,
        paymentSecret: requireSecretKey(env, "AGENT_SECRET_KEY").secret(),
        demoScope: pending.demoScope,
        baseUrl: pending.baseUrl,
        issuedCredentialJws: pending.issuedCredentialJws,
        credentialHash: pending.credentialHash,
        issuerSecret: requireSecretKey(env, "ISSUER_SECRET_KEY").secret(),
        mandate: {
          hash: walletMandateHash(pending.mandate),
          mandate: pending.mandate,
          transactionHash,
          principalAddress: pending.walletAddress,
          signature: pending.signature,
        },
        mandateSource: { mandate: pending.mandate, signature: pending.signature },
        walletAddress: pending.walletAddress,
        tenantAgentId: tenantAgent.instance.id,
      });
      sessions.set(sessionId, session);
      await walletSessionStore.deletePendingWalletSession(sessionId);
      sendJson(res, 200, {
        ok: true,
        credentialHash: session.credentialHash,
        mandateHash: session.mandate.hash,
        agentStatus: session.agent.credential.usable ? "Active" : "unusable",
        tools: session.agent.tools.list().map((tool) => tool.name),
        venue: session.venueId,
        perTx: `${session.scope.limits.perTx} ${session.scope.limits.currency}`,
        perDay: `${session.scope.limits.perDay} ${session.scope.limits.currency}`,
        policyRail: session.railContractId ?? null,
        walletAddress: session.walletAddress ?? null,
      });
    } catch (error) {
      logError("wallet session anchor failed", error, { method: req.method ?? "unknown", path: pathname, status: 400 });
      sendJson(res, 400, { ok: false, ...errorBody(error) });
    }
    return;
  }

  // ---- Hosted consent sessions (T51) ---------------------------------------
  // Public — no API key. A `consent_session` id (a 128-bit ULID a partner's
  // `POST /v1/consent_sessions` minted) is the capability that authorises
  // these, the same trust model a DocuSign envelope link uses. None of this
  // ever calls `finishSession`: a consent session issues and anchors a
  // credential and a Mandate, it never buys anything.

  const consentReadMatch = /^\/api\/consent\/([^/]+)$/.exec(pathname);
  if (req.method === "GET" && consentReadMatch?.[1] !== undefined) {
    const consentSessionId = decodeURIComponent(consentReadMatch[1]);
    try {
      const env = await readEnv();
      const directory = await getDirectory(env);
      const session = await directory.findConsentSession(consentSessionId);
      if (session === undefined) {
        sendJson(res, 404, { ok: false, code: "ConsentSessionNotFound", message: "no existe esa invitación" });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        id: session.id,
        status: computeConsentSessionStatus(session, new Date()),
        grant: session.grant,
        validUntil: session.validUntil.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        // T81. Safe to hand to the page because it was checked against the
        // partner's registered origins *before this row was written*
        // (`requireAllowedReturnUrl`), so the browser is never given an
        // unvalidated destination to navigate to.
        returnUrl: session.returnUrl,
      });
    } catch (error) {
      logError("consent session read failed", error, { method: req.method ?? "unknown", path: pathname, status: 400 });
      sendJson(res, 400, { ok: false, ...errorBody(error) });
    }
    return;
  }

  const consentVerifyMatch = /^\/api\/consent\/([^/]+)\/wallet-verify$/.exec(pathname);
  if (req.method === "POST" && consentVerifyMatch?.[1] !== undefined) {
    const consentSessionId = decodeURIComponent(consentVerifyMatch[1]);
    const body = await readJsonBody(req);
    const address = typeof body.address === "string" ? body.address : undefined;
    const nonce = typeof body.nonce === "string" ? body.nonce : undefined;
    const signature = typeof body.signature === "string" ? body.signature : undefined;

    if (address === undefined || nonce === undefined || signature === undefined) {
      sendJson(res, 400, { ok: false, code: "InvalidArguments", message: "falta address, nonce o signature" });
      return;
    }
    const env = await readEnv();
    const walletSessionStore = await getWalletSessionStore(env);
    if (!(await walletSessionStore.takeChallenge(nonce))) {
      sendJson(res, 400, {
        ok: false,
        code: "InvalidArguments",
        message: "ese challenge no existe, ya se usó, o venció — pedí uno nuevo",
      });
      return;
    }
    if (!verifyStellarMessage(address, challengeMessage(nonce), signature)) {
      sendJson(res, 400, { ok: false, code: "InvalidSignature", message: "la firma no corresponde a esa wallet" });
      return;
    }

    try {
      const directory = await getDirectory(env);
      const session = await directory.findConsentSession(consentSessionId);
      if (session === undefined) {
        sendJson(res, 404, { ok: false, code: "ConsentSessionNotFound", message: "no existe esa invitación" });
        return;
      }
      // Binds to the tenant the *partner* already created — never a new one.
      // `ensureVisitorTenant` (the classic wallet-connect path) does not
      // apply here: this wallet is consenting for a tenant that already
      // exists, not registering itself as a brand new visitor.
      const principal = await directory.upsertPrincipal({ address, did: stellarAddressToDid(address, "testnet") });
      await directory.bindPrincipal({
        tenantId: session.tenantId,
        principalId: principal.id,
        proofNonce: nonce,
        proofSignature: signature,
      });
      await walletSessionStore.setWalletAddressForConsentSession(consentSessionId, address);
      sendJson(res, 200, { ok: true, address });
    } catch (error) {
      logError("consent wallet verification failed", error, { method: req.method ?? "unknown", path: pathname, status: 400 });
      sendJson(res, 400, { ok: false, ...errorBody(error) });
    }
    return;
  }

  const consentStartMatch = /^\/api\/consent\/([^/]+)\/start$/.exec(pathname);
  if (req.method === "POST" && consentStartMatch?.[1] !== undefined) {
    const consentSessionId = decodeURIComponent(consentStartMatch[1]);
    try {
      const result = await startConsentSession(consentSessionId);
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      logError("consent session start failed", error, { method: req.method ?? "unknown", path: pathname, status: 400 });
      sendJson(res, 400, { ok: false, ...errorBody(error) });
    }
    return;
  }

  const consentConsentMatch = /^\/api\/consent\/([^/]+)\/wallet-consent$/.exec(pathname);
  if (req.method === "POST" && consentConsentMatch?.[1] !== undefined) {
    const consentSessionId = decodeURIComponent(consentConsentMatch[1]);
    const env = await readEnv();
    const walletSessionStore = await getWalletSessionStore(env);
    const pending = await walletSessionStore.getPendingConsentSession(consentSessionId);
    if (pending === undefined) {
      sendJson(res, 400, {
        ok: false,
        code: "ConfigError",
        message: "no hay ninguna invitación esperando la firma de la wallet — empezá el flujo de nuevo",
      });
      return;
    }
    const body = await readJsonBody(req);
    const signature = typeof body.signature === "string" ? body.signature : undefined;
    if (signature === undefined) {
      sendJson(res, 400, { ok: false, code: "InvalidArguments", message: "falta signature" });
      return;
    }
    try {
      const agentpass = await createWalletAgentPass(env);
      const prepared = await prepareWalletAnchor(agentpass, { mandate: pending.mandate, signature });
      await walletSessionStore.updatePendingConsentSession(consentSessionId, { signature, requestId: prepared.requestId });
      sendJson(res, 200, { ok: true, requestId: prepared.requestId, xdr: prepared.xdr });
    } catch (error) {
      sendJson(res, 400, { ok: false, ...errorBody(error) });
    }
    return;
  }

  const consentAnchorMatch = /^\/api\/consent\/([^/]+)\/wallet-anchor$/.exec(pathname);
  if (req.method === "POST" && consentAnchorMatch?.[1] !== undefined) {
    const consentSessionId = decodeURIComponent(consentAnchorMatch[1]);
    const env = await readEnv();
    const walletSessionStore = await getWalletSessionStore(env);
    const pending = await walletSessionStore.getPendingConsentSession(consentSessionId);
    if (pending === undefined || pending.signature === undefined) {
      sendJson(res, 400, {
        ok: false,
        code: "ConfigError",
        message: "no hay ninguna invitación esperando el anclaje — empezá el flujo de nuevo",
      });
      return;
    }
    const body = await readJsonBody(req);
    const requestId = typeof body.requestId === "string" ? body.requestId : undefined;
    const signedXdr = typeof body.signedXdr === "string" ? body.signedXdr : undefined;
    if (requestId === undefined || signedXdr === undefined || requestId !== pending.requestId) {
      sendJson(res, 400, { ok: false, code: "InvalidArguments", message: "falta requestId o signedXdr, o no coincide" });
      return;
    }
    try {
      const agentpass = await createWalletAgentPass(env);
      const transactionHash = await agentpass.submitSigned(requestId, signedXdr);
      const directory = await getDirectory(env);
      const masterMnemonic = requireEnv(env, "MASTER_MNEMONIC");
      // Idempotent re-resolve, same pattern `/api/session/wallet-anchor`
      // already uses: the row was created in `startConsentSession`, this
      // just finds it again rather than threading its id through the
      // pending struct.
      const tenantAgent = await ensureTenantAgent(directory, masterMnemonic, pending.tenantId);
      const principal = await directory.upsertPrincipal({
        address: pending.walletAddress,
        did: stellarAddressToDid(pending.walletAddress, "testnet"),
      });
      await directory.recordCredential({
        agentId: tenantAgent.instance.id,
        tenantId: pending.tenantId,
        credentialHash: pending.credentialHash,
        issuerDid: pending.credential.issuer,
        principalDid: pending.credential.credentialSubject.principal,
        jws: pending.issuedCredentialJws,
        validFrom: new Date(pending.credential.validFrom),
        validUntil: new Date(pending.credential.validUntil),
        anchorTx: pending.credentialAnchorTx,
      });
      const mandateRecord = await directory.recordMandate({
        tenantId: pending.tenantId,
        agentId: tenantAgent.instance.id,
        principalId: principal.id,
        mandateHash: walletMandateHash(pending.mandate),
        signatureKind: "wallet-sep53",
        document: { ...pending.mandate },
        signature: pending.signature,
        validFrom: new Date(pending.mandate.validFrom),
        validUntil: new Date(pending.mandate.validUntil),
        anchorTx: transactionHash,
      });
      const completed = await directory.completeConsentSession(consentSessionId, mandateRecord.id);
      await walletSessionStore.deletePendingConsentSession(consentSessionId);
      await walletSessionStore.deleteWalletAddressForConsentSession(consentSessionId);
      sendJson(res, 200, {
        ok: true,
        status: completed.status,
        mandateId: mandateRecord.id,
        mandateHash: mandateRecord.mandateHash,
        transactionHash,
      });
    } catch (error) {
      logError("consent wallet anchor failed", error, { method: req.method ?? "unknown", path: pathname, status: 400 });
      sendJson(res, 400, { ok: false, ...errorBody(error) });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/session/buy") {
    const current = getSession(req);
    if (current === undefined) {
      sendJson(res, 400, { ok: false, code: "ConfigError", message: "no active session — iniciá primero" });
      return;
    }
    const body = await readJsonBody(req);
    const instruction =
      typeof body.instruction === "string" && body.instruction.trim() !== ""
        ? body.instruction
        : "Comprame un Swap Risk Quote, por favor.";
    try {
      const steps = await buy(current, instruction, body.payer === "policy-rail");
      sendJson(res, 200, { ok: true, steps });
    } catch (error) {
      sendJson(res, 200, { ok: false, ...errorBody(error) });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/session/vault") {
    const current = getSession(req);
    if (current === undefined) {
      sendJson(res, 400, { ok: false, code: "ConfigError", message: "no active session — iniciá primero" });
      return;
    }
    try {
      const report = await vaultReport(current);
      sendJson(res, 200, { ok: true, ...report });
    } catch (error) {
      logError("vault report request failed", error, { method: req.method ?? "unknown", path: pathname, status: 400 });
      sendJson(res, 400, { ok: false, ...errorBody(error) });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/session/revoke") {
    const current = getSession(req);
    if (current === undefined) {
      sendJson(res, 400, { ok: false, code: "ConfigError", message: "no active session — iniciá primero" });
      return;
    }
    try {
      const outcome = await revoke(current);
      if (outcome.kind === "pending-wallet-signature") {
        sendJson(res, 200, { ok: true, pending: "wallet-signature", requestId: outcome.requestId, xdr: outcome.xdr });
        return;
      }
      sendJson(res, 200, { ok: true, ...outcome.result });
    } catch (error) {
      sendJson(res, 200, { ok: false, ...errorBody(error) });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/session/wallet-revoke-submit") {
    const current = getSession(req);
    if (current === undefined) {
      sendJson(res, 400, { ok: false, code: "ConfigError", message: "no active session — iniciá primero" });
      return;
    }
    const body = await readJsonBody(req);
    const requestId = typeof body.requestId === "string" ? body.requestId : undefined;
    const signedXdr = typeof body.signedXdr === "string" ? body.signedXdr : undefined;
    if (requestId === undefined || signedXdr === undefined) {
      sendJson(res, 400, { ok: false, code: "InvalidArguments", message: "falta requestId o signedXdr" });
      return;
    }
    try {
      const revokeTx = await current.agentpass.submitSigned(requestId, signedXdr);
      const credentialStatus = await current.agentpass.status(current.credentialHash);
      // T39: mirror the revocation into the directory, so a later rehydration
      // attempt for this tenant correctly finds no active mandate and issues
      // a fresh one instead of reusing a mandate the chain no longer honours.
      if (current.walletAddress !== undefined) {
        const env = await readEnv();
        const directory = await getDirectory(env);
        await directory.revokeMandate(current.mandate.hash, revokeTx);
      }
      sendJson(res, 200, { ok: true, mandateHash: current.mandate.hash, revokeTx, credentialStatus });
    } catch (error) {
      sendJson(res, 200, { ok: false, ...errorBody(error) });
    }
    return;
  }

  // ---- Hosted revocation (T83) ---------------------------------------------
  // Public, like the consent flow, and for the same reason: the person doing
  // this is not a partner and has no API key. What authorises the act is the
  // wallet signature on the transaction, which only the principal can produce
  // and which the registry contract checks — these routes add a clearer
  // refusal, not the authority.

  const revokeReadMatch = /^\/api\/revoke\/([^/]+)$/.exec(pathname);
  if (req.method === "GET" && revokeReadMatch?.[1] !== undefined) {
    const mandateId = decodeURIComponent(revokeReadMatch[1]);
    try {
      const directory = await getDirectory(await readEnv());
      sendJson(res, 200, { ok: true, ...(await readPublicView(directory, mandateId, new Date())) });
    } catch (error) {
      logError("revocation read failed", error, { method: req.method ?? "unknown", path: pathname, status: 400 });
      sendJson(res, isAgentPassError(error) && error.code === "MandateNotFound" ? 404 : 400, {
        ok: false,
        ...errorBody(error),
      });
    }
    return;
  }

  const revokePrepareMatch = /^\/api\/revoke\/([^/]+)\/prepare$/.exec(pathname);
  if (req.method === "POST" && revokePrepareMatch?.[1] !== undefined) {
    const mandateId = decodeURIComponent(revokePrepareMatch[1]);
    const body = await readJsonBody(req);
    const address = typeof body.address === "string" ? body.address : undefined;
    const nonce = typeof body.nonce === "string" ? body.nonce : undefined;
    const signature = typeof body.signature === "string" ? body.signature : undefined;
    if (address === undefined || nonce === undefined || signature === undefined) {
      sendJson(res, 400, { ok: false, code: "InvalidArguments", message: "falta address, nonce o signature" });
      return;
    }

    try {
      const env = await readEnv();
      const directory = await getDirectory(env);
      const walletSessionStore = await getWalletSessionStore(env);

      // The wallet proof and the transaction are prepared in one call, so no
      // state has to be kept between them: the only thing that could be
      // replayed is a challenge, and that is consumed here, once.
      const mandate = await proveOwnership(
        directory,
        { takeChallenge: (value) => walletSessionStore.takeChallenge(value), challengeMessage },
        mandateId,
        { address, nonce, signature },
      );
      requireRevocable(mandate, new Date());

      const agentpass = await createWalletAgentPass(env);
      const prepared = await prepareWalletRevoke(agentpass, {
        mandateHash: mandate.mandateHash,
        principalAddress: address,
      });
      sendJson(res, 200, {
        ok: true,
        requestId: prepared.requestId,
        xdr: prepared.xdr,
        mandate: toPrivateView(mandate, new Date()),
      });
    } catch (error) {
      logError("revocation prepare failed", error, { method: req.method ?? "unknown", path: pathname, status: 400 });
      sendJson(res, 400, { ok: false, ...errorBody(error) });
    }
    return;
  }

  const revokeSubmitMatch = /^\/api\/revoke\/([^/]+)\/submit$/.exec(pathname);
  if (req.method === "POST" && revokeSubmitMatch?.[1] !== undefined) {
    const mandateId = decodeURIComponent(revokeSubmitMatch[1]);
    const body = await readJsonBody(req);
    const requestId = typeof body.requestId === "string" ? body.requestId : undefined;
    const signedXdr = typeof body.signedXdr === "string" ? body.signedXdr : undefined;
    if (requestId === undefined || signedXdr === undefined) {
      sendJson(res, 400, { ok: false, code: "InvalidArguments", message: "falta requestId o signedXdr" });
      return;
    }

    try {
      const env = await readEnv();
      const directory = await getDirectory(env);
      const mandate = await directory.findMandateById(mandateId);
      if (mandate === undefined) {
        sendJson(res, 404, { ok: false, code: "MandateNotFound", message: "no existe ese permiso" });
        return;
      }

      // No wallet proof is re-checked here, and none is needed: what is being
      // submitted is a transaction signed by the principal, and the registry
      // contract refuses it otherwise. Asking for a second proof would add a
      // step without adding a guarantee.
      const agentpass = await createWalletAgentPass(env);
      const revokeTx = await agentpass.submitSigned(requestId, signedXdr);
      // Mirror it, so a later rehydration finds no active mandate and issues a
      // fresh one instead of reusing one the chain no longer honours (T39).
      await directory.revokeMandate(mandate.mandateHash, revokeTx);
      sendJson(res, 200, { ok: true, mandateId: mandate.id, mandateHash: mandate.mandateHash, revokeTx });
    } catch (error) {
      logError("revocation submit failed", error, { method: req.method ?? "unknown", path: pathname, status: 400 });
      sendJson(res, 400, { ok: false, ...errorBody(error) });
    }
    return;
  }

  sendJson(res, 404, { ok: false, code: "NotFound", message: `no route for ${req.method} ${pathname}` });
}

/**
 * T70: rows in `wallet_challenges`/`pending_wallet_sessions`/
 * `pending_consent_sessions`/`sdk_pending_writes` outlive an abandoned
 * flow forever otherwise — every read already filters by `expires_at`, but
 * nothing deletes the row itself. TTLs here are 5–10 minutes
 * (`WALLET_CHALLENGE_TTL_MS`/`PENDING_WALLET_SESSION_TTL_MS`/
 * `PENDING_WRITE_TTL_MS`), so a 15-minute sweep keeps at most one extra
 * cycle's worth of dead rows around instead of doing a `delete` on every
 * request's hot path. `.unref()` so this timer alone never keeps the
 * process alive (matters for tests and graceful shutdown, not for the
 * running server, which is already held open by its listening socket).
 */
const RETENTION_SWEEP_INTERVAL_MS = 15 * 60_000;
function startRetentionSweep(): void {
  const timer = setInterval(() => {
    void (async () => {
      try {
        const env = await readEnv();
        const [walletSessionStore, pendingWriteStore] = await Promise.all([
          getWalletSessionStore(env),
          getPendingWriteStore(env),
        ]);
        const [walletSwept, writesSwept] = await Promise.all([
          walletSessionStore.sweepExpired(),
          pendingWriteStore.sweepExpired(),
        ]);
        const total =
          walletSwept.walletChallenges +
          walletSwept.pendingWalletSessions +
          walletSwept.pendingConsentSessions +
          writesSwept.deleted;
        if (total > 0) {
          log("info", "[retention] swept expired rows", { ...walletSwept, sdkPendingWrites: writesSwept.deleted });
        }
      } catch (error) {
        logError("[retention] sweep failed", error);
      }
    })();
  }, RETENTION_SWEEP_INTERVAL_MS);
  timer.unref();
}

server.listen(PORT, () => {
  startRetentionSweep();
  process.stdout.write(`\nAgentPey web · Fase 4 (T25) · http://localhost:${PORT}\n\n`);
});
