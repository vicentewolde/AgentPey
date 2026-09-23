import { FeeBumpTransaction, Networks, TransactionBuilder, scValToNative } from "@stellar/stellar-sdk";
import { isStellarAccount, isStellarContractId } from "@vitrinee/core";

/**
 * Who paid, read from the transaction the payer signed: the `from` argument
 * of the SEP-41 `transfer` the x402 payload carries. Never trusts the body.
 * Accepts the inner transaction or a fee bump around it. The payer is a
 * classic account (G...) or a smart account (C...) such as AgentPey's
 * `policy_rail` (VT-22).
 */
export function payerFromTransactionXdr(xdrBase64: string): string | undefined {
  try {
    const parsed = TransactionBuilder.fromXDR(xdrBase64, Networks.TESTNET);
    const tx = parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed;
    const op = tx.operations[0];
    if (op === undefined || op.type !== "invokeHostFunction") return undefined;
    const fn = op.func;
    if (fn.type !== "hostFunctionTypeInvokeContract") return undefined;
    if (fn.invokeContract.functionName.toString() !== "transfer") return undefined;
    const first = fn.invokeContract.args[0];
    if (first === undefined) return undefined;
    const from: unknown = scValToNative(first);
    return typeof from === "string" && (isStellarAccount(from) || isStellarContractId(from)) ? from : undefined;
  } catch {
    return undefined;
  }
}
