import { describe, expect, it } from "vitest";

import type { Engine } from "./diagnostico.js";
import type { Fetcher } from "./http.js";
import type { Llm } from "./llm.js";
import { assertPublicHost, BadUrl, detectPlatform, normalizeUrl, QuickLimits, quickDiagnosis, siteName } from "./rapido.js";

describe("the quick diagnosis input", () => {
  it.each([
    ["csbyte.cl", "https://csbyte.cl"], ["https://www.HiFi.cl/collections/x?y=1", "https://www.hifi.cl"], ["  http://tienda.cl/ ", "http://tienda.cl"],
  ])("normalises %s", (raw, out) => expect(normalizeUrl(raw).toString().replace(/\/$/, "")).toBe(out));

  it.each(["", "localhost", "http://127.0.0.1", "http://[::1]/", "ftp://tienda.cl", "https://user:pw@tienda.cl", "https://tienda.cl:8080", "panel.agentpey.com", "x.onrender.com", "tienda"])("refuses %s", (raw) => {
    expect(() => normalizeUrl(raw)).toThrow(BadUrl);
  });

  it("refuses hosts that resolve to private addresses", async () => {
    await expect(assertPublicHost("a.cl", async () => [{ address: "10.0.0.5" }])).rejects.toThrow(BadUrl);
    await expect(assertPublicHost("a.cl", async () => [{ address: "93.184.216.34" }, { address: "127.0.0.1" }])).rejects.toThrow(BadUrl);
    await expect(assertPublicHost("a.cl", async () => { throw new Error("ENOTFOUND"); })).rejects.toThrow(BadUrl);
    await expect(assertPublicHost("a.cl", async () => [{ address: "93.184.216.34" }])).resolves.toBeUndefined();
  });

  it("detects the platform and the store's name from the home page", () => {
    expect(detectPlatform('<script src="//cdn.shopify.com/s/x.js">')).toBe("shopify");
    expect(detectPlatform('<link href="/wp-content/plugins/woocommerce/x.css">')).toBe("woocommerce");
    expect(detectPlatform("<html>hola</html>")).toBe("propia");
    expect(siteName('<meta property="og:site_name" content="Mascotas &amp; Co">', "x.cl")).toBe("Mascotas & Co");
    expect(siteName("<title>HiFi | Audio de verdad</title>", "hifi.cl")).toBe("HiFi");
    expect(siteName("", "www.felinus.cl")).toBe("felinus");
  });

  it("caps runs per IP and per day", () => {
    const limits = new QuickLimits(2, 3);
    const t = Date.parse("2026-11-17T12:00:00Z");
    expect(limits.take("a", t)).toBeUndefined();
    expect(limits.take("a", t)).toBeUndefined();
    expect(limits.take("a", t)).toMatch(/Ya hiciste/);
    expect(limits.take("b", t)).toBeUndefined();
    expect(limits.take("c", t)).toMatch(/Hoy ya/);
    expect(limits.take("c", t + 86_400_000)).toBeUndefined();
  });
});

describe("quickDiagnosis", () => {
  const home = '<html><head><title>Felinus - Todo para gatos</title><script src="https://cdn.shopify.com/x.js"></script></head></html>';
  const fetcher: Fetcher = {
    async text(url) { return { status: 200, body: home, url }; },
    async json<T>(url: string) {
      const products = url.includes("page=1") ? [{ id: 1, title: "Rascador torre", handle: "rascador", body_html: "<p>Rascador de 130 cm para gatos grandes, con nido.</p>", vendor: "Felinus", product_type: "Rascadores", variants: [{ id: 11, price: "49990", available: true }], images: [] }] : [];
      return { status: 200, body: { products } as T, url };
    },
  };
  const llm: Llm = {
    name: "fake",
    async structured() { return { preguntas: ["¿Dónde compro un rascador grande?", "¿Qué arena para gatos conviene?"] } as never; },
    async searchAnswer() { return { text: "", urls: [] }; },
  };
  const engine = (name: string, text: string, urls: string[]): Engine => ({ name, ask: async () => ({ engine: name, text, urls }) });

  it("reads the catalogue, asks every engine and tallies who shows up instead", async () => {
    const broken: Engine = { name: "gemini", ask: async () => { throw new Error("429"); } };
    const r = await quickDiagnosis({
      llm, fetcher,
      engines: [engine("claude", "Te recomiendo Felinus y Petco.", ["https://felinus.cl/products/rascador", "https://www.petco.cl/x"]), broken],
    }, "abcd000000000000", new URL("https://felinus.cl"), "productos para gatos", 2);
    expect(r).toMatchObject({ domain: "felinus.cl", name: "Felinus", platform: "shopify", products: 1, engines: ["claude", "gemini"] });
    expect(r.score).toBeGreaterThan(0);
    expect(r.questions).toHaveLength(2);
    expect(r.questions[0]!.answers[0]).toMatchObject({ engine: "claude", mentioned: true, cited: true });
    expect(r.questions[0]!.answers[1]).toMatchObject({ engine: "gemini", error: "no respondió" });
    expect(r.instead).toEqual([{ domain: "petco.cl", count: 2 }]);
  });
});
