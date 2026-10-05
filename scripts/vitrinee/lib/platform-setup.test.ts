import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { rebuildOrder, roleConnectionString, type PublicOrderBackup } from "./platform-setup.js";

const backup = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../docs/fase-6-agentguard-comercializacion/evidencia/T103-ord_muektgpgee1ebc73e5.json", import.meta.url)), "utf8"),
) as PublicOrderBackup;

describe("roleConnectionString", () => {
  it("swaps the role and password and keeps Supabase's project ref, host and database", () => {
    const url = new URL(roleConnectionString("postgresql://postgres.abcref:old@aws-0.pooler.supabase.com:5432/postgres?sslmode=require", "n3w/p@ss"));
    expect(url.username).toBe("vitrinee.abcref");
    expect(decodeURIComponent(url.password)).toBe("n3w/p@ss");
    expect(url.host).toBe("aws-0.pooler.supabase.com:5432");
    expect(url.pathname).toBe("/postgres");
    expect(url.searchParams.get("sslmode")).toBe("require");
  });

  it("uses the bare role name on a plain Postgres", () => {
    expect(new URL(roleConnectionString("postgres://postgres:x@localhost:5432/db", "p")).username).toBe("vitrinee");
  });
});

describe("rebuildOrder (T101's pending order, T103)", () => {
  const resourceUrl = "https://vitrinee.agentpey.com/checkout/37282999?quantity=1&name=Test+Buyer&address=Calle+1&city=Santiago&region=RM";

  it("keeps the payment, the receipt and the anchor exactly, and restores the buyer from AgentPey's record", () => {
    const order = rebuildOrder(backup, resourceUrl);
    expect(order.status).toBe("paid_unfulfilled");
    expect(order.settlement).toEqual(backup.settlement);
    expect(order.receipt).toEqual({ jws: backup.receipt!.jws, hash: backup.receipt!.hash });
    expect(order.anchor).toEqual(backup.anchor);
    expect(order.buyer).toEqual({
      stellarAccount: backup.settlement.payer,
      shipping: { name: "Test Buyer", address: "Calle 1", city: "Santiago", region: "RM", country: "CL" },
    });
    // The backup's one product reads back as the order's one item (T148).
    const [item] = order.items;
    expect(order.items).toHaveLength(1);
    expect(BigInt(item!.unitPriceUSDCAtomic) * BigInt(item!.quantity)).toBe(BigInt(order.amountUSDCAtomic));
  });

  it("refuses a checkout URL for another product", () => {
    expect(() => rebuildOrder(backup, "https://vitrinee.agentpey.com/checkout/1?name=x")).toThrow(/product/);
  });
});
