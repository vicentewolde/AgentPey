import { describe, expect, it } from "vitest";

import { DISCLOSURE, FRESHNESS_RULE, guideUrl } from "./guia.js";
import { handlePublicMcp, LIMITED, MAX_BATCH, MCP_VERSIONS, publicMcpHttp, publicMcpUrl, siteLlmsTxt } from "./ias.js";
import { COUNT_CAP, SEARCH_ORDER_RULE, type PriceRow } from "./precios.js";

const row = (title: string, price: number, over: Partial<PriceRow> = {}): PriceRow => ({
  storeId: "uno", store: "Uno", domain: "uno.cl", title, brand: "Lattafa", price, url: `https://uno.cl/p/${price}`, readAt: "2026-11-21", ...over,
});
const rows = [row("Lattafa Khamrah EDP 100 ml", 19900, { before: 24990 }), row("Khamrah 100ml", 22900, { store: "Dos", domain: "dos.cl" })];

function fake(total = rows.length) {
  const asked: string[][] = [];
  return { asked, deps: { search: async (terms: readonly string[]) => (asked.push([...terms]), { total, rows }) } };
}
const call = (args: Record<string, unknown>, id: unknown = 3) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "buscar_precios", arguments: args } });

describe("the public MCP server", () => {
  it("agrees on the client's protocol version when it knows it, and on the newest otherwise", async () => {
    const init = (v: string) => handlePublicMcp(fake().deps, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: v, capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    expect(await init("2025-06-18")).toMatchObject({ id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "agentpey-precios-chile" } } });
    expect(await init("2024-11-05")).toMatchObject({ result: { protocolVersion: MCP_VERSIONS[0] } });
    const r = (await init("2025-11-25")) as { result: { instructions: string } };
    expect(r.result.instructions).toContain(SEARCH_ORDER_RULE);
    expect(r.result.instructions).toContain(DISCLOSURE);
  });

  it("lists one read-only tool", async () => {
    const r = (await handlePublicMcp(fake().deps, { jsonrpc: "2.0", id: 2, method: "tools/list" })) as { result: { tools: { name: string; annotations: { readOnlyHint: boolean }; inputSchema: { required: string[] } }[] } };
    expect(r.result.tools.map((t) => t.name)).toEqual(["buscar_precios"]);
    expect(r.result.tools[0]!.annotations.readOnlyHint).toBe(true);
    expect(r.result.tools[0]!.inputSchema.required).toEqual(["consulta"]);
  });

  it("searches with the same words as the web page, and answers in text and JSON with the rules", async () => {
    const f = fake();
    const r = (await handlePublicMcp(f.deps, call({ consulta: "Khamrah 100 ML" }))) as { result: { content: { text: string }[]; structuredContent: { results: { priceClp: number; url: string }[]; order: string; disclosure: string }; isError: boolean } };
    expect(f.asked).toEqual([["khamrah", "100ml"]]);
    expect(r.result.isError).toBe(false);
    const text = r.result.content[0]!.text;
    expect(text).toContain("$19.900 (antes $24.990) · Uno (uno.cl) · leído el 2026-11-21\n  https://uno.cl/p/19900");
    expect(text).toContain(SEARCH_ORDER_RULE);
    expect(text).toContain(DISCLOSURE);
    expect(text).toContain("https://agentpey.com/chile/buscar?q=Khamrah%20100%20ML");
    expect(r.result.structuredContent.results.map((x) => x.priceClp)).toEqual([19900, 22900]);
    expect(r.result.structuredContent.order).toBe(SEARCH_ORDER_RULE);
  });

  it("honours max, caps the count, and says when nothing matched", async () => {
    const one = (await handlePublicMcp(fake(COUNT_CAP + 1).deps, call({ consulta: "khamrah", max: 1 }))) as { result: { content: { text: string }[]; structuredContent: { results: unknown[]; totalIsAtLeast: boolean } } };
    expect(one.result.structuredContent.results).toHaveLength(1);
    expect(one.result.structuredContent.totalIsAtLeast).toBe(true);
    expect(one.result.content[0]!.text).toMatch(/^Más de 1000 productos/);
    const none = (await handlePublicMcp({ search: async () => ({ total: 0, rows: [] }) }, call({ consulta: "no existe" }))) as { result: { content: { text: string }[] } };
    expect(none.result.content[0]!.text).toContain("No encontramos");
  });

  it("refuses an empty query as a tool error, without searching", async () => {
    const f = fake();
    for (const args of [{}, { consulta: "" }, { consulta: "% _ '" }, { consulta: 5 }]) {
      expect(await handlePublicMcp(f.deps, call(args))).toMatchObject({ result: { isError: true } });
    }
    expect(f.asked).toEqual([]);
  });

  it("answers JSON-RPC errors for unknown tools and methods, and nothing to notifications", async () => {
    const d = fake().deps;
    expect(await handlePublicMcp(d, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "comprar" } })).toMatchObject({ id: 4, error: { code: -32602 } });
    expect(await handlePublicMcp(d, { jsonrpc: "2.0", id: 5, method: "resources/list" })).toMatchObject({ error: { code: -32601 } });
    expect(await handlePublicMcp(d, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
    expect(await handlePublicMcp(d, { id: 6, method: "ping" })).toMatchObject({ error: { code: -32600 } });
    expect(await handlePublicMcp(d, "hola")).toMatchObject({ id: null, error: { code: -32600 } });
    expect(await handlePublicMcp(d, { jsonrpc: "2.0", id: 7, method: "ping" })).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
  });
});

describe("the public MCP server over HTTP", () => {
  const post = (body: unknown) => publicMcpHttp(fake().deps, "POST", JSON.stringify(body));
  const ping = (id: number) => ({ jsonrpc: "2.0", id, method: "ping" });

  it("answers a request with JSON and CORS, a notification with 202, and a batch with an array", async () => {
    const one = await post(ping(1));
    expect(one).toMatchObject({ status: 200, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" } });
    expect(JSON.parse(one.body!)).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    const note = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect([note.status, note.body]).toEqual([202, undefined]);
    expect(await post({ jsonrpc: "2.0", id: 9, result: {} })).toMatchObject({ status: 202 });
    const batch = await post([ping(1), { jsonrpc: "2.0", method: "notifications/initialized" }, ping(2)]);
    expect(JSON.parse(batch.body!).map((a: { id: number }) => a.id)).toEqual([1, 2]);
  });

  it("refuses what is not JSON-RPC, empty or oversized batches, and big bodies, with the HTTP status that says so", async () => {
    expect((await publicMcpHttp(fake().deps, "POST", "{no")).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post([])).status).toBe(400);
    expect((await post(Array.from({ length: MAX_BATCH + 1 }, (_, i) => ping(i)))).status).toBe(400);
    expect((await post(Array.from({ length: MAX_BATCH }, (_, i) => ping(i)))).status).toBe(200);
    expect((await publicMcpHttp(fake().deps, "POST", undefined)).status).toBe(413);
  });

  it("offers POST only: 405 for GET, 204 with CORS for a preflight", async () => {
    expect(await publicMcpHttp(fake().deps, "GET", undefined)).toMatchObject({ status: 405, headers: { allow: "POST, OPTIONS" } });
    expect(await publicMcpHttp(fake().deps, "OPTIONS", undefined)).toMatchObject({ status: 204, headers: { "access-control-allow-headers": expect.stringContaining("mcp-protocol-version") } });
  });

  it("over the limit, or when the search fails, the call answers a tool error the assistant can relay", async () => {
    const limited = await publicMcpHttp({ search: async () => LIMITED }, "POST", JSON.stringify(call({ consulta: "khamrah" })));
    expect(limited.status).toBe(200);
    expect(JSON.parse(limited.body!)).toMatchObject({ id: 3, result: { isError: true, content: [{ text: expect.stringContaining("Demasiadas búsquedas") }] } });
    const broken = await publicMcpHttp({ search: async () => { throw new Error("db down"); } }, "POST", JSON.stringify(call({ consulta: "khamrah" })));
    expect(JSON.parse(broken.body!)).toMatchObject({ id: 3, result: { isError: true } });
    expect(broken.body).not.toContain("db down");
  });
});

describe("the site's llms.txt", () => {
  it("names the guides, the brands, the search, its JSON and the MCP server, with the rules", () => {
    const txt = siteLlmsTxt([{ slug: "salud-y-belleza", title: "Tiendas online de salud y belleza en Chile", stores: 45 }], 1020);
    expect(txt).toMatch(/^# AgentPey/);
    expect(txt).toContain(`[Tiendas online de salud y belleza en Chile](${guideUrl("salud-y-belleza")}): 45 tiendas`);
    expect(txt).toContain("1020 marcas");
    expect(txt).toContain("formato=json");
    expect(txt).toContain(publicMcpUrl());
    expect(publicMcpUrl()).toBe("https://agentpey.com/chile/mcp");
    for (const rule of [SEARCH_ORDER_RULE, DISCLOSURE, FRESHNESS_RULE]) expect(txt).toContain(rule);
    expect(txt).not.toMatch(/—/);
  });
});
