import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { eventsFromGa4, ga4AsEvents, sourceFromGa4 } from "./ga4.js";
import { classifyVisit, demoEvents, grupo, snippet, summarize, type MeasureEvent } from "./medir.js";

describe("classifying visits", () => {
  it.each([
    ["https://t.cl/p?utm_source=chatgpt.com", undefined, "chatgpt"],
    ["https://t.cl/p", "https://www.perplexity.ai/search/x", "perplexity"],
    ["https://t.cl/p", "https://gemini.google.com/app", "gemini"],
    ["https://t.cl/p", "https://claude.ai/chat/1", "claude"],
    ["https://t.cl/p", "https://copilot.microsoft.com/", "copilot"],
    ["https://t.cl/p?ap_click=abc", "https://www.google.com/", "agentpey"],
    ["https://t.cl/p", "https://www.google.com/", "sin_ia"],
    ["https://t.cl/p", "", "sin_ia"],
    ["no es url", "tampoco", "sin_ia"],
  ])("%s from %s → %s", (url, ref, expected) => expect(classifyVisit(url, ref)).toBe(expected));
});

describe("control group", () => {
  it("is stable and close to half", () => {
    expect(grupo("t", "1")).toBe(grupo("t", "1"));
    const ids = Array.from({ length: 1000 }, (_, i) => String(i));
    const opt = ids.filter((id) => grupo("t", id) === "optimizada").length;
    expect(opt).toBeGreaterThan(430);
    expect(opt).toBeLessThan(570);
  });
});

describe("summary", () => {
  const ev = (e: Partial<MeasureEvent>): MeasureEvent => ({ storeId: "t", kind: "visita", source: "sin_ia", at: "2026-11-01T00:00:00Z", ...e });
  it("adds visits, purchases and sales by source, counts an order once, and splits AI sales by group", () => {
    const s = summarize("t", [
      ev({}), ev({}), ev({ source: "chatgpt" }), ev({ source: "chatgpt" }),
      ev({ kind: "compra", source: "chatgpt", total: 30000, orderId: "A", productIds: ["1"] }),
      ev({ kind: "compra", source: "chatgpt", total: 30000, orderId: "A", productIds: ["1"] }),
      ev({ kind: "compra", source: "sin_ia", total: 10000, orderId: "B" }),
      ev({ storeId: "otra", source: "chatgpt" }),
    ]);
    const chat = s.rows.find((r) => r.source === "chatgpt")!;
    expect(chat).toMatchObject({ visitas: 2, compras: 1, ventas: 30000, conversion: 0.5 });
    expect(s.ia).toMatchObject({ visitas: 2, compras: 1, ventas: 30000, shareVisitas: 0.5, shareVentas: 0.75 });
    expect(s.grupos[grupo("t", "1")].ventas).toBe(30000);
    expect(s.demo).toBe(false);
  });

  it("labels generated data as demo", () => {
    const s = summarize("t", demoEvents("t", ["1", "2", "3"], 7));
    expect(s.demo).toBe(true);
    expect(s.ia.visitas).toBeGreaterThan(0);
    expect(s.ia.shareVisitas).toBeLessThan(0.1);
  });
});

describe("the snippet", () => {
  function run(href: string, referrer: string, checkout?: unknown, stored?: string) {
    const sent: unknown[] = [];
    const store = new Map<string, string>(stored ? [["agentpey_src", stored]] : []);
    const ctx: Record<string, unknown> = {
      location: { href }, document: { referrer }, URL, JSON, Date, Number, String,
      navigator: { sendBeacon: (_u: string, b: string) => sent.push(JSON.parse(b)) },
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) },
    };
    ctx.window = ctx;
    if (checkout !== undefined) ctx.Shopify = { checkout };
    runInNewContext(snippet("t", "https://agentpey.com/m"), ctx);
    return { sent, store };
  }

  it("records an AI visit and remembers the source", () => {
    const { sent, store } = run("https://t.cl/p?utm_source=chatgpt.com", "");
    expect(sent).toEqual([expect.objectContaining({ tipo: "visita", fuente: "chatgpt", tienda: "t" })]);
    expect(JSON.parse(store.get("agentpey_src")!).s).toBe("chatgpt");
  });

  it("credits a Shopify order to the remembered source", () => {
    const remembered = JSON.stringify({ s: "perplexity", t: Date.now() });
    const { sent } = run("https://t.cl/checkouts/x/thank_you", "", { order_id: 99, total_price: "45990.00", line_items: [{ product_id: 7 }] }, remembered);
    expect(sent).toEqual([expect.objectContaining({ tipo: "compra", fuente: "perplexity", pedido: "99", total: 45990, productos: ["7"] })]);
  });

  it("sends nothing for a visit that is not from an AI", () => {
    expect(run("https://t.cl/", "https://www.google.com/").sent).toEqual([]);
  });
});

describe("Google Analytics", () => {
  it("maps GA4 session sources to AI sources", () => {
    expect(sourceFromGa4("chatgpt.com")).toBe("chatgpt");
    expect(sourceFromGa4("perplexity")).toBe("perplexity");
    expect(sourceFromGa4("gemini.google.com")).toBe("gemini");
    expect(sourceFromGa4("google")).toBe("sin_ia");
    expect(sourceFromGa4("(direct)")).toBe("sin_ia");
  });

  it("turns a report into the same summary as the snippet", () => {
    const rows = eventsFromGa4({
      rows: [
        { dimensionValues: [{ value: "chatgpt.com" }, { value: "referral" }], metricValues: [{ value: "40" }, { value: "2" }, { value: "60000" }] },
        { dimensionValues: [{ value: "google" }, { value: "organic" }], metricValues: [{ value: "900" }, { value: "10" }, { value: "300000" }] },
      ],
    });
    const s = summarize("t", ga4AsEvents("t", rows, "2026-11-01T00:00:00Z"));
    expect(s.ia).toMatchObject({ visitas: 40, compras: 2, ventas: 60000 });
  });
});
