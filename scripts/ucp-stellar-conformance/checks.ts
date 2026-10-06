/**
 * The Stellar x402 payment handler's conformance kit (T137): checks that any
 * UCP store declaring `com.agentpey.stellar_x402` implements it as its spec
 * (https://agentpey.com/ucp/handlers/stellar-x402/spec) says, one check at a
 * time, each with a verdict and the reason.
 *
 * Four groups, each needing more of the caller than the one before:
 *
 * - **profile**: only GETs, against any URL.
 * - **requirements**: opens a checkout (it moves no money, but a store keeps a
 *   session) and sends one Complete Checkout with a junk transaction whose
 *   `accepted` was altered: the store must refuse it.
 * - **charge**: only with a payer, a testnet key the caller holds. Pays one
 *   checkout through `@agentpey/ucp-stellar`, after a probe signed for real but
 *   with an altered `accepted`, and replays the credential.
 * - **receipt**: when the store declares AgentPey's receipt extension and a
 *   charge ran: the receipt's key in the profile, its registry, and its three
 *   checks (signature and content, anchor, settlement).
 *
 * No check throws: every failure, network ones included, is a `fail` with its
 * reason. A check that cannot run says why it was skipped.
 */
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";

import {
  STELLAR_TESTNET,
  STELLAR_X402_HANDLER,
  USDC_TESTNET,
  fromAtomic,
  isUcpStellarError,
  originMatchesNamespace,
  toAtomic,
  pay,
  UcpStellarError,
  type BalanceReader,
  type PayableQuote,
  type UcpDestination,
  type UcpStellarPayer,
} from "../../packages/ucp-stellar/src/index.js";
import type { RegistryReader, ReceiptVerification } from "../../packages/vitrinee-anchor/src/index.js";

export const RECEIPT_EXTENSION = "com.agentpey.shopping.receipt";
export const DEFAULT_PLATFORM_PROFILE = "https://agentpey.com/ucp/platform/agentpey.json";

export type Outcome = "pass" | "fail" | "warn" | "skip";
export type Group = "profile" | "requirements" | "charge" | "receipt";

export interface CheckResult {
  readonly id: string;
  readonly group: Group;
  readonly title: string;
  readonly outcome: Outcome;
  readonly detail: string;
}

/** Everything that reaches the network, so a test can run the kit with none. */
export interface KitDeps {
  /** The store, and agentpey.com for the handler's spec and schema. */
  readonly fetch: typeof fetch;
  /** A SEP-41 balance, in atomic units: does `pay_to` hold a trustline to the asset? */
  readonly readBalance: BalanceReader;
  /** The receipt registry, read-only. */
  readonly registry: (contractId: string) => RegistryReader;
  /** The three receipt checks (`verifyReceipt` of `@vitrinee/anchor`). */
  readonly verifyReceipt: (jws: string, registry: RegistryReader) => Promise<ReceiptVerification>;
  readonly sleep: (ms: number) => Promise<void>;
}

export interface KitOptions {
  /** The store's origin, or any URL on it. */
  readonly storeUrl: string;
  /** Stop after the profile group: GETs only. */
  readonly profileOnly?: boolean;
  /** The product a checkout is opened for; without it, the first one the store's catalog search returns. */
  readonly productId?: string;
  readonly destination: UcpDestination;
  readonly email: string;
  /** Sent in `UCP-Agent`. */
  readonly platformProfile: string;
  /** The receipt registry trusted; a receipt anchored in another fails. */
  readonly registry: string;
  /**
   * The charge group runs only with this: a payer holding a testnet key, the account it pays from (to read its
   * balance), the most it may pay, and the one asset contract it pays in.
   */
  readonly charge?: { readonly payer: UcpStellarPayer; readonly payerAddress: string; readonly maxAmount: string; readonly asset: string };
  /** How long to wait for a pending receipt anchor, in milliseconds. */
  readonly anchorWaitMs?: number;
}

// ---------------------------------------------------------------- what is read from the store

const handlerEntry = z.looseObject({ id: z.string().min(1), version: z.string().min(1), spec: z.string().optional(), schema: z.string().optional(), config: z.unknown().optional() });

const profileShape = z.looseObject({
  ucp: z.looseObject({
    version: z.string().min(1),
    services: z.record(z.string(), z.array(z.looseObject({ transport: z.string(), endpoint: z.string().optional() }))),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    payment_handlers: z.record(z.string(), z.array(z.unknown())),
  }),
  keys: z.array(z.unknown()).optional(),
});
type Profile = z.infer<typeof profileShape>;

const usableConfig = z.looseObject({
  network: z.string(),
  asset: z.looseObject({ code: z.string(), contract: z.string(), decimals: z.number() }),
  pay_to: z.string(),
});
type UsableConfig = z.infer<typeof usableConfig>;

const requirementsShape = z.looseObject({
  scheme: z.string(),
  network: z.string(),
  asset: z.string(),
  amount: z.string(),
  payTo: z.string(),
  maxTimeoutSeconds: z.number(),
  extra: z.record(z.string(), z.unknown()).optional(),
});
type Requirements = z.infer<typeof requirementsShape>;

const messageShape = z.looseObject({ type: z.string().optional(), code: z.string().optional(), content: z.string().optional(), severity: z.string().optional() });

const checkoutShape = z.looseObject({
  id: z.string().min(1),
  status: z.string(),
  currency: z.string().optional(),
  line_items: z.array(z.looseObject({ item: z.looseObject({ id: z.string() }), quantity: z.number() })).optional(),
  messages: z.array(messageShape).optional(),
  ucp: z.looseObject({ payment_handlers: z.record(z.string(), z.array(z.looseObject({ config: z.unknown().optional() }))).optional() }).optional(),
  order: z.looseObject({ id: z.string(), permalink_url: z.string().optional() }).optional(),
  receipt: z.unknown().optional(),
});
type Checkout = z.infer<typeof checkoutShape>;

const receiptShape = z.looseObject({
  jws: z.string().min(1),
  hash: z.string().min(1),
  settlement_tx_hash: z.string().min(1),
  verify_url: z.string().optional(),
  anchor: z.looseObject({ status: z.string(), registry: z.string() }),
});
type Receipt = z.infer<typeof receiptShape>;

const publishedKey = z.looseObject({ kid: z.string(), kty: z.string(), crv: z.string().optional(), x: z.string().optional() });

const lineItemsShape = z.array(z.looseObject({ item: z.looseObject({ id: z.string().min(1) }), quantity: z.int().positive() })).min(1);

const MARK: Record<Outcome, string> = { pass: "✔", fail: "✘", warn: "!", skip: "–" };

/** One line per check, then the counts. */
export function formatReport(results: readonly CheckResult[]): string {
  const lines = results.map((r) => `${MARK[r.outcome]} ${r.id.padEnd(3)} ${r.title}: ${r.detail}`);
  const count = (outcome: Outcome) => results.filter((r) => r.outcome === outcome).length;
  lines.push("", `${count("pass")} pass · ${count("fail")} fail · ${count("warn")} warn · ${count("skip")} skipped`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- helpers

class Report {
  readonly results: CheckResult[] = [];
  add(id: string, group: Group, title: string, outcome: Outcome, detail: string): Outcome {
    this.results.push({ id, group, title, outcome, detail });
    return outcome;
  }
  skip(id: string, group: Group, title: string, why: string): void {
    this.add(id, group, title, "skip", why);
  }
}

/** An error's message on one line: an RPC's diagnostic log is not a reason a person can read. */
const why = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  const first = text.split("\n")[0]!.trim();
  return first.length > 200 ? `${first.slice(0, 200)}…` : first;
};

const TITLES: Record<string, string> = {
  R1: "checkout ready to pay",
  R2: "checkout matches response_config",
  R3: "bound to this checkout",
  R4: "pays what the profile declares",
  R5: "amount",
  R6: "refuses a credential whose accepted differs from the checkout's payment_requirements",
};

async function getJson(deps: KitDeps, options: KitOptions, url: string, init: RequestInit = {}): Promise<{ status: number; json: unknown }> {
  const res = await deps.fetch(url, {
    ...init,
    headers: { accept: "application/json", "UCP-Agent": `profile="${options.platformProfile}"`, ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
  });
  return { status: res.status, json: await res.json().catch(() => undefined) };
}

function messagesOf(json: unknown): Array<z.infer<typeof messageShape>> {
  const parsed = z.looseObject({ messages: z.array(messageShape) }).safeParse(json);
  return parsed.success ? parsed.data.messages : [];
}

function describeMessages(json: unknown): string {
  const messages = messagesOf(json);
  return messages.length === 0 ? "no messages" : messages.map((m) => `${m.code ?? "?"}${m.severity === undefined ? "" : `/${m.severity}`}: ${m.content ?? ""}`).join("; ");
}

function schemaErrors(validate: ValidateFunction): string {
  return (validate.errors ?? []).slice(0, 4).map((e) => `${e.instancePath || "(root)"} ${e.message ?? ""}`.trim()).join("; ");
}

function handlerConfigOf(checkout: Checkout): unknown {
  return checkout.ucp?.payment_handlers?.[STELLAR_X402_HANDLER]?.[0]?.config;
}

/** The complete body for one credential, as the handler spec's instrument shapes it. */
function completeBody(handlerId: string, accepted: unknown, transaction: string): unknown {
  return {
    payment: {
      instruments: [
        { id: "instr_1", handler_id: handlerId, type: "stellar_x402", selected: true, credential: { type: "x402_payment_payload", x402_version: 2, accepted, payload: { transaction } } },
      ],
    },
  };
}

const TAMPER_NOTE = "a credential whose accepted differs from the checkout's payment_requirements";

// ---------------------------------------------------------------- the kit

/** Runs every check the options allow and returns one result per check, in order. Never throws. */
export async function runConformance(options: KitOptions, deps: KitDeps): Promise<CheckResult[]> {
  const report = new Report();
  try {
    await run(report, options, deps);
  } catch (error) {
    report.add("KIT", "profile", "the kit itself", "fail", `the kit stopped on an unexpected error: ${why(error)}`);
  }
  return report.results;
}

async function run(report: Report, options: KitOptions, deps: KitDeps): Promise<void> {
  if (!URL.canParse(options.storeUrl)) {
    report.add("P1", "profile", "business profile", "fail", `"${options.storeUrl}" is not a URL`);
    return;
  }
  const origin = new URL(options.storeUrl).origin;

  // ------------------------------------------------ profile
  let profile: Profile;
  try {
    const reply = await getJson(deps, options, `${origin}/.well-known/ucp`);
    const parsed = profileShape.safeParse(reply.json);
    if (reply.status !== 200 || !parsed.success) {
      report.add("P1", "profile", "business profile", "fail", `${origin}/.well-known/ucp answered ${reply.status}${parsed.success ? "" : ", not a UCP business profile (ucp.version, ucp.services, ucp.payment_handlers)"}`);
      return;
    }
    profile = parsed.data;
    report.add("P1", "profile", "business profile", "pass", `${origin}/.well-known/ucp, UCP ${profile.ucp.version}`);
  } catch (error) {
    report.add("P1", "profile", "business profile", "fail", `could not read ${origin}/.well-known/ucp: ${why(error)}`);
    return;
  }

  const entries = profile.ucp.payment_handlers[STELLAR_X402_HANDLER];
  const handler = entries === undefined ? undefined : handlerEntry.safeParse(entries[0]);
  if (handler === undefined || !handler.success) {
    report.add("P2", "profile", `declares ${STELLAR_X402_HANDLER}`, "fail", entries === undefined ? "the profile does not declare the handler" : "the handler's first entry has no id or version");
    return;
  }
  report.add("P2", "profile", `declares ${STELLAR_X402_HANDLER}`, "pass", `id "${handler.data.id}", version ${handler.data.version}`);

  // P3: the namespace binding, and both URLs answer.
  let validators: { business: ValidateFunction; response: ValidateFunction } | undefined;
  const bound = originMatchesNamespace(STELLAR_X402_HANDLER, handler.data.spec) && originMatchesNamespace(STELLAR_X402_HANDLER, handler.data.schema);
  if (!bound) {
    report.add("P3", "profile", "spec and schema on agentpey.com", "fail", `UCP binds com.agentpey.* to https://agentpey.com; the store declares spec ${handler.data.spec ?? "(none)"} and schema ${handler.data.schema ?? "(none)"}`);
  } else {
    try {
      const [spec, schema] = await Promise.all([deps.fetch(handler.data.spec!), deps.fetch(handler.data.schema!)]);
      const schemaJson: unknown = await schema.json().catch(() => undefined);
      const id = z.looseObject({ $id: z.string() }).safeParse(schemaJson);
      if (spec.status !== 200 || schema.status !== 200 || !id.success || id.data.$id !== handler.data.schema) {
        report.add("P3", "profile", "spec and schema on agentpey.com", "fail", `spec answered ${spec.status}, schema answered ${schema.status}${id.success && id.data.$id !== handler.data.schema ? `, and the schema's $id is ${id.data.$id}` : ""}`);
      } else {
        // The two formats the schema uses, checked rather than ignored.
        const ajv = new Ajv2020({ strict: false, allErrors: true, formats: { uri: (value: string) => URL.canParse(value), "date-time": (value: string) => !Number.isNaN(Date.parse(value)) } });
        ajv.addSchema(schemaJson as object);
        validators = { business: ajv.getSchema(`${id.data.$id}#/$defs/business_config`)!, response: ajv.getSchema(`${id.data.$id}#/$defs/response_config`)! };
        report.add("P3", "profile", "spec and schema on agentpey.com", "pass", `${handler.data.spec} and ${handler.data.schema} answer`);
      }
    } catch (error) {
      report.add("P3", "profile", "spec and schema on agentpey.com", "fail", `could not read the spec or the schema: ${why(error)}`);
    }
  }

  // P4: the config against the published schema.
  if (validators === undefined) {
    report.skip("P4", "profile", "config matches business_config", "needs the published schema (P3)");
  } else if (validators.business(handler.data.config)) {
    report.add("P4", "profile", "config matches business_config", "pass", "valid against #/$defs/business_config");
  } else {
    report.add("P4", "profile", "config matches business_config", "fail", schemaErrors(validators.business));
  }

  // P5: network, decimals, asset.
  const config = usableConfig.safeParse(handler.data.config);
  let declared: UsableConfig | undefined;
  if (!config.success) {
    report.add("P5", "profile", "network and asset", "fail", "the config has no network, asset (code, contract, decimals) or pay_to");
  } else {
    declared = config.data;
    if (declared.network !== STELLAR_TESTNET) {
      report.add("P5", "profile", "network and asset", "fail", `network is ${declared.network}; this handler version is ${STELLAR_TESTNET} only`);
    } else if (declared.asset.decimals !== 7) {
      report.add("P5", "profile", "network and asset", "fail", `the asset declares ${declared.asset.decimals} decimals; Stellar assets have 7`);
    } else if (declared.asset.contract !== USDC_TESTNET) {
      report.add("P5", "profile", "network and asset", "warn", `${declared.asset.code} at ${declared.asset.contract}: not USDC on testnet (${USDC_TESTNET}); allowed, but AgentPey's receipts trust USDC only`);
    } else {
      report.add("P5", "profile", "network and asset", "pass", `${STELLAR_TESTNET}, ${declared.asset.code} ${declared.asset.contract}, 7 decimals`);
    }
  }

  // P6: pay_to can hold the asset.
  if (declared === undefined) {
    report.skip("P6", "profile", "pay_to can receive the asset", "needs a readable config (P5)");
  } else {
    try {
      const balance = await deps.readBalance(declared.pay_to, declared.asset.contract);
      report.add("P6", "profile", "pay_to can receive the asset", "pass", `${declared.pay_to} holds ${fromAtomic(balance, 7)} ${declared.asset.code}`);
    } catch (error) {
      const noTrustline = /trustline entry is missing/i.test(error instanceof Error ? error.message : String(error));
      report.add(
        "P6",
        "profile",
        "pay_to can receive the asset",
        "fail",
        noTrustline ? `${declared.pay_to} has no trustline to ${declared.asset.code} (${declared.asset.contract}): a payment to it cannot settle` : `could not read ${declared.pay_to}'s balance of ${declared.asset.contract}: ${why(error)}`,
      );
    }
  }

  // P7: an endpoint of the store's own.
  const endpoint = profile.ucp.services["dev.ucp.shopping"]?.find((service) => service.transport === "rest")?.endpoint;
  const ownEndpoint = endpoint !== undefined && URL.canParse(endpoint) && new URL(endpoint).origin === origin;
  report.add("P7", "profile", "REST endpoint on the store's origin", ownEndpoint ? "pass" : "fail", ownEndpoint ? endpoint! : `dev.ucp.shopping declares ${endpoint ?? "no REST endpoint"}, not on ${origin}`);

  if (options.profileOnly === true) return;
  // The requirement checks sign nothing, so they run on a profile with errors too, to report every one of them. The
  // charge is the one that needs a profile a platform could pay against.
  const requirementIds = ["R1", "R2", "R3", "R4", "R5", "R6"];
  if (!ownEndpoint || endpoint === undefined || declared === undefined) {
    for (const id of requirementIds) report.skip(id, "requirements", TITLES[id]!, "needs a readable config (P5) and the store's REST endpoint (P7)");
    skipCharge(report, "needs the requirement checks");
    return;
  }
  const payable = !["P3", "P5"].some((id) => report.results.find((r) => r.id === id)?.outcome === "fail");

  // ------------------------------------------------ requirements
  const product = options.productId ?? (await firstProduct(deps, options, endpoint));
  if (product === undefined) {
    for (const id of requirementIds) report.skip(id, "requirements", TITLES[id]!, "no product: pass --product, or the store's catalog search returns none");
    skipCharge(report, "needs a checkout");
    return;
  }
  const opened = await openCheckout(deps, options, endpoint, product);
  if (opened.checkout === undefined || opened.checkout.status !== "ready_for_complete") {
    report.add("R1", "requirements", "checkout ready to pay", "fail", opened.checkout === undefined ? `POST ${endpoint}/checkout-sessions answered ${opened.status}: ${describeMessages(opened.json)}` : `the checkout is ${opened.checkout.status}: ${describeMessages(opened.json)}`);
    for (const id of requirementIds.slice(1)) report.skip(id, "requirements", TITLES[id]!, "needs a ready checkout (R1)");
    skipCharge(report, "needs a ready checkout");
    return;
  }
  const checkout = opened.checkout;
  report.add("R1", "requirements", "checkout ready to pay", "pass", `${checkout.id} for ${product}`);

  const responseConfig = handlerConfigOf(checkout);
  if (validators === undefined) report.skip("R2", "requirements", "checkout matches response_config", "needs the published schema (P3)");
  else if (validators.response(responseConfig)) report.add("R2", "requirements", "checkout matches response_config", "pass", "valid against #/$defs/response_config");
  else report.add("R2", "requirements", "checkout matches response_config", "fail", schemaErrors(validators.response));

  const binding = z.looseObject({ binding: z.looseObject({ checkout_id: z.string() }) }).safeParse(responseConfig);
  report.add(
    "R3",
    "requirements",
    "bound to this checkout",
    binding.success && binding.data.binding.checkout_id === checkout.id ? "pass" : "fail",
    binding.success ? `binding.checkout_id is ${binding.data.binding.checkout_id}${binding.data.binding.checkout_id === checkout.id ? "" : `, the checkout is ${checkout.id}`}` : "the handler's config has no binding.checkout_id",
  );

  const parsedRequirements = requirementsShape.safeParse(z.looseObject({ payment_requirements: z.unknown() }).safeParse(responseConfig).data?.payment_requirements);
  if (!parsedRequirements.success) {
    report.add("R4", "requirements", "pays what the profile declares", "fail", "the checkout carries no payment_requirements");
    report.skip("R5", "requirements", "amount", "needs payment_requirements (R4)");
    report.skip("R6", "requirements", TITLES["R6"]!, "needs payment_requirements (R4)");
    skipCharge(report, "needs payment_requirements");
    return;
  }
  const requirements = parsedRequirements.data;
  const mismatches = [
    requirements.scheme !== "exact" ? `scheme ${requirements.scheme} (the handler is exact)` : undefined,
    requirements.payTo !== declared.pay_to ? `payTo ${requirements.payTo} (profile: ${declared.pay_to})` : undefined,
    requirements.asset !== declared.asset.contract ? `asset ${requirements.asset} (profile: ${declared.asset.contract})` : undefined,
    requirements.network !== declared.network ? `network ${requirements.network} (profile: ${declared.network})` : undefined,
  ].filter((m) => m !== undefined);
  const paysDeclared = mismatches.length === 0;
  report.add("R4", "requirements", "pays what the profile declares", paysDeclared ? "pass" : "fail", paysDeclared ? `scheme exact; payTo, asset and network are the profile's` : `the checkout asks for ${mismatches.join(", ")}: a platform must refuse to sign`);

  const amountOk = /^[1-9]\d*$/.test(requirements.amount);
  const needsFx = checkout.currency !== undefined && checkout.currency !== declared.asset.code;
  const hasFx = z.looseObject({ fx: z.unknown() }).safeParse(responseConfig).success;
  if (!amountOk) report.add("R5", "requirements", "amount", "fail", `amount "${requirements.amount}" is not a positive integer of atomic units`);
  else if (needsFx && !hasFx) report.add("R5", "requirements", "amount", "warn", `${fromAtomic(BigInt(requirements.amount), 7)} ${declared.asset.code} for a checkout in ${checkout.currency}, with no fx saying the rate used`);
  else report.add("R5", "requirements", "amount", "pass", `${fromAtomic(BigInt(requirements.amount), 7)} ${declared.asset.code}${needsFx ? `, with the fx rate for ${checkout.currency}` : ""}`);

  // R6: an altered accepted, with a junk transaction that cannot move money even at a store that ignores the check.
  if (!amountOk) {
    report.skip("R6", "requirements", TITLES["R6"]!, "needs a valid amount (R5)");
  } else {
    const tampered = { ...requirements, amount: (BigInt(requirements.amount) + 1n).toString() };
    const junk = Buffer.from("ucp-stellar-conformance: not a transaction").toString("base64");
    try {
      const reply = await getJson(deps, options, `${endpoint}/checkout-sessions/${encodeURIComponent(checkout.id)}/complete`, {
        method: "POST",
        body: JSON.stringify(completeBody(handler.data.id, tampered, junk)),
      });
      refusalVerdict(report, "R6", "requirements", TITLES["R6"]!, reply, "with a junk transaction", "the transaction was also invalid, so this shows only that the store does not complete without settling; C1 (--pay) shows it compares accepted");
    } catch (error) {
      report.add("R6", "requirements", TITLES["R6"]!, "fail", `the probe could not reach the store: ${why(error)}`);
    }
  }

  // ------------------------------------------------ charge
  if (options.charge === undefined) {
    skipCharge(report, "runs only with --pay and a testnet key");
    return;
  }
  // Nothing is signed for a store that already failed a check a signed payment would depend on.
  const failedBefore = ["P3", "P5", "P6", "R2", "R3", "R4", "R5", "R6"].filter((id) => report.results.find((r) => r.id === id)?.outcome === "fail");
  if (!payable || !paysDeclared || !amountOk || failedBefore.length > 0) {
    skipCharge(report, `the store failed ${failedBefore.join(", ")}: nothing is signed for it`);
    return;
  }
  if (requirements.asset !== options.charge.asset) {
    skipCharge(report, `the checkout is priced in ${requirements.asset}; the kit pays only in ${options.charge.asset} (--asset): nothing is signed`);
    return;
  }
  const lines = lineItemsShape.safeParse(checkout.line_items);
  if (!lines.success) {
    skipCharge(report, "the checkout does not say which line_items it is for: nothing is signed");
    return;
  }
  await charge(report, options, deps, {
    origin,
    endpoint,
    handlerId: handler.data.id,
    checkoutId: checkout.id,
    requirements,
    lines: lines.data.map((line) => ({ productId: line.item.id, quantity: line.quantity })),
    raw: opened.json as Record<string, unknown>,
    profile,
  });
}

function refusalVerdict(report: Report, id: string, group: Group, title: string, reply: { status: number; json: unknown }, how: string, note: string): void {
  const answered = checkoutShape.safeParse(reply.json);
  const completed = answered.success && (answered.data.status === "completed" || answered.data.order !== undefined);
  const failed = messagesOf(reply.json).some((m) => m.code === "payment_failed");
  if (completed) report.add(id, group, title, "fail", `the store completed the checkout ${how}; the spec says it MUST reject it`);
  else if (!failed) report.add(id, group, title, "fail", `refused, but not with payment_failed (status ${reply.status}: ${describeMessages(reply.json)})`);
  else report.add(id, group, title, "pass", `refused ${how} (${describeMessages(reply.json)}); ${note}`);
}

function skipCharge(report: Report, reason: string): void {
  for (const [id, title] of Object.entries(C_TITLES)) report.skip(id, "charge", title, reason);
  for (const [id, title] of [["E1", "receipt on the checkout and the order"], ["E2", "receipt key in the profile"], ["E3", "receipt in the trusted registry"], ["E4", "receipt's three checks"]] as const) report.skip(id, "receipt", title, "needs a completed charge");
}

async function firstProduct(deps: KitDeps, options: KitOptions, endpoint: string): Promise<string | undefined> {
  try {
    const reply = await getJson(deps, options, `${endpoint}/catalog/search`, { method: "POST", body: JSON.stringify({ query: "*", pagination: { limit: 1 } }) });
    const found = z.looseObject({ products: z.array(z.looseObject({ id: z.string() })).min(1) }).safeParse(reply.json);
    return found.success ? found.data.products[0]!.id : undefined;
  } catch {
    return undefined;
  }
}

async function openCheckout(deps: KitDeps, options: KitOptions, endpoint: string, productId: string): Promise<{ status: number; json: unknown; checkout?: Checkout }> {
  try {
    const reply = await getJson(deps, options, `${endpoint}/checkout-sessions`, {
      method: "POST",
      body: JSON.stringify({
        line_items: [{ item: { id: productId }, quantity: 1 }],
        buyer: { email: options.email },
        fulfillment: { methods: [{ type: "shipping", destinations: [options.destination] }] },
      }),
    });
    const parsed = checkoutShape.safeParse(reply.json);
    return { ...reply, ...(parsed.success && reply.status < 300 ? { checkout: parsed.data } : {}) };
  } catch (error) {
    return { status: 0, json: { messages: [{ code: "network", content: why(error) }] } };
  }
}

interface Opened {
  readonly origin: string;
  readonly endpoint: string;
  readonly handlerId: string;
  readonly checkoutId: string;
  readonly requirements: Requirements;
  readonly lines: ReadonlyArray<{ readonly productId: string; readonly quantity: number }>;
  readonly raw: Record<string, unknown>;
  readonly profile: Profile;
}

/** The longest a signed authorization may stay valid: whoever saw it can settle it until it expires. */
export const MAX_SIGNED_VALIDITY_SECONDS = 120;

const C_TITLES = { C1: `refuses ${TAMPER_NOTE}, signed`, C2: "completes with the exact credential", C3: "settles a credential once" } as const;

function stopCharge(report: Report, after: "C1" | "C2", reason: string): void {
  if (after === "C1") report.skip("C2", "charge", C_TITLES.C2, reason);
  report.skip("C3", "charge", C_TITLES.C3, reason);
  skipReceipt(report, "needs a completed charge");
}

/**
 * The charge, with **one** signed authorization for the whole run: C1 sends it with `accepted` altered, C2 pays
 * with the same one through `@agentpey/ucp-stellar`, C3 replays it. Its nonce settles once at most, so a store that
 * lies about C1 cannot make the kit pay twice; and its validity is capped, so a store that kept it can settle it only
 * briefly. The payer's balance is read before and after, so a store that settled while refusing is caught.
 */
async function charge(report: Report, options: KitOptions, deps: KitDeps, opened: Opened): Promise<void> {
  const { payer, payerAddress, maxAmount } = options.charge!;
  const completeUrl = `${opened.endpoint}/checkout-sessions/${encodeURIComponent(opened.checkoutId)}/complete`;
  const amount = BigInt(opened.requirements.amount);

  // The kit's own ceiling, checked before anything is signed.
  let maxAtomic: bigint;
  try {
    maxAtomic = toAtomic(maxAmount, 7);
  } catch (error) {
    report.add("C1", "charge", C_TITLES.C1, "skip", `--max-amount: ${why(error)}`);
    stopCharge(report, "C1", "needs a valid --max-amount");
    return;
  }
  if (amount > maxAtomic) {
    report.add("C1", "charge", C_TITLES.C1, "skip", `the checkout costs ${fromAtomic(amount, 7)}, above --max-amount ${maxAmount}: nothing was signed`);
    stopCharge(report, "C1", "above --max-amount");
    return;
  }

  let before: bigint;
  try {
    before = await deps.readBalance(payerAddress, opened.requirements.asset);
  } catch (error) {
    report.add("C1", "charge", C_TITLES.C1, "skip", `could not read the payer's balance, so a settlement could not be told apart: ${why(error)}; nothing was signed`);
    stopCharge(report, "C1", "needs the payer's balance");
    return;
  }

  // The one signature, with a validity capped at MAX_SIGNED_VALIDITY_SECONDS whatever the store asks.
  const signFor = { ...opened.requirements, maxTimeoutSeconds: Math.min(opened.requirements.maxTimeoutSeconds, MAX_SIGNED_VALIDITY_SECONDS) };
  let signed = "";
  try {
    const payload = await payer.createPaymentPayload(2, signFor as Parameters<UcpStellarPayer["createPaymentPayload"]>[1]);
    signed = String((payload.payload as { transaction?: unknown }).transaction ?? "");
  } catch (error) {
    report.add("C1", "charge", C_TITLES.C1, "fail", `the payer could not sign: ${why(error)}`);
    stopCharge(report, "C1", "needs a signed payment (C1)");
    return;
  }
  if (signed === "") {
    report.add("C1", "charge", C_TITLES.C1, "fail", "the payer produced no transaction");
    stopCharge(report, "C1", "needs a signed payment (C1)");
    return;
  }

  // C1: the signed payment with `accepted` altered. A conforming store refuses before settling.
  const tampered = { ...opened.requirements, amount: (amount + 1n).toString() };
  let reply: { status: number; json: unknown };
  try {
    reply = await getJson(deps, options, completeUrl, { method: "POST", body: JSON.stringify(completeBody(opened.handlerId, tampered, signed)) });
  } catch (error) {
    report.add("C1", "charge", C_TITLES.C1, "fail", `the probe did not reach the store (${why(error)}); the store may hold the signed authorization until it expires, so nothing more is sent`);
    stopCharge(report, "C1", "C1 did not reach the store");
    return;
  }
  const answered = checkoutShape.safeParse(reply.json);
  if (answered.success && (answered.data.status === "completed" || answered.data.order !== undefined)) {
    report.add("C1", "charge", C_TITLES.C1, "fail", "the store completed the checkout with a really signed transaction whose accepted was altered; the spec says it MUST reject it");
    stopCharge(report, "C1", "the store already completed on C1's altered credential");
    return;
  }
  // A store that settled and still answered a refusal: the payer's balance says so.
  await deps.sleep(5_000);
  const afterProbe = await deps.readBalance(payerAddress, opened.requirements.asset).catch(() => undefined);
  if (afterProbe !== undefined && afterProbe < before) {
    report.add("C1", "charge", C_TITLES.C1, "fail", `the store answered a refusal but the payer's balance fell by ${fromAtomic(before - afterProbe, 7)}: it settled the altered credential`);
    stopCharge(report, "C1", "the store settled C1's altered credential");
    return;
  }
  refusalVerdict(report, "C1", "charge", C_TITLES.C1, reply, "with a really signed transaction", "the balance did not move");
  if (report.results.at(-1)?.outcome === "fail") {
    stopCharge(report, "C1", "the store did not refuse C1 as the spec says");
    return;
  }

  // C2: the same signed payment, through @agentpey/ucp-stellar (recheck on, maxAmount, the accepted asset). The
  // payer hands back the one signature, and only for the requirements it was signed for.
  const presigned: UcpStellarPayer = {
    scheme: payer.scheme,
    ...(payer.findDefaultAsset === undefined ? {} : { findDefaultAsset: payer.findDefaultAsset.bind(payer) }),
    createPaymentPayload: async (x402Version, requirements) => {
      const same = (["scheme", "network", "asset", "amount", "payTo"] as const).every((field) => requirements[field] === opened.requirements[field]);
      if (!same) throw new UcpStellarError("QuoteChanged", "the store now asks for other requirements than the ones signed", { details: { checkoutId: opened.checkoutId } });
      return { x402Version, payload: { transaction: signed } };
    },
  };
  const quoteToPay: PayableQuote = {
    storeUrl: opened.origin,
    endpoint: opened.endpoint,
    handlerId: opened.handlerId,
    checkoutId: opened.checkoutId,
    lines: opened.lines,
    requirements: opened.requirements as PayableQuote["requirements"],
    checkout: opened.raw,
  };
  let orderId: string;
  let receipt: unknown;
  try {
    const paid = await pay(quoteToPay, { payer: presigned, maxAmount, asset: options.charge!.asset, platformProfile: options.platformProfile, fetch: deps.fetch });
    orderId = paid.orderId;
    receipt = paid.receipt;
    report.add("C2", "charge", C_TITLES.C2, "pass", `order ${paid.orderId}, ${fromAtomic(BigInt(paid.paid.amount), 7)} paid to ${paid.paid.payTo}${paid.transaction === undefined ? "" : `, tx ${paid.transaction}`}`);
  } catch (error) {
    const sent = !isUcpStellarError(error) || error.paymentSent;
    report.add("C2", "charge", C_TITLES.C2, "fail", `${why(error)}${sent ? " (the payment may have been sent: read the checkout before trying again)" : " (nothing was sent)"}`);
    stopCharge(report, "C2", "needs a completed charge (C2)");
    return;
  }

  // C3: the same credential again makes no other order, and the payer paid exactly once.
  try {
    const again = await getJson(deps, options, completeUrl, { method: "POST", body: JSON.stringify(completeBody(opened.handlerId, opened.requirements, signed)) });
    const replayed = checkoutShape.safeParse(again.json);
    const otherOrder = replayed.success && replayed.data.order !== undefined && replayed.data.order.id !== orderId;
    const after = await deps.readBalance(payerAddress, opened.requirements.asset).catch(() => undefined);
    const drop = after === undefined ? undefined : before - after;
    if (otherOrder) report.add("C3", "charge", C_TITLES.C3, "fail", `the replay made another order, ${replayed.data!.order!.id}`);
    else if (drop !== undefined && drop > amount) report.add("C3", "charge", C_TITLES.C3, "fail", `the payer's balance fell by ${fromAtomic(drop, 7)}, more than the one payment of ${fromAtomic(amount, 7)}`);
    else {
      const paidOnce = drop === undefined ? "; the payer's balance could not be read again" : drop === amount ? `, and the payer's balance fell by ${fromAtomic(drop, 7)}: one payment` : `; the payer's balance fell by ${fromAtomic(drop, 7)} so far (the network may not show the payment yet)`;
      report.add("C3", "charge", C_TITLES.C3, "pass", `the replay made no other order (status ${again.status})${paidOnce}`);
    }
  } catch (error) {
    report.add("C3", "charge", C_TITLES.C3, "fail", `the replay could not reach the store: ${why(error)}`);
  }

  await receiptChecks(report, options, deps, opened, orderId, receipt);
}

function skipReceipt(report: Report, reason: string): void {
  for (const [id, title] of [["E1", "receipt on the checkout and the order"], ["E2", "receipt key in the profile"], ["E3", "receipt in the trusted registry"], ["E4", "receipt's three checks"]] as const) report.skip(id, "receipt", title, reason);
}

async function receiptChecks(report: Report, options: KitOptions, deps: KitDeps, opened: Opened, orderId: string, onCheckout: unknown): Promise<void> {
  if (opened.profile.ucp.capabilities?.[RECEIPT_EXTENSION] === undefined) {
    skipReceipt(report, `the store does not declare ${RECEIPT_EXTENSION} (optional)`);
    return;
  }
  const fromCheckout = receiptShape.safeParse(onCheckout);
  let order = await readOrderReceipt(deps, options, opened.endpoint, orderId);
  if (!fromCheckout.success || order === undefined || order.hash !== fromCheckout.data.hash) {
    report.add("E1", "receipt", "receipt on the checkout and the order", "fail", !fromCheckout.success ? "the completed checkout carries no receipt" : order === undefined ? `the order ${orderId} carries no receipt` : "the order's receipt is not the checkout's");
    for (const [id, title] of [["E2", "receipt key in the profile"], ["E3", "receipt in the trusted registry"], ["E4", "receipt's three checks"]] as const) report.skip(id, "receipt", title, "needs the receipt (E1)");
    return;
  }
  report.add("E1", "receipt", "receipt on the checkout and the order", "pass", `${fromCheckout.data.hash}, settlement ${fromCheckout.data.settlement_tx_hash}`);

  // E2: the signing key is published in the profile.
  const kid = kidOf(order.jws);
  const keys = (opened.profile.keys ?? []).flatMap((key) => {
    const parsed = publishedKey.safeParse(key);
    return parsed.success ? [parsed.data] : [];
  });
  // The key published under that kid must be the one its did:stellar names (the one E4 verifies with).
  const expectedX = kid === undefined ? undefined : didKeyX(kid);
  const published = keys.find((key) => key.kid === kid && key.kty === "OKP" && key.crv === "Ed25519");
  if (published === undefined) report.add("E2", "receipt", "receipt key in the profile", "fail", `the receipt is signed by ${kid ?? "(no kid)"}, which the profile's keys do not publish as an Ed25519 key`);
  else if (expectedX === undefined || published.x !== expectedX) report.add("E2", "receipt", "receipt key in the profile", "fail", `the profile publishes ${kid} with another key (x ${published.x ?? "(none)"}) than its did:stellar names (${expectedX ?? "unreadable"})`);
  else report.add("E2", "receipt", "receipt key in the profile", "pass", `${kid}, the key its did:stellar names`);

  // E3: anchored in the registry the caller trusts.
  const trusted = order.anchor.registry === options.registry;
  report.add("E3", "receipt", "receipt in the trusted registry", trusted ? "pass" : "fail", trusted ? options.registry : `the receipt names registry ${order.anchor.registry}; the kit trusts ${options.registry} (pass --registry to trust another)`);

  // E4: the three checks, once the anchor is in (it is asynchronous).
  const deadline = Date.now() + (options.anchorWaitMs ?? 60_000);
  while (order.anchor.status !== "anchored" && Date.now() < deadline) {
    await deps.sleep(3_000);
    order = (await readOrderReceipt(deps, options, opened.endpoint, orderId)) ?? order;
  }
  const verification = await deps.verifyReceipt(order.jws, deps.registry(options.registry));
  const waited = Math.round((options.anchorWaitMs ?? 60_000) / 1000);
  if (!verification.valid && order.anchor.status !== "anchored" && verification.checks.signature.ok && verification.checks.settlement.ok) {
    report.add("E4", "receipt", "receipt's three checks", "warn", `signature ok, settlement ok, and the anchor still ${order.anchor.status} after ${waited} s (anchoring is asynchronous: read the order again later, or raise --anchor-wait)`);
    return;
  }
  const parts = [`signature ${verification.checks.signature.ok ? "ok" : `no (${verification.checks.signature.reason ?? ""})`}`, `anchor ${verification.checks.anchored.ok ? "ok" : `no (${verification.checks.anchored.reason ?? order.anchor.status})`}`, `settlement ${verification.checks.settlement.ok ? "ok" : `no (${verification.checks.settlement.reason ?? ""})`}`];
  report.add("E4", "receipt", "receipt's three checks", verification.valid ? "pass" : "fail", parts.join(", "));
}

/** The base64url Ed25519 key a `did:stellar:<network>:G…[#fragment]` names; undefined when it names none. */
function didKeyX(kid: string): string | undefined {
  const account = /^did:stellar:[a-z]+:(G[A-Z2-7]{55})(?:#.*)?$/.exec(kid)?.[1];
  if (account === undefined || !StrKey.isValidEd25519PublicKey(account)) return undefined;
  return Buffer.from(StrKey.decodeEd25519PublicKey(account)).toString("base64url");
}

/** The `kid` of a compact JWS's protected header, without verifying anything (E4 verifies). */
function kidOf(jws: string): string | undefined {
  try {
    const header: unknown = JSON.parse(Buffer.from(jws.split(".")[0] ?? "", "base64url").toString("utf8"));
    return z.looseObject({ kid: z.string() }).safeParse(header).data?.kid;
  } catch {
    return undefined;
  }
}

async function readOrderReceipt(deps: KitDeps, options: KitOptions, endpoint: string, orderId: string): Promise<Receipt | undefined> {
  try {
    const reply = await getJson(deps, options, `${endpoint}/orders/${encodeURIComponent(orderId)}`);
    const parsed = z.looseObject({ receipt: receiptShape }).safeParse(reply.json);
    return parsed.success ? parsed.data.receipt : undefined;
  } catch {
    return undefined;
  }
}
