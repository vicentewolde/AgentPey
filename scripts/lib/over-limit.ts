/**
 * The one transformation `rail:over-limit` (T189) needs: the same rail authorization, for a different amount.
 *
 * A Soroban transaction carries a footprint, the exact ledger entries it may touch, and the network computes it by
 * simulating. A payment over a rail's `per_tx` cannot be simulated to success (that is the point), so the script takes
 * the footprint of a payment within the limit and sends the over-limit one with it. The two must touch the same
 * entries, and the authorization's nonce is one of them: so the over-limit entry is the within-limit entry, same nonce,
 * with only the amount changed, then signed again by the owner.
 *
 * stellar-sdk 17: XDR values are `{ type, <field> }` objects, read and rebuilt here without mutating the input.
 */
import { AgentPassError } from "@agentpass/core";
import { nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";

type Entry = xdr.SorobanAuthorizationEntry;

function invalid(message: string, details: Record<string, unknown> = {}): AgentPassError {
  return new AgentPassError("InvalidArguments", message, { details });
}

/** The `transfer(from, to, amount)` call an authorization covers. @throws AgentPassError for anything else. */
function transferCall(entry: Entry): { readonly args: readonly xdr.ScVal[] } {
  const fn = entry.rootInvocation.function;
  if (fn.type !== "sorobanAuthorizedFunctionTypeContractFn") throw invalid("the authorization is not a contract call");
  const call = fn.contractFn;
  const name = String(call.functionName);
  if (name !== "transfer" || call.args.length !== 3) throw invalid("the authorization is not a SEP-41 transfer(from, to, amount)", { function: name, args: call.args.length });
  return call;
}

/** The amount a SEP-41 transfer authorization moves, in atomic units. */
export function transferAmountOf(entry: Entry): bigint {
  return BigInt(scValToNative(transferCall(entry).args[2]!) as bigint);
}

/** A copy of `entry` moving `amount` instead: nonce, addresses and expiry unchanged, the old signature cleared. */
export function withTransferAmount(entry: Entry, amount: bigint): Entry {
  if (amount <= 0n) throw invalid("the amount must be positive", { amount: amount.toString() });
  const { args } = transferCall(entry);
  const fn = entry.rootInvocation.function;
  if (fn.type !== "sorobanAuthorizedFunctionTypeContractFn") throw invalid("the authorization is not a contract call");
  const current = entry.credentials;
  const credentials =
    current.type === "sorobanCredentialsAddress"
      ? xdr.SorobanCredentials.sorobanCredentialsAddress(
          new xdr.SorobanAddressCredentials({
            address: current.address.address,
            nonce: current.address.nonce,
            signatureExpirationLedger: current.address.signatureExpirationLedger,
            signature: xdr.ScVal.scvVoid(),
          }),
        )
      : current;
  return new xdr.SorobanAuthorizationEntry({
    credentials,
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: fn.contractFn.contractAddress,
          functionName: fn.contractFn.functionName,
          args: [args[0]!, args[1]!, nativeToScVal(amount, { type: "i128" })],
        }),
      ),
      subInvocations: entry.rootInvocation.subInvocations,
    }),
  });
}

/** `policy_rail`'s `Error::PerTxExceeded` (contracts/policy-rail/src/lib.rs). */
export const PER_TX_EXCEEDED = 7;

/**
 * The contract error a smart account's `__check_auth` answered, read from a simulation's diagnostic events. The host
 * reports any such failure as `Error(Auth, InvalidAction)`; only the event "failed account authentication with error"
 * says which account refused and with which code. @returns undefined when no such event names `account`.
 */
export function accountRefusal(events: unknown, account: string): number | undefined {
  const text = JSON.stringify(events ?? [], (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
  for (const match of text.matchAll(/"failed account authentication with error"\},\{"address":"(C[A-Z2-7]{55})"\},\{"error":\{"contract":(\d+)\}/g)) {
    if (match[1] === account) return Number(match[2]);
  }
  return undefined;
}

