/**
 * The edit a dishonest party would make: lower the amount in the receipt,
 * re-encode it, keep the original signature. Returns what changed so the
 * demo can say it out loud.
 */
import { parseDecimal, usdcAtomicToDecimal } from "@vitrinee/core";

export function tamperAmount(jws: string): { jws: string; from: string; to: string } {
  const [h, p, s] = jws.trim().split(".");
  if (h === undefined || p === undefined || s === undefined) throw new Error("not a compact JWS");
  const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, unknown>;
  const from = String(claims["amountUSDC"]);
  const lowered = parseDecimal(from, 7) / 10n || 1n;
  const to = usdcAtomicToDecimal(lowered);
  const edited = { ...claims, amountUSDC: to, amountUSDCAtomic: lowered.toString() };
  return { jws: `${h}.${Buffer.from(JSON.stringify(edited)).toString("base64url")}.${s}`, from, to };
}
