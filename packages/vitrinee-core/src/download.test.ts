import { Keypair } from "@stellar/stellar-base";
import { describe, expect, it } from "vitest";

import { downloadLinkMessage, signDownloadLink, verifyDownloadLink } from "./download.js";

describe("download links (T188)", () => {
  const payer = Keypair.random();
  const base = { store: "tapline.vitrinee.agentpey.com", orderId: "ord_1", expiresAt: 1_800_000_000 };

  it("verifies a link the reader signed, and nothing changed in it", () => {
    const query = signDownloadLink(payer, base);
    const link = { ...base, reader: query.get("reader")!, expiresAt: Number(query.get("exp")) };
    expect(link.reader).toBe(payer.publicKey());
    expect(verifyDownloadLink(link, query.get("sig")!)).toBe(true);
    expect(verifyDownloadLink({ ...link, orderId: "ord_2" }, query.get("sig")!)).toBe(false);
    expect(verifyDownloadLink({ ...link, store: "other.vitrinee.agentpey.com" }, query.get("sig")!)).toBe(false);
    expect(verifyDownloadLink({ ...link, expiresAt: link.expiresAt + 60 }, query.get("sig")!)).toBe(false);
    expect(verifyDownloadLink({ ...link, reader: Keypair.random().publicKey() }, query.get("sig")!)).toBe(false);
  });

  it("matches the store's host whatever its case, and never throws on garbage", () => {
    const query = signDownloadLink(payer, { ...base, store: "TapLine.Vitrinee.AgentPey.com" });
    expect(verifyDownloadLink({ ...base, reader: payer.publicKey() }, query.get("sig")!)).toBe(true);
    expect(verifyDownloadLink({ ...base, reader: "GNOTAKEY" }, "00".repeat(64))).toBe(false);
    expect(verifyDownloadLink({ ...base, reader: payer.publicKey() }, "zz")).toBe(false);
  });

  it("separates every field, so none can run into the next", () => {
    const a = new TextDecoder().decode(downloadLinkMessage({ ...base, reader: payer.publicKey() }));
    expect(a.split("\n")).toEqual(["vitrinee-download:v1", base.store, base.orderId, payer.publicKey(), String(base.expiresAt)]);
  });
});
