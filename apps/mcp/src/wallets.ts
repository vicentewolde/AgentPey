/**
 * The closed list of wallets the MCP serves, one spending account each (T186, `Y-4`, `R-33`).
 *
 * Each person on the list has their own `policy_rail`, with their wallet as its `principal` and limits chosen when it
 * was deployed, owned by an agent key derived for them alone from `MCP_AGENT_MNEMONIC` (SEP-0005, `@agentpey/tenancy`):
 * a leaked key reaches one person's rail, never another's. The file holds public facts only (addresses, contract ids,
 * limits); the one secret behind it is the mnemonic, which never appears here.
 *
 * `pnpm run buyer:onboard` adds entries. T187 reads the list at startup to pick the rail of whoever signed in.
 */
import { AgentPassError, decimalAmountSchema } from "@agentpass/core";
import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";

/** Where the list lives, relative to `apps/mcp`. Versioned: nothing in it is secret. */
export const WALLETS_FILE = "wallets.testnet.json";

/**
 * Derived indices start at 1. The wallet the MCP served before this list keeps its own, non-derived key (T171 §7),
 * so no derived key ever stands in for it.
 */
export const FIRST_AGENT_INDEX = 1;
/** `deriveTenantKeypair` maps index n to account 2n; this keeps 2n inside BIP-32's hardened range. */
export const MAX_AGENT_INDEX = 2 ** 30 - 1;

const account = z.string().refine((value) => StrKey.isValidEd25519PublicKey(value), "not a Stellar account (G...)");
const contract = z.string().refine((value) => StrKey.isValidContract(value), "not a Stellar contract id (C...)");

export const walletEntrySchema = z.strictObject({
  /** The person's wallet: the rail's `principal`, and the account that signs in. */
  wallet: account,
  /** SEP-0005 index of their agent key, from `MCP_AGENT_MNEMONIC`. */
  agentIndex: z.number().int().min(FIRST_AGENT_INDEX).max(MAX_AGENT_INDEX),
  /** The derived agent key's public half: the rail's `owner`. */
  agent: account,
  rail: contract,
  /** The limits the network enforces on every payment from this rail, read back from it after deploying. */
  perTx: decimalAmountSchema,
  perDay: decimalAmountSchema,
  addedAt: z.iso.datetime(),
});
export type WalletEntry = z.infer<typeof walletEntrySchema>;

export const walletsFileSchema = z
  .strictObject({
    network: z.literal("testnet"),
    wallets: z.array(walletEntrySchema),
  })
  .superRefine((file, ctx) => {
    for (const field of ["wallet", "agentIndex", "agent", "rail"] as const) {
      const seen = new Set<string | number>();
      for (const entry of file.wallets) {
        if (seen.has(entry[field])) ctx.addIssue({ code: "custom", message: `${field} ${String(entry[field])} appears twice`, path: ["wallets"] });
        seen.add(entry[field]);
      }
    }
  });
export type WalletsFile = z.infer<typeof walletsFileSchema>;

export const EMPTY_WALLETS_FILE: WalletsFile = { network: "testnet", wallets: [] };

/** @throws AgentPassError `ConfigError` naming what is wrong, for a file that is not valid JSON or not a valid list. */
export function parseWalletsFile(text: string): WalletsFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new AgentPassError("ConfigError", `${WALLETS_FILE} is not valid JSON`, { cause: error, details: {} });
  }
  const parsed = walletsFileSchema.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new AgentPassError("ConfigError", `${WALLETS_FILE} is not a valid wallet list: ${problems.join("; ")}`, { details: { problems } });
  }
  return parsed.data;
}

/** The index the next person gets: one past the highest in use, so an index is never handed out twice. */
export function nextAgentIndex(file: WalletsFile): number {
  return file.wallets.reduce((max, entry) => Math.max(max, entry.agentIndex), FIRST_AGENT_INDEX - 1) + 1;
}

/**
 * Whether this wallet may be added with this index, checked before anything is derived or deployed.
 * @throws AgentPassError `WalletAlreadyListed` or `AgentIndexTaken`.
 */
export function assertCanAdd(file: WalletsFile, wallet: string, agentIndex: number): void {
  const listed = file.wallets.find((entry) => entry.wallet === wallet);
  if (listed !== undefined) {
    throw new AgentPassError("WalletAlreadyListed", "this wallet already has a spending account", { details: { wallet, rail: listed.rail } });
  }
  const taken = file.wallets.find((entry) => entry.agentIndex === agentIndex);
  if (taken !== undefined) {
    throw new AgentPassError("AgentIndexTaken", "this agent index is already someone else's key", { details: { agentIndex, wallet: taken.wallet } });
  }
}

/** The list with one more person. @throws AgentPassError when the entry is malformed or collides with one listed. */
export function addWallet(file: WalletsFile, entry: WalletEntry): WalletsFile {
  assertCanAdd(file, entry.wallet, entry.agentIndex);
  const next = { network: file.network, wallets: [...file.wallets, walletEntrySchema.parse(entry)] };
  const checked = walletsFileSchema.safeParse(next);
  if (!checked.success) {
    throw new AgentPassError("ConfigError", "the new entry collides with one already listed", { details: { problems: checked.error.issues.map((issue) => issue.message) } });
  }
  return checked.data;
}

/** Stable, human-diffable JSON: the file is reviewed in pull requests. */
export function formatWalletsFile(file: WalletsFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}
