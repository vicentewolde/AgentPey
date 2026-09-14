import { describe, expect, it } from "vitest";

import { PRODUCTS, productById, productForPath, toAtomic } from "./catalog.js";
import { artifactHash, renderCreditsStatement, renderMarketBrief } from "./artifacts.js";
import { productCopy, renderCatalogPage } from "./page.js";

const PAY_TO = "GBHD27INOTFHFPHVGQMKSW2EGRK3T6E47OHIVR7L44JGHWUJKXIZBXSR";

describe("toAtomic", () => {
  it("converts a decimal price to seven-decimal atomic units, without floats", () => {
    expect(toAtomic("0.25")).toBe("2500000");
    expect(toAtomic("0.10")).toBe("1000000");
    expect(toAtomic("1")).toBe("10000000");
    expect(toAtomic("0.0000001")).toBe("1");
  });

  it("does not round a price that a float would", () => {
    // 0.1 + 0.2 in binary floating point is the classic example; string
    // arithmetic has to be exact here because this number becomes a payment.
    expect(toAtomic("0.3")).toBe("3000000");
    expect(toAtomic("1.1")).toBe("11000000");
  });
});

describe("the two products", () => {
  it("prices the brief at 0.25 and the credits at 0.10, in both forms", () => {
    expect(productById("signaldesk:market-brief-xlm-usdc")).toMatchObject({
      price: "0.25",
      priceAtomic: "2500000",
    });
    expect(productById("signaldesk:ai-credits-1000")).toMatchObject({
      price: "0.10",
      priceAtomic: "1000000",
    });
  });

  it("derives every route template from its path, so the two cannot drift", () => {
    for (const product of PRODUCTS) {
      expect(product.routeTemplate.startsWith(product.path)).toBe(true);
      expect(productForPath(product.path)).toBe(product);
    }
  });

  it("declares every route input the template names", () => {
    for (const product of PRODUCTS) {
      const placeholders = [...product.routeTemplate.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      expect(product.input.map((input) => input.name).sort()).toEqual(placeholders.sort());
    }
  });

  it("sells nothing at an unknown path", () => {
    expect(productForPath("/api/x402/anything-else")).toBeUndefined();
  });
});

describe("the market brief artefact", () => {
  const input = { deliveryId: "01J7QW8VQEJPAXEPAYSIGNAL01", pair: "XLM/USDC", deliveredAt: new Date("2026-09-12T12:00:00.000Z") };

  it("says the data is synthetic before it says anything else", () => {
    const html = renderMarketBrief(input);
    const syntheticAt = html.indexOf("Datos sinteticos");
    const firstHeading = html.indexOf("<h1>");

    expect(syntheticAt).toBeGreaterThan(-1);
    expect(syntheticAt).toBeLessThan(firstHeading);
  });

  it("names no real market data product, anywhere", () => {
    const html = renderMarketBrief(input).toLowerCase();
    for (const forbidden of ["bloomberg", "reuters", "refinitiv", "coinmarketcap"]) {
      expect(html).not.toContain(forbidden);
    }
  });

  /** The hash in a receipt is only meaningful if the same delivery renders the same bytes. */
  it("renders identically for the same delivery, and differently for another", () => {
    expect(artifactHash(renderMarketBrief(input))).toBe(artifactHash(renderMarketBrief(input)));
    expect(artifactHash(renderMarketBrief({ ...input, deliveryId: "01J7QW8VQEJPAXEPAYSIGNAL02" }))).not.toBe(
      artifactHash(renderMarketBrief(input)),
    );
  });

  it("escapes what it is given rather than rendering it as markup", () => {
    const html = renderMarketBrief({ ...input, pair: "<script>alert(1)</script>" });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("the credits artefact", () => {
  it("states that the balance is not a token and not transferable", () => {
    const html = renderCreditsStatement({
      deliveryId: "01J7QW8VQEJPAXEPAYSIGNAL03",
      account: PAY_TO,
      granted: 1000,
      balance: 2000,
      deliveredAt: new Date("2026-09-12T12:00:00.000Z"),
    });

    expect(html).toContain("no son transferibles");
    expect(html).toContain("No son un token Stellar");
  });
});

describe("the human catalogue page", () => {
  const html = renderCatalogPage({ payTo: PAY_TO, discoveryPath: "/api/discovery/search" });

  it("shows every product, in both languages, with the same price the network would charge", () => {
    for (const product of PRODUCTS) {
      expect(html).toContain(productCopy(product).name.en);
      expect(html).toContain(productCopy(product).name.es);
      // Every product the catalogue sells has copy of its own, not the machine text as a fallback.
      expect(productCopy(product).name.en).not.toBe(product.name);
      expect(html).toContain(`${product.price} USDC`);
    }
  });

  it("states the retention period, the synthetic data and the non-transferability, in both languages", () => {
    expect(html).toContain("90 days");
    expect(html).toContain("90 días");
    expect(html).toContain("Synthetic data");
    expect(html).toContain("Datos sintéticos");
    expect(html).toContain("not transferable");
    expect(html).toContain("no son transferibles");
  });

  it("opens in English, carries the switch, and writes no em dash", () => {
    expect(html).toContain('<html lang="en"');
    expect(html).toContain('data-set-lang="es"');
    expect(html).toContain("Stellar Testnet · live");
    expect(html).not.toContain("—");
  });

  it("publishes the key a receipt is verified with, and the venue identity", () => {
    expect(html).toContain(PAY_TO);
    expect(html).toContain(`signaldesk:${PAY_TO}`);
  });
});
