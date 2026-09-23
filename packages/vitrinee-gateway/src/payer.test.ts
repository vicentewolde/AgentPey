import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { payerFromTransactionXdr } from "./payer.js";

// The envelope of the first real Vitrinee purchase (testnet, 2026-09-22):
// https://stellar.expert/explorer/testnet/tx/ef86ca2fb6b3fbbe32e89b23c7159a4b13dc02e251bb83a7e75e0ac68f86080f
const ENVELOPE = readFileSync(new URL("./test/fixtures/settlement-ef86ca2f.b64", import.meta.url), "utf8").trim();

describe("payerFromTransactionXdr", () => {
  it("reads the transfer's `from` out of a real settlement, through the fee bump", () => {
    expect(payerFromTransactionXdr(ENVELOPE)).toBe("GAGRRWU5CEYAMHUMVO6DZBXAV7YTQTO2QE7R2KO3TUEN6QR7GRVXQPOM");
  });

  it("returns undefined for anything that is not a transfer", () => {
    expect(payerFromTransactionXdr("not xdr")).toBeUndefined();
    expect(payerFromTransactionXdr(Buffer.from("fake-tx").toString("base64"))).toBeUndefined();
  });
});
