import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

import type { Tienda } from "./base.js";
import { openDb } from "./db.js";
import { handlePublicMcp } from "./ias.js";
import type { Product } from "./model.js";
import type { Policy } from "./politicas.js";
import { asDomain, buildPublicPolicies, ownPage, POLICY_NOTE, policiesJson, policiesText, type SavedPolicy } from "./politicas-publicas.js";
import { importPolicies, migrate, pgStore, sqliteStore, type Queryable } from "./store.js";

const tienda = (id: string, over: Partial<Tienda> = {}): Tienda => ({
  id, name: id.charAt(0).toUpperCase() + id.slice(1), domain: `${id}.cl`, origin: `https://www.${id}.cl`, rubro: "Hogar y Decoración",
  categories: ["Hogar y Decoración"], platform: "shopify", segment: "pyme", bfSlug: id, bfLink: `https://${id}.cl`, checkedAt: "2026-11-18T03:00:00.000Z", ...over,
});
const product = (store: string, i: number): Product => ({
  storeId: store, id: `${store}-${i}`, title: `Producto ${i}`, description: "", url: `https://${store}.cl/p/${i}`, images: [],
  price: 1000 * (i + 1), compareAtPrice: undefined, available: true, brand: undefined, sku: undefined, gtin: undefined,
  category: undefined, tags: [], attributes: {}, variants: [],
});
const input = (t: Tienda) => ({ tienda: t, readAt: "2026-11-18T05:00:00.000Z", products: Array.from({ length: 10 }, (_, i) => product(t.id, i)) });

const policy = (domain: string, over: Partial<Policy> = {}): Policy => ({
  despacho: { cobertura: "Todo Chile", plazos: [{ zona: "RM", plazo: "2 días hábiles" }], costo: "Gratis sobre $50.000", retiro_en_tienda: "" },
  cambios_y_devoluciones: {
    acepta: "si", plazo_dias: 10, condiciones: "Producto sin uso.",
    cambio: { plazo_dias: 30, solo_por_falla: false }, devolucion_dinero: { acepta: "si", plazo_dias: 10, solo_por_falla: false },
    plazo_desde: "recepcion", tipo_de_dias: "corridos",
  },
  garantia: "6 meses", medios_de_pago: ["Webpay"], cuotas: "", contacto: "Juan Pérez, juan@example.com",
  citas: [
    { dato: "Despacho a todo Chile", cita: "Despachamos a todo Chile", url: `https://www.${domain}/despacho` },
    { dato: "Otra tienda", cita: "Algo", url: "https://otra.cl/x" },
  ],
  falta: ["Costo a regiones"],
  ...over,
});
const saved = (storeId: string, data: unknown, at = "2026-11-25T05:00:00.000Z", pages = [`https://www.${storeId}.cl/despacho`]): SavedPolicy => ({ storeId, pages, data, at });

const inputs = [input(tienda("luminova")), input(tienda("kallfu")), input(tienda("vieja")), input(tienda("antigua")), input(tienda("piloto", { sources: ["piloto"] })), input(tienda("ajena"))];
const savedMap = new Map([
  ["luminova", saved("luminova", policy("luminova.cl"))],
  ["kallfu", saved("kallfu", policy("kallfu.cl"))],
  ["vieja", saved("vieja", policy("vieja.cl"), "2026-09-01T00:00:00.000Z")],
  ["antigua", saved("antigua", { ...policy("antigua.cl"), cambios_y_devoluciones: { acepta: "si", plazo_dias: 30, condiciones: "" } })],
  ["piloto", saved("piloto", policy("piloto.cl"))],
  ["ajena", saved("ajena", policy("ajena.cl", { citas: [{ dato: "x", cita: "y", url: "https://otra.cl/x" }] }))],
]);
const built = buildPublicPolicies(inputs, savedMap, "2026-11-25");

describe("the public store policies", () => {
  it("are those of the stores the guides may name, fresh, in the current format, with quotes from their own site and no contact", () => {
    expect(built.map((b) => b.policy.storeId).sort()).toEqual(["kallfu", "luminova"]);
    const p = built.find((b) => b.policy.storeId === "luminova")!.policy;
    expect(p.citas.map((c) => c.url)).toEqual(["https://www.luminova.cl/despacho"]);
    expect(p).not.toHaveProperty("contacto");
    expect(JSON.stringify(p)).not.toContain("juan@example.com");
    expect(p.readAt).toBe("2026-11-25");
  });

  it("take a page of the store's own domain or subdomain only", () => {
    expect(ownPage("https://www.luminova.cl/x", "luminova.cl")).toBe(true);
    expect(ownPage("https://ayuda.luminova.cl/x", "luminova.cl")).toBe(true);
    expect(ownPage("https://luminova.cl.evil.com/x", "luminova.cl")).toBe(false);
    expect(ownPage("https://fakeluminova.cl/x", "luminova.cl")).toBe(false);
    expect(ownPage("javascript:alert(1)//luminova.cl", "luminova.cl")).toBe(false);
  });

  it("read a domain from what a person types", () => {
    expect(asDomain("https://www.Luminova.cl/garantia")).toBe("luminova.cl");
    expect(asDomain("luminova")).toBeUndefined();
    expect(asDomain("la tienda de luces")).toBeUndefined();
  });

  it("say where each claim comes from, when it was read, and that the store did not review it", () => {
    const p = built.map((b) => b.policy).filter((x) => x.storeId === "luminova");
    const text = policiesText("luminova.cl", p);
    expect(text).toContain("Luminova (luminova.cl), según su sitio, leído el 2026-11-25");
    expect(text).toContain("cambio: 30 días corridos; devolución del dinero: sí 10 días corridos, desde que recibes el producto");
    expect(text).toContain('"Despachamos a todo Chile" (https://www.luminova.cl/despacho)');
    expect(text).toContain(POLICY_NOTE);
    expect(policiesText("nada", [])).toContain("No tenemos políticas");
    expect(policiesJson("luminova.cl", p)).toMatchObject({ note: POLICY_NOTE, results: [{ store: "Luminova", readAt: "2026-11-25", quotes: [{ cita: "Despachamos a todo Chile" }] }] });
  });

  it("are found by domain or by name, the same in SQLite and Postgres", async () => {
    const local = openDb(":memory:");
    local.replacePublicPolicies(built.map((b) => ({ storeId: b.policy.storeId, domain: b.policy.domain, text: b.text, data: b.policy })));
    const lite = sqliteStore(local);
    expect((await lite.findPolicies("luminova.cl", [], 3)).map((p) => p.store)).toEqual(["Luminova"]);
    expect((await lite.findPolicies(undefined, ["kall"], 3)).map((p) => p.store)).toEqual(["Kallfu"]);
    expect(await lite.findPolicies(undefined, ["%", "_"], 3)).toEqual([]);
    const pglite = new PGlite();
    const q = pglite as unknown as Queryable;
    await migrate(q);
    expect(await importPolicies(q, local)).toBe(2);
    expect(await importPolicies(q, local)).toBe(2);
    const pg = pgStore(q);
    expect((await pg.findPolicies("kallfu.cl", [], 3)).map((p) => p.store)).toEqual(["Kallfu"]);
    expect((await pg.findPolicies(undefined, ["luminova"], 3)).map((p) => p.store)).toEqual(["Luminova"]);
    expect(await pg.findPolicies("otra.cl", ["otra", "cl"], 3)).toEqual([]);
  }, 30_000);

  it("are a tool of the public MCP server", async () => {
    const asked: unknown[] = [];
    const deps = { search: async () => ({ total: 0, rows: [] }), policies: async (domain: string | undefined, terms: readonly string[]) => (asked.push([domain, terms]), built.map((b) => b.policy).filter((p) => p.domain === domain)) };
    const list = (await handlePublicMcp(deps, { jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(["buscar_precios", "politicas_tienda"]);
    const r = (await handlePublicMcp(deps, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "politicas_tienda", arguments: { tienda: "https://luminova.cl" } } })) as { result: { content: { text: string }[]; isError: boolean } };
    expect(r.result.isError).toBe(false);
    expect(r.result.content[0]!.text).toContain("Luminova (luminova.cl)");
    expect(asked[0]).toEqual(["luminova.cl", ["luminova", "cl"]]);
    const empty = (await handlePublicMcp(deps, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "politicas_tienda", arguments: {} } })) as { result: { isError: boolean } };
    expect(empty.result.isError).toBe(true);
    const without = (await handlePublicMcp({ search: deps.search }, { jsonrpc: "2.0", id: 4, method: "tools/list" })) as { result: { tools: { name: string }[] } };
    expect(without.result.tools.map((t) => t.name)).toEqual(["buscar_precios"]);
  });
});
