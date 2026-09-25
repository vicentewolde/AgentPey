import { describe, expect, it } from "vitest";

import { MAX_TOPUP_USDC, parseTopupArgs } from "./topup-args.js";

const RAIL = "CCNA6ACL4L76EDJZXEFAFDJQPWW3CJXZUQFS6IL574E5Z6AOLXAKC45L";

describe("parseTopupArgs", () => {
  it("reads a rail and an amount, and does not confirm by default", () => {
    expect(parseTopupArgs([RAIL, "10"])).toEqual({ rail: RAIL, amount: "10", confirmed: false });
  });

  it("ignores the bare -- pnpm passes on", () => {
    expect(parseTopupArgs(["--", RAIL, "10"])).toEqual({ rail: RAIL, amount: "10", confirmed: false });
  });

  it("confirms only with --yes, wherever it is", () => {
    expect(parseTopupArgs(["--yes", RAIL, "7.5"]).confirmed).toBe(true);
    expect(parseTopupArgs([RAIL, "7.5", "--yes"]).confirmed).toBe(true);
  });

  it("refuses a destination that is not a contract address", () => {
    expect(() => parseTopupArgs(["GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K", "10"])).toThrow(/contract address/);
    expect(() => parseTopupArgs(["hola", "10"])).toThrow(/contract address/);
  });

  it("refuses amounts that are not plain decimals, zero, or above the cap", () => {
    for (const bad of ["diez", "-5", "1e3", "0", "0.00", "10.12345678", `${String(MAX_TOPUP_USDC + 1)}`, "100"]) {
      expect(() => parseTopupArgs([RAIL, bad])).toThrow();
    }
    expect(parseTopupArgs([RAIL, String(MAX_TOPUP_USDC)]).amount).toBe("20");
  });

  it("refuses missing, extra and unknown arguments", () => {
    expect(() => parseTopupArgs([])).toThrow(/usage/);
    expect(() => parseTopupArgs([RAIL])).toThrow(/usage/);
    expect(() => parseTopupArgs([RAIL, "5", "6"])).toThrow(/usage/);
    expect(() => parseTopupArgs([RAIL, "5", "--force"])).toThrow(/unknown option/);
  });
});
