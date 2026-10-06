import { describe, expect, it } from "vitest";

import { WalletError } from "./errors.js";
import { describe as describeError } from "./messages.js";
import { normalizeSignature } from "./signature.js";
import { TESTNET_PASSPHRASE, createWallet, toWalletError, type KitLike } from "./wallet.js";
import { LEFT_OUT_WALLETS, OFFERED_WALLETS, isOffered, parseNeeds, walletsFor } from "./wallets.js";

const ADDRESS = "GBQS3GKS2JS6JAVJOC2ZZ3MTTC7LYDHLRQAMQYMZM34TUJGO6CXNXJVP";
const OTHER = "GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K";
const SIG = Uint8Array.from({ length: 64 }, (_, i) => i);
const SIG_B64 = Buffer.from(SIG).toString("base64");

function kit(overrides: Partial<KitLike> = {}): KitLike & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    authModal: async () => ({ address: ADDRESS }),
    selectedModule: { productId: "lobstr", productName: "LOBSTR" },
    signMessage: async (message, opts) => (calls.push({ message, opts }), { signedMessage: SIG_B64, signerAddress: ADDRESS }),
    signTransaction: async (xdr, opts) => (calls.push({ xdr, opts }), { signedTxXdr: "AAAAsigned", signerAddress: ADDRESS }),
    disconnect: async () => undefined,
    ...overrides,
  };
}

async function failure(promise: Promise<unknown>): Promise<WalletError> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(WalletError);
  return error as WalletError;
}

describe("normalizeSignature", () => {
  it.each([
    ["base64", SIG_B64],
    ["base64url", Buffer.from(SIG).toString("base64url")],
    ["hex (Bitget)", Buffer.from(SIG).toString("hex")],
    ["0x hex", `0x${Buffer.from(SIG).toString("hex")}`],
    ["bytes", SIG],
    ["a byte array", Array.from(SIG)],
    ["a serialized Buffer", { type: "Buffer", data: Array.from(SIG) }],
    ["an ArrayBuffer", SIG.buffer.slice(0)],
    ["a DataView", new DataView(SIG.buffer.slice(0))],
    ["a Uint8Array that went through JSON", JSON.parse(JSON.stringify(SIG))],
  ])("turns %s into base64 of the 64 bytes", (_shape, value) => {
    expect(normalizeSignature(value)).toBe(SIG_B64);
  });

  it.each([
    ["too short", Buffer.alloc(32).toString("base64")],
    ["not a signature", "hello world!"],
    ["nothing", undefined],
    ["a number", 7],
    ["an object with other keys", { a: 1, b: 2 }],
    ["an index object of the wrong length", JSON.parse(JSON.stringify(SIG.slice(0, 63)))],
  ])("refuses %s", (_what, value) => {
    expect(() => normalizeSignature(value)).toThrow(WalletError);
  });
});

describe("the wallet layer", () => {
  it("connects through the picker and names the wallet chosen", async () => {
    expect(await createWallet(kit()).connect()).toEqual({ address: ADDRESS, walletId: "lobstr", walletName: "LOBSTR" });
  });

  it("signs a message on testnet for the connected account and returns base64", async () => {
    const k = kit({ signMessage: async () => ({ signedMessage: Buffer.from(SIG).toString("hex") }) });
    expect(await createWallet(k).signMessage("hello", ADDRESS)).toEqual({ signature: SIG_B64, signerAddress: ADDRESS });
  });

  it("asks the kit for the account and testnet", async () => {
    const k = kit();
    await createWallet(k).signMessage("hello", ADDRESS);
    expect(k.calls[0]).toEqual({ message: "hello", opts: { address: ADDRESS, networkPassphrase: TESTNET_PASSPHRASE } });
  });

  it("refuses a message signed by another account (LOBSTR cannot be told which)", async () => {
    const k = kit({ signMessage: async () => ({ signedMessage: SIG_B64, signerAddress: OTHER }) });
    expect((await failure(createWallet(k).signMessage("hello", ADDRESS))).code).toBe("WrongAccount");
  });

  it("names a wallet that cannot sign messages", async () => {
    const k = kit({ signMessage: () => Promise.reject({ code: -3, message: 'Albedo does not support the "signMessage" function' }) });
    expect((await failure(createWallet(k).signMessage("hello", ADDRESS))).code).toBe("MessagesUnsupported");
  });

  it("signs a transaction and refuses one signed by another account", async () => {
    expect(await createWallet(kit()).signTransaction("AAAA", ADDRESS)).toBe("AAAAsigned");
    const k = kit({ signTransaction: async () => ({ signedTxXdr: "AAAA", signerAddress: OTHER }) });
    expect((await failure(createWallet(k).signTransaction("AAAA", ADDRESS))).code).toBe("WrongAccount");
  });

  it("tells a declined request from a failure", () => {
    expect(toWalletError({ code: -1, message: "User rejected the request" }, "connect").code).toBe("Declined");
    expect(toWalletError(new Error("The modal was closed"), "connect").code).toBe("Declined");
    expect(toWalletError({ code: -1, message: "Wallet is not installed" }, "connect").code).toBe("WalletUnavailable");
    expect(toWalletError({ code: -1, message: "boom" }, "transaction").code).toBe("WalletFailed");
  });
});

describe("the wallets offered", () => {
  it("offers only wallets that sign messages, Freighter first", () => {
    expect(OFFERED_WALLETS[0].id).toBe("freighter");
    expect(OFFERED_WALLETS.every((wallet) => (wallet.signs as readonly string[]).includes("message"))).toBe(true);
  });

  it("offers LOBSTR only where no testnet transaction is signed (it signs them for mainnet), and Hana nowhere (not SEP-53)", () => {
    expect(walletsFor(["message"])).toEqual(["freighter", "xbull", "lobstr"]);
    expect(walletsFor(["message", "transaction"])).toEqual(["freighter", "xbull"]);
  });

  it("reads a screen's needs from its script tag, and takes both when it declares nothing", () => {
    expect(parseNeeds("message")).toEqual(["message"]);
    expect(parseNeeds("message transaction")).toEqual(["message", "transaction"]);
    expect(parseNeeds(" transaction  message transaction ")).toEqual(["transaction", "message"]);
    expect(parseNeeds(null)).toEqual(["message", "transaction"]);
    expect(parseNeeds("everything")).toEqual(["message", "transaction"]);
  });

  it("does not offer Albedo or Rabet, which cannot sign messages", () => {
    for (const { id } of LEFT_OUT_WALLETS) expect(isOffered(id)).toBe(false);
  });
});

describe("describe", () => {
  it("says what happened in English and Spanish, and adds the wallet's own words when it failed", () => {
    expect(describeError(new WalletError("Declined", "x"), "en")).toBe("You declined in the wallet. Nothing was signed.");
    expect(describeError(new WalletError("Declined", "x"), "es")).toBe("Lo rechazaste en la wallet. No se firmó nada.");
    expect(describeError(new WalletError("WalletFailed", "boom"), "es")).toBe("La wallet informó un error: boom");
  });

  it("leaves anything that is not a wallet error to the page", () => {
    expect(describeError(new Error("x"), "en")).toBeUndefined();
    expect(describeError({ body: { message: "server" } }, "en")).toBeUndefined();
  });
});
