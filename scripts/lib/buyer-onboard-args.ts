/**
 * Arguments of `pnpm run buyer:onboard` (T186), parsed and checked before any key is read or derived. Pure, so the
 * limits it enforces have a test.
 */
import { AgentPassError, decimalAmountSchema } from "@agentpass/core";
import { StrKey } from "@stellar/stellar-sdk";

/**
 * The highest daily limit one person's rail may be deployed with. The rail is funded from AgentPey's testnet reserve
 * (T192); a limit typed with one digit too many should not be able to ask for more than a demo ever spends. Raise it by
 * editing this line, on purpose.
 */
export const MAX_PER_DAY_USDC = "50";
/** What a rail gets when no limits are given: what the MCP's single rail has today (`R-9`). */
export const DEFAULT_PER_TX_USDC = "3";
export const DEFAULT_PER_DAY_USDC = "5";

export interface BuyerOnboardArgs {
  /** The person's wallet: the rail's principal, the one that withdraws, and the account that signs in. */
  readonly principal: string;
  /** Their agent index; undefined means the next free one in the list. */
  readonly agentIndex: number | undefined;
  readonly perTx: string;
  readonly perDay: string;
  /** Without `--yes` the command only shows what it would do. */
  readonly confirmed: boolean;
  /** Writes a fresh `MCP_AGENT_MNEMONIC` to `.env.local`, only when it has none. */
  readonly initMnemonic: boolean;
}

const USAGE = "usage: pnpm run buyer:onboard -- --principal G... [--per-tx 3] [--per-day 5] [--index <n>] [--init-mnemonic] [--yes]";
const VALUE_FLAGS = new Set(["--principal", "--per-tx", "--per-day", "--index"]);
const SWITCHES = new Set(["--yes", "--init-mnemonic"]);

function invalid(message: string, details: Record<string, unknown>): AgentPassError {
  return new AgentPassError("InvalidArguments", message, { details: { ...details, usage: USAGE } });
}

/** A decimal already checked by `decimalAmountSchema`, in USDC's seven-decimal atomic units. */
function toScaledAmount(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, "0"));
}

function amount(flag: string, value: string): string {
  if (!decimalAmountSchema.safeParse(value).success || toScaledAmount(value) <= 0n) {
    throw invalid(`${flag} must be a positive USDC amount with at most seven decimals`, { [flag]: value });
  }
  return value;
}

export function parseBuyerOnboardArgs(input: readonly string[]): BuyerOnboardArgs {
  // `pnpm run buyer:onboard -- <args>` hands the separator on to the script.
  const argv = input.filter((arg) => arg !== "--");
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.includes("=")) throw invalid("write each option and its value with a space, not =", { arg });
    if (SWITCHES.has(arg)) {
      switches.add(arg);
    } else if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw invalid(`${arg} needs a value`, { arg });
      if (values.has(arg)) throw invalid(`${arg} was given twice`, { arg });
      values.set(arg, value.trim());
      i++;
    } else {
      throw invalid("unknown argument", { arg });
    }
  }

  const principal = values.get("--principal") ?? "";
  if (principal === "") throw invalid("--principal <G...> is required: the wallet that owns the money in the rail", {});
  if (!StrKey.isValidEd25519PublicKey(principal)) throw invalid("--principal is not a Stellar account (G...)", { principal });

  const rawIndex = values.get("--index");
  let agentIndex: number | undefined;
  if (rawIndex !== undefined) {
    if (!/^[1-9][0-9]{0,8}$/.test(rawIndex)) throw invalid("--index must be a whole number from 1 (0 is the MCP's original wallet)", { index: rawIndex });
    agentIndex = Number(rawIndex);
  }

  const perTx = amount("--per-tx", values.get("--per-tx") ?? DEFAULT_PER_TX_USDC);
  const perDay = amount("--per-day", values.get("--per-day") ?? DEFAULT_PER_DAY_USDC);
  if (toScaledAmount(perTx) > toScaledAmount(perDay)) throw invalid("--per-tx cannot be above --per-day", { perTx, perDay });
  if (toScaledAmount(perDay) > toScaledAmount(MAX_PER_DAY_USDC)) {
    throw invalid(`--per-day cannot be above ${MAX_PER_DAY_USDC} USDC`, { perDay, max: MAX_PER_DAY_USDC });
  }

  return { principal, agentIndex, perTx, perDay, confirmed: switches.has("--yes"), initMnemonic: switches.has("--init-mnemonic") };
}
