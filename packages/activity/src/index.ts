/**
 * What a tenant may be shown about their own agent — computed once, read by
 * everyone who shows it.
 *
 * These functions were written in T71 for `apps/status-dashboard`, the
 * internal operator panel. T76 needed the same three numbers on
 * `GET /v1/tenants/{id}/activity`, which a partner's own users read. Rather
 * than write them a second time, they moved here and both callers import
 * them.
 *
 * **Why that matters more than tidiness.** `C-73` settled the rule when the
 * internal panel was built: a number shown about spending must come from the
 * same computation the authorisation itself performs, never a second sum.
 * `readPerDayUsage` calls the very `spentOn` that `PolicyRail.authorise()`
 * calls before deciding. Had T76 reimplemented it for `/v1`, the two would
 * have been free to drift — and a dashboard that disagrees with the
 * enforcement is worse than no dashboard, because it is believed.
 *
 * Everything here is **read-only by construction**: the ports below have no
 * write method, so no route built on them can grow one by accident.
 */
import { AgentPassError } from "@agentpass/core";
import type { AgentInstance, MandateRecord, Tenant } from "@agentpey/directory";
import { agentPayMandateSchema } from "@agentpey/mandate";
import type { VaultRecord, VaultVerification } from "@agentpey/vault";

/**
 * The read-only view of the directory these functions need. Keeping write
 * methods out of the type makes them unavailable to every caller.
 */
export interface ActivityDirectory {
  findTenant(id: string): Promise<Tenant | undefined>;
  listMandates(tenantId: string): Promise<readonly MandateRecord[]>;
  /** Which of a tenant's agents have their own `policy_rail` (F6/T58), to read its balance. */
  listAgents(tenantId: string): Promise<readonly AgentInstance[]>;
}

/** The vault's read-only half; append operations are intentionally absent. */
export interface VaultReader {
  list(subject?: string): readonly VaultRecord[];
  verify(): VaultVerification;
  /** Today's total for one subject/currency — the same read `PolicyRail.authorise()` makes before deciding. */
  spentOn(subject: string, currency: string, at: Date): Promise<string>;
}

/** Construction is injected so HTTP handling never needs a database write API. */
export type VaultReaderFactory = (tenantId: string) => Promise<VaultReader>;

export async function requireTenant(directory: ActivityDirectory, tenantId: string): Promise<Tenant> {
  const tenant = await directory.findTenant(tenantId);
  if (tenant === undefined) {
    throw new AgentPassError("TenantNotFound", "no tenant with that id", { details: { tenantId } });
  }
  return tenant;
}

/** Same fraction-of-limit convention as an ordinary usage alert: warn with headroom left, not at exhaustion. */
export const PERDAY_WARNING_RATIO = 0.8;

/** Most recent mandate that is neither revoked nor past `validUntil`, as of `now` — `undefined` if there is none. */
export function activeMandate(mandates: readonly MandateRecord[], now: Date): MandateRecord | undefined {
  return mandates
    .filter((mandate) => mandate.revokedAt === null && mandate.validUntil.getTime() > now.getTime())
    .toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
}

export interface PerDayUsage {
  readonly subject: string;
  readonly currency: string;
  readonly perDayLimit: string;
  readonly spentToday: string;
  /** `spentToday / perDayLimit`, `0` if the limit itself is `0`. */
  readonly ratio: number;
  readonly nearLimit: boolean;
}

/**
 * How much of the tenant's active Mandate's `perDay` limit is already spent
 * today — the same `spentOn` read `PolicyRail.authorise()` makes before every
 * purchase decision, here only ever read, never fed back into a decision.
 * `undefined` when the tenant has no active (unrevoked, unexpired) Mandate to
 * measure against.
 */
export async function readPerDayUsage(
  directory: ActivityDirectory,
  vaultFactory: VaultReaderFactory,
  tenantId: string,
  now: Date = new Date(),
): Promise<PerDayUsage | undefined> {
  const tenant = await requireTenant(directory, tenantId);
  const mandates = await directory.listMandates(tenant.id);
  const mandate = activeMandate(mandates, now);
  if (mandate === undefined) return undefined;

  // Re-validated at this boundary, same discipline as every other Postgres
  // row this codebase reads — `document` is stored as an opaque record
  // (`@agentpey/directory` never depends on `@agentpey/mandate`'s shape), so
  // nothing here may assume it parses.
  const parsed = agentPayMandateSchema.safeParse(mandate.document);
  if (!parsed.success) return undefined;

  const { id: subject, grant } = parsed.data.credentialSubject;
  const { perDay: perDayLimit, currency } = grant.limits;

  const vault = await vaultFactory(tenant.id);
  const spentToday = await vault.spentOn(subject, currency, now);

  const limitNumber = Number(perDayLimit);
  const ratio = limitNumber > 0 ? Number(spentToday) / limitNumber : 0;
  return { subject, currency, perDayLimit, spentToday, ratio, nearLimit: ratio >= PERDAY_WARNING_RATIO };
}

export interface RefusalSummary {
  readonly at: string;
  readonly intentId: string;
  readonly code: string;
  readonly reason: string;
}

/** The `refused` entries of an already-fetched vault slice, most recent first, capped at `limit`. */
export function recentRefusals(records: readonly VaultRecord[], limit = 20): readonly RefusalSummary[] {
  const refusals = records
    .map((record) => record.entry)
    .filter((entry): entry is Extract<VaultRecord["entry"], { readonly kind: "refused" }> => entry.kind === "refused");

  return refusals
    .toSorted((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit)
    .map(({ at, intentId, code, reason }) => ({ at, intentId, code, reason }));
}

// ---- Sponsored testnet credit (T77) ----------------------------------------

/**
 * The pilot's sponsored-credit policy, in one place (`C-80`).
 *
 * These live here and not next to the code that deploys a rail for the same
 * reason `readPerDayUsage` does: the pre-flight check that *refuses* to
 * sponsor another tenant and the panel that *shows* how much credit is left
 * have to agree, and two copies of "twenty" is two numbers that can drift
 * apart in exactly the situation where being wrong is expensive.
 */
/**
 * 3 USDC since 2026-09-23 (`C-131`): 1 USDC (`C-80`) was less than the cheapest
 * real product a Vitrinee store sells (1.0421053 USDC). A rail already funded
 * keeps what it got; only rails deployed from now on start with this.
 */
export const SPONSORED_FUNDING_PER_TENANT = "3.0000000";
export const MAX_SPONSORED_RAILS = 20;
/** Warn while there is still credit for this many more tenants, not at exhaustion. */
export const SPONSORED_RAILS_WARNING_HEADROOM = 5;

export interface SponsoredCreditStatus {
  readonly funded: number;
  readonly cap: number;
  /** Whichever binds first: the cap, or what the reserve can actually afford. */
  readonly remaining: number;
  readonly reserveUsdc: string;
  readonly nearExhaustion: boolean;
}

/** How many rails the reserve has funded, across every tenant. */
export interface SponsoredCreditDirectory {
  countFundedRails(): Promise<number>;
}

/**
 * How much sponsored credit is left, changing nothing. `readUsdcBalance` is
 * injected — a SEP-41 `balance()` simulation, never a transfer — the same
 * seam every other read here uses.
 */
export async function readSponsoredCreditStatus(
  directory: SponsoredCreditDirectory,
  reserveAddress: string,
  readUsdcBalance: (address: string) => Promise<string>,
): Promise<SponsoredCreditStatus> {
  const [funded, reserveUsdc] = await Promise.all([directory.countFundedRails(), readUsdcBalance(reserveAddress)]);
  const affordable = Math.floor(Number(reserveUsdc) / Number(SPONSORED_FUNDING_PER_TENANT));
  const remaining = Math.max(0, Math.min(MAX_SPONSORED_RAILS - funded, affordable));
  return {
    funded,
    cap: MAX_SPONSORED_RAILS,
    remaining,
    reserveUsdc,
    nearExhaustion: remaining <= SPONSORED_RAILS_WARNING_HEADROOM,
  };
}

export interface RailBalance {
  readonly agentId: string;
  readonly contractId: string;
  /** The scaled USDC balance as a string, or `"error: <message>"` if the read itself failed. */
  readonly usdc: string;
  readonly low: boolean;
}

/** Below this, a rail is one or two purchases away from failing on an empty balance — same threshold `scripts/check-rail-balances.ts` (T60) uses. */
export const LOW_USDC_WARNING = "0.0050000";

/**
 * The USDC balance of every `policy_rail` the tenant's agents own (F6/T58;
 * `null` until an agent pays for the first time). `readBalance` is injected —
 * a SEP-41 `balance()` simulation of the rail's own address, never a
 * `transfer` — so this module stays ignorant of the Stellar SDK, the same
 * seam `vaultFactory` already uses for Postgres.
 */
export async function readRailBalances(
  directory: ActivityDirectory,
  tenantId: string,
  readBalance: (railContractId: string) => Promise<string>,
): Promise<readonly RailBalance[]> {
  const tenant = await requireTenant(directory, tenantId);
  const agents = await directory.listAgents(tenant.id);
  const withRail = agents.filter(
    (agent): agent is AgentInstance & { readonly policyRailContractId: string } => agent.policyRailContractId !== null,
  );

  return Promise.all(
    withRail.map(async (agent) => {
      const { id: agentId, policyRailContractId: contractId } = agent;
      const usdc = await readBalance(contractId).catch((error: unknown) => `error: ${String(error)}`);
      const low = !usdc.startsWith("error") && Number(usdc) < Number(LOW_USDC_WARNING);
      return { agentId, contractId, usdc, low };
    }),
  );
}
