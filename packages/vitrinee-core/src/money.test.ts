import { describe, expect, it } from "vitest";

import { VitrineeError } from "./errors.js";
import {
  decimalPlaces,
  divRoundHalfUp,
  formatUnits,
  localToUsdcAtomic,
  parseDecimal,
  timesQuantity,
  usdcAtomicToDecimal,
} from "./money.js";

const clp = (rate: string) => ({ rate, base: "USD" as const, quote: "CLP" });

describe("parseDecimal", () => {
  it("scales to atomic units", () => {
    expect(parseDecimal("34990", 0)).toBe(34990n);
    expect(parseDecimal("12.50", 2)).toBe(1250n);
    expect(parseDecimal("12.5", 7)).toBe(125000000n);
    expect(parseDecimal("0", 7)).toBe(0n);
  });

  it("rejects anything that is not a plain non-negative decimal", () => {
    for (const bad of ["-1", "1e3", "1,000", "", "abc", "1.", ".5", "1.2.3"]) {
      expect(() => parseDecimal(bad, 2)).toThrow(VitrineeError);
    }
  });

  it("rejects more precision than the unit has", () => {
    expect(() => parseDecimal("1.5", 0)).toThrow(/decimal place/);
    expect(() => parseDecimal("1.123", 2)).toThrow(/decimal places/);
  });
});

describe("formatUnits", () => {
  it("prints exactly the unit's decimals", () => {
    expect(formatUnits(368315789n, 7)).toBe("36.8315789");
    expect(formatUnits(5n, 7)).toBe("0.0000005");
    expect(formatUnits(0n, 7)).toBe("0.0000000");
    expect(formatUnits(34990n, 0)).toBe("34990");
    expect(formatUnits(1250n, 2)).toBe("12.50");
  });

  it("round-trips with parseDecimal", () => {
    expect(parseDecimal(formatUnits(123456789n, 7), 7)).toBe(123456789n);
  });
});

describe("divRoundHalfUp", () => {
  it("rounds half up and never uses floats", () => {
    expect(divRoundHalfUp(1n, 2n)).toBe(1n);
    expect(divRoundHalfUp(1n, 3n)).toBe(0n);
    expect(divRoundHalfUp(2n, 3n)).toBe(1n);
    expect(divRoundHalfUp(10n ** 30n, 3n)).toBe(333333333333333333333333333333n);
  });

  it("refuses zero, negative denominators and negative amounts", () => {
    expect(() => divRoundHalfUp(1n, 0n)).toThrow(VitrineeError);
    expect(() => divRoundHalfUp(1n, -1n)).toThrow(VitrineeError);
    expect(() => divRoundHalfUp(-1n, 1n)).toThrow(VitrineeError);
  });
});

describe("localToUsdcAtomic", () => {
  it("converts CLP at an integer rate", () => {
    // 34990 / 950 = 36.83157894... → 36.8315789 USDC
    expect(localToUsdcAtomic("34990", "CLP", clp("950"))).toBe(368315789n);
    expect(usdcAtomicToDecimal(localToUsdcAtomic("34990", "CLP", clp("950")))).toBe("36.8315789");
  });

  it("reads the rate with the decimals it was written with", () => {
    expect(localToUsdcAtomic("34990", "CLP", clp("950.00"))).toBe(368315789n);
    // 34990 / 950.50 = 36.81220410... → 36.8122041
    expect(localToUsdcAtomic("34990", "CLP", clp("950.50"))).toBe(368122041n);
  });

  it("converts USD cents at rate 1 without loss", () => {
    expect(localToUsdcAtomic("12.50", "USD", { rate: "1", base: "USD", quote: "USD" })).toBe(
      125000000n,
    );
  });

  it("rounds half up at the seventh decimal", () => {
    // 1 / 3 = 0.33333333... → 0.3333333
    expect(localToUsdcAtomic("1", "CLP", clp("3"))).toBe(3333333n);
    // 2 / 3 = 0.66666666... → 0.6666667
    expect(localToUsdcAtomic("2", "CLP", clp("3"))).toBe(6666667n);
  });

  it("refuses a rate in the wrong currency, a zero rate, or fractional CLP", () => {
    expect(() =>
      localToUsdcAtomic("100", "CLP", { rate: "1", base: "USD", quote: "USD" }),
    ).toThrow(/fx rate is USD\/USD/);
    expect(() => localToUsdcAtomic("100", "CLP", clp("0"))).toThrow(/positive/);
    expect(() => localToUsdcAtomic("100.5", "CLP", clp("950"))).toThrow(/decimal place/);
    expect(() => localToUsdcAtomic("100", "XXX", { rate: "1", base: "USD", quote: "XXX" })).toThrow(
      /unsupported currency/,
    );
  });
});

describe("timesQuantity / decimalPlaces", () => {
  it("multiplies by whole quantities only", () => {
    expect(timesQuantity(368315789n, 3)).toBe(1104947367n);
    expect(() => timesQuantity(1n, 0)).toThrow(VitrineeError);
    expect(() => timesQuantity(1n, 1.5)).toThrow(VitrineeError);
  });

  it("counts fractional digits", () => {
    expect(decimalPlaces("950")).toBe(0);
    expect(decimalPlaces("949.99")).toBe(2);
    expect(() => decimalPlaces("9,50")).toThrow(VitrineeError);
  });
});
