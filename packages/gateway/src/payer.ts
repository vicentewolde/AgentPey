import { FeeBumpTransaction, Networks, TransactionBuilder, scValToNative, type xdr } from "@stellar/stellar-sdk";

/** The XDR union at runtime: js-xdr unions expose `switch()` and one accessor per arm. */
interface HostFunctionUnion {
  switch(): { name: string };
  invokeContract(): { args(): xdr.ScVal[] };
}

/**
 * Who paid, read from the transaction the payer signed: the `from` argument
 * of the SEP-41 `transfer` the x402 payload carries. Never trusts the body.
 */
export function payerFromTransactionXdr(xdrBase64: string): string | undefined {
  try {
    const parsed = TransactionBuilder.fromXDR(xdrBase64, Networks.TESTNET);
    const tx = parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed;
    const op = tx.operations[0];
    if (op === undefined || op.type !== "invokeHostFunction") return undefined;
    const fn = op.func as unknown as HostFunctionUnion;
    if (fn.switch().name !== "hostFunctionTypeInvokeContract") return undefined;
    const first = fn.invokeContract().args()[0];
    if (first === undefined) return undefined;
    const from: unknown = scValToNative(first);
    return typeof from === "string" && from.startsWith("G") ? from : undefined;
  } catch {
    return undefined;
  }
}
