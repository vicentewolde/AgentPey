import { describe, expect, it } from "vitest";

import { fromAtomic, toAtomic } from "./amount.js";
import { UcpStellarError, isUcpStellarError } from "./errors.js";

describe("toAtomic and fromAtomic", () => {
  it.each([
    ["0", 0n],
    ["2", 20_000_000n],
    ["2.5", 25_000_000n],
    ["1.5684211", 15_684_211n],
    ["0.0000001", 1n],
  ])("converts %s exactly, both ways", (decimal, atomic) => {
    expect(toAtomic(decimal, 7)).toBe(atomic);
    expect(toAtomic(fromAtomic(atomic, 7), 7)).toBe(atomic);
  });

  it.each(["", "-1", "1,5", "1.", ".5", "01", "1e3", "0.00000001"])("refuses %j", (value) => {
    expect(() => toAtomic(value, 7)).toThrow(UcpStellarError);
  });

  it("shows every place", () => {
    expect(fromAtomic(15_684_211n, 7)).toBe("1.5684211");
    expect(fromAtomic(20_000_000n, 7)).toBe("2.0000000");
  });
});

describe("UcpStellarError", () => {
  it("is not sent unless it says so, and can be stamped", () => {
    const error = new UcpStellarError("NetworkError", "down");
    expect(error.paymentSent).toBe(false);
    expect(error.withPaymentSent(true)).toMatchObject({ code: "NetworkError", paymentSent: true, message: "down" });
  });

  it("is recognised from another copy of the package, and nothing else is", () => {
    const foreign = Object.assign(new Error("x"), { name: "UcpStellarError", code: "QuoteChanged", paymentSent: false });
    expect(isUcpStellarError(foreign)).toBe(true);
    expect(isUcpStellarError(Object.assign(new Error("x"), { name: "UcpStellarError", code: "Nope", paymentSent: false }))).toBe(false);
    expect(isUcpStellarError(new Error("x"))).toBe(false);
  });
});
