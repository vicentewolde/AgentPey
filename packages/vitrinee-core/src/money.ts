/**
 * Money is integers, end to end. A catalogue price in CLP becomes an amount of
 * USDC atomic units (stroops, 7 decimals) through exact bigint arithmetic and
 * one explicit rounding step. No floats touch an amount anywhere in Vitrinee.
 */
import { VitrineeError } from "./errors.js";

export const USDC_DECIMALS = 7;

/** Minor-unit decimals for the currencies a LATAM storefront prices in. */
export const CURRENCY_DECIMALS: Readonly<Record<string, number>> = {
  CLP: 0,
  ARS: 2,
  BRL: 2,
  COP: 2,
  MXN: 2,
  PEN: 2,
  UYU: 2,
  USD: 2,
  USDC: USDC_DECIMALS,
};

const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;

export function currencyDecimals(currency: string): number {
  const decimals = CURRENCY_DECIMALS[currency.toUpperCase()];
  if (decimals === undefined) {
    throw new VitrineeError("ValidationError", `unsupported currency "${currency}"`, {
      details: { currency },
    });
  }
  return decimals;
}

/** Number of fractional digits written in a decimal string ("950" → 0, "949.99" → 2). */
export function decimalPlaces(value: string): number {
  const match = DECIMAL_RE.exec(value.trim());
  if (!match) {
    throw new VitrineeError("ValidationError", `not a decimal string: "${value}"`, {
      details: { value },
    });
  }
  return match[2]?.length ?? 0;
}

/**
 * Parses a non-negative decimal string into atomic units. Rejects signs,
 * exponents, thousands separators and more precision than the unit allows,
 * because silently truncating money is how amounts drift.
 */
export function parseDecimal(value: string, decimals: number): bigint {
  const match = DECIMAL_RE.exec(value.trim());
  if (!match) {
    throw new VitrineeError("ValidationError", `not a decimal string: "${value}"`, {
      details: { value },
    });
  }
  const intPart = match[1] ?? "0";
  const fracPart = match[2] ?? "";
  if (fracPart.length > decimals) {
    throw new VitrineeError(
      "ValidationError",
      `"${value}" has more than ${decimals} decimal place${decimals === 1 ? "" : "s"}`,
      { details: { value, decimals } },
    );
  }
  return BigInt(intPart + fracPart.padEnd(decimals, "0"));
}

/** Formats atomic units as a plain decimal string with exactly `decimals` places. */
export function formatUnits(atomic: bigint, decimals: number): string {
  if (atomic < 0n) {
    throw new VitrineeError("ValidationError", "amounts cannot be negative", {
      details: { atomic: atomic.toString() },
    });
  }
  const digits = atomic.toString().padStart(decimals + 1, "0");
  if (decimals === 0) return digits;
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

/** Integer division rounding half up (0.5 → 1). The only rounding in the project. */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new VitrineeError("ValidationError", "division by a non-positive denominator", {
      details: { denominator: denominator.toString() },
    });
  }
  if (numerator < 0n) {
    throw new VitrineeError("ValidationError", "amounts cannot be negative", {
      details: { numerator: numerator.toString() },
    });
  }
  return (numerator * 2n + denominator) / (denominator * 2n);
}

export interface FxRate {
  /** Units of `quote` per one `base` unit, as a decimal string ("950", "949.50"). */
  rate: string;
  base: "USD";
  quote: string;
}

/**
 * Converts a local-currency amount into USDC atomic units at a fixed rate.
 *
 *   usdc = local / rate
 *   atomic = localAtomic · 10^rateDecimals · 10^7 / (rateAtomic · 10^localDecimals)
 *
 * The rate is read with exactly the decimals it was written with, so
 * "950" and "950.00" produce the same result.
 */
export function localToUsdcAtomic(amountLocal: string, currency: string, fx: FxRate): bigint {
  if (fx.quote.toUpperCase() !== currency.toUpperCase()) {
    throw new VitrineeError(
      "ValidationError",
      `fx rate is ${fx.base}/${fx.quote} but the amount is in ${currency}`,
      { details: { currency, fx } },
    );
  }
  const localDecimals = currencyDecimals(currency);
  const localAtomic = parseDecimal(amountLocal, localDecimals);
  const rateDecimals = decimalPlaces(fx.rate);
  const rateAtomic = parseDecimal(fx.rate, rateDecimals);
  if (rateAtomic === 0n) {
    throw new VitrineeError("ValidationError", "fx rate must be positive", {
      details: { rate: fx.rate },
    });
  }
  return divRoundHalfUp(
    localAtomic * pow10(rateDecimals) * pow10(USDC_DECIMALS),
    rateAtomic * pow10(localDecimals),
  );
}

export function usdcAtomicToDecimal(atomic: bigint): string {
  return formatUnits(atomic, USDC_DECIMALS);
}

/** Multiplies an atomic amount by a whole quantity. */
export function timesQuantity(atomic: bigint, quantity: number): bigint {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new VitrineeError("ValidationError", "quantity must be a positive integer", {
      details: { quantity },
    });
  }
  return atomic * BigInt(quantity);
}
