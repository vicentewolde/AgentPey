/**
 * Money as integers: a decimal amount of the asset ("2.50") and the atomic
 * units a Stellar transfer moves (25000000 at seven decimals) convert exactly,
 * through `bigint`, never through a float.
 */
import { UcpStellarError } from "./errors.js";

const DECIMAL = /^(0|[1-9]\d*)(?:\.(\d+))?$/;

/**
 * @throws UcpStellarError `InvalidArguments` unless `value` is a non-negative decimal with at most `decimals` places
 */
export function toAtomic(value: string, decimals: number): bigint {
  const match = DECIMAL.exec(value);
  const fraction = match?.[2] ?? "";
  if (match === null || fraction.length > decimals) {
    throw new UcpStellarError("InvalidArguments", `"${value}" is not a non-negative decimal with at most ${decimals} places`, { details: { value, decimals } });
  }
  return BigInt(match[1]!) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** Atomic units back to a decimal string, with every place shown ("1.5684211"). */
export function fromAtomic(atomic: bigint, decimals: number): string {
  const sign = atomic < 0n ? "-" : "";
  const abs = atomic < 0n ? -atomic : atomic;
  const scale = 10n ** BigInt(decimals);
  const whole = (abs / scale).toString();
  return decimals === 0 ? `${sign}${whole}` : `${sign}${whole}.${(abs % scale).toString().padStart(decimals, "0")}`;
}
