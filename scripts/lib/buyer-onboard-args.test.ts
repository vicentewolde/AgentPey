import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { MAX_PER_DAY_USDC, parseBuyerOnboardArgs } from "./buyer-onboard-args.js";

const wallet = Keypair.random().publicKey();

describe("buyer:onboard arguments", () => {
  it("defaults to limits that cover any Tapline product, the next free index, and a dry run", () => {
    expect(parseBuyerOnboardArgs(["--", "--principal", wallet])).toEqual({
      principal: wallet,
      agentIndex: undefined,
      perTx: "20",
      perDay: "50",
      confirmed: false,
      initMnemonic: false,
    });
  });

  it("takes limits, an index and both switches", () => {
    const args = parseBuyerOnboardArgs(["--principal", wallet, "--per-tx", "1.5", "--per-day", "10", "--index", "7", "--yes", "--init-mnemonic"]);
    expect(args).toMatchObject({ perTx: "1.5", perDay: "10", agentIndex: 7, confirmed: true, initMnemonic: true });
  });

  it.each([
    [[], "required"],
    [["--principal", "GNOTAKEY"], "Stellar account"],
    [["--principal", wallet, "--index", "0"], "from 1"],
    [["--principal", wallet, "--index", "-2"], "from 1"],
    [["--principal", wallet, "--index"], "needs a value"],
    [["--principal", wallet, "--per-tx", "0"], "positive"],
    [["--principal", wallet, "--per-tx", "1.12345678"], "seven decimals"],
    [["--principal", wallet, "--per-tx", "6", "--per-day", "5"], "above --per-day"],
    [["--principal", wallet, "--per-day", "200.0000001"], `above ${MAX_PER_DAY_USDC}`],
    [["--principal=" + wallet], "with a space"],
    [["--principal", wallet, "--principal", wallet], "twice"],
    [["--principal", wallet, "--fund"], "unknown"],
  ])("refuses %j", (argv, message) => {
    expect(() => parseBuyerOnboardArgs(argv)).toThrow(expect.objectContaining({ code: "InvalidArguments", message: expect.stringContaining(message) }));
  });

  it("accepts a daily limit of exactly the cap", () => {
    expect(parseBuyerOnboardArgs(["--principal", wallet, "--per-tx", "50", "--per-day", MAX_PER_DAY_USDC]).perDay).toBe("200");
  });
});
