import { describe, expect, it } from "vitest";

import { handleMcp, type AgentDeps } from "./agente.js";
import type { Product, Store } from "./model.js";
import { rankForPromotion } from "./promover.js";
import { priceCeiling, searchProducts, trackedLink } from "./vender.js";

const p = (id: string, title: string, price: number, extra: Partial<Product> = {}): Product => ({
  storeId: "t", id, title, description: "", url: `https://t.cl/products/${id}`, images: [], price, compareAtPrice: undefined, available: true,
  brand: undefined, sku: undefined, gtin: undefined, category: undefined, tags: [], attributes: {}, variants: [], ...extra,
});
const catalog = [
  p("1", "Rascador torre 130 cm con nido", 49990, { category: "Gatos > Rascadores" }),
  p("2", "Rascador torre 180 cm deluxe", 89990, { category: "Gatos > Rascadores" }),
  p("3", "Arena aglutinante 15 kg", 15990),
  p("4", "Rascador básico 40 cm", 9990, { available: false }),
];

describe("the AI seller's search", () => {
  it.each([
    ["hasta $900 mil", 900000], ["menos de 50.000", 50000], ["bajo 1,2 millones", 1200000], ["presupuesto de 30 lucas", 30000], ["un rascador lindo", undefined],
  ])("reads the price ceiling in %s", (q, n) => expect(priceCeiling(q)).toBe(n));

  it("finds matching products under the ceiling, in stock first", () => {
    const found = searchProducts(catalog, "rascador torre hasta 50 mil");
    expect(found.map((x) => x.id)).toEqual(["1"]);
    expect(searchProducts(catalog, "notebook gamer")).toEqual([]);
  });

  it("ignores the price words and does not match short words inside longer ones", () => {
    const withNoise = [...catalog, p("5", "Mouse gamer", 44990, { description: "Ideal para toda la familia, 50 botones" })];
    expect(searchProducts(withNoise, "rascador torre hasta 50 mil").map((x) => x.id)).toEqual(["1"]);
  });

  it("marks links with the click id", () => {
    expect(trackedLink("https://t.cl/products/1?variant=2", "abc")).toBe("https://t.cl/products/1?variant=2&ap_click=abc");
  });
});

describe("the agent channel (MCP)", () => {
  const stores: Store[] = [
    { id: "t", name: "Tienda T", origin: "https://t.cl", platform: "shopify", rubro: "gatos", source: "piloto", sellsOnline: true },
    { id: "bf", name: "Black", origin: "https://bf.cl", platform: "shopify", rubro: "gatos", source: "black-friday", sellsOnline: true },
  ];
  const links: string[] = [];
  const deps: AgentDeps = {
    stores, products: (id) => (id === "t" ? catalog : catalog), policySummary: () => "Despacho a todo Chile.",
    link: (s, id) => { links.push(`${s}/${id}`); return `https://agentpey.test/ir/${id}`; },
  };

  it("initializes and lists its tools", () => {
    expect(handleMcp(deps, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).toMatchObject({ result: { serverInfo: { name: "agentpey-comercios" } } });
    expect(handleMcp(deps, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
    const tools = handleMcp(deps, { jsonrpc: "2.0", id: 2, method: "tools/list" }) as { result: { tools: { name: string }[] } };
    expect(tools.result.tools.map((t) => t.name)).toEqual(["buscar_productos", "politicas_tienda"]);
  });

  it("searches only pilot stores and hands out tracked links", () => {
    const r = handleMcp(deps, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "buscar_productos", arguments: { consulta: "rascador torre hasta 50 mil" } } }) as { result: { content: { text: string }[] } };
    expect(r.result.content[0]!.text).toContain("https://agentpey.test/ir/1");
    expect(r.result.content[0]!.text).toContain("Tienda T");
    expect(links.every((l) => l.startsWith("t/"))).toBe(true);
    const notPilot = handleMcp(deps, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "politicas_tienda", arguments: { tienda: "bf" } } }) as { result: { isError: boolean } };
    expect(notPilot.result.isError).toBe(true);
  });

  it("rejects unknown methods with a JSON-RPC error", () => {
    expect(handleMcp(deps, { jsonrpc: "2.0", id: 5, method: "resources/list" })).toMatchObject({ error: { code: -32601 } });
  });
});

describe("promotion ranking (simulation)", () => {
  it("skips out-of-stock items and favours missed demand", () => {
    const rows = rankForPromotion({ products: catalog, listingScore: new Map([["1", 8]]), missedDemand: ["arena", "aglutinante"] }, 3);
    expect(rows.map((r) => r.product.id)).not.toContain("4");
    expect(rows[0]!.product.id).toBe("3");
    expect(rows[0]!.reasons.join(" ")).toContain("la IA no te nombra");
  });
});
