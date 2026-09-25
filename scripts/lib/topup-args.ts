/**
 * Arguments of `pnpm run rail:topup`, parsed and checked before any key is
 * read. Pure, so the limits it enforces have a test.
 */
import { AgentPassError } from "@agentpass/core";
import { StrKey } from "@stellar/stellar-sdk";

/**
 * The most one command moves. The reserve exists to sponsor new tenants
 * (`C-80`); a top-up typed with one digit too many should not be able to empty
 * it. Raise it by editing this line, on purpose.
 */
export const MAX_TOPUP_USDC = 20;

export interface TopupArgs {
  readonly rail: string;
  /** Decimal string with at most seven decimals, as USDC uses. */
  readonly amount: string;
  /** Without `--yes` the command only shows what it would do. */
  readonly confirmed: boolean;
}

function invalid(message: string, details: Record<string, unknown>): AgentPassError {
  return new AgentPassError("InvalidArguments", message, { details });
}

export function parseTopupArgs(input: readonly string[]): TopupArgs {
  // `pnpm run rail:topup -- <args>` hands the separator on to the script.
  const argv = input.filter((arg) => arg !== "--");
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const confirmed = argv.includes("--yes");
  const unknown = argv.filter((arg) => arg.startsWith("--") && arg !== "--yes");
  if (unknown.length > 0) throw invalid("unknown option", { unknown });
  const [rail, amount, ...extra] = positional;
  if (rail === undefined || amount === undefined || extra.length > 0) {
    throw invalid("usage: pnpm run rail:topup -- <rail contract C...> <amount in USDC> [--yes]", { received: argv });
  }
  if (!StrKey.isValidContract(rail)) {
    throw invalid("the first argument must be a contract address (C...), the tenant's policy_rail", { rail });
  }
  if (!/^\d{1,4}(\.\d{1,7})?$/.test(amount)) {
    throw invalid("the amount must be a plain decimal, for example 10 or 7.5", { amount });
  }
  const value = Number(amount);
  if (!(value > 0) || value > MAX_TOPUP_USDC) {
    throw invalid(`the amount must be above 0 and at most ${String(MAX_TOPUP_USDC)} USDC per command`, { amount, max: MAX_TOPUP_USDC });
  }
  return { rail, amount, confirmed };
}
