import { describe, expect, it } from "vitest";

import type { ManifestProduct } from "@vitrinee/core";

import { matchProduct, parseIntent, parseQuantity, parseShipping } from "./matcher.js";

const product = (id: string, sku: string, name: string, description = ""): ManifestProduct => ({
  id, sku, name, description,
  priceLocal: "1000", currency: "CLP", priceUSDC: "1.0526316", priceUSDCAtomic: "10526316", stock: 5, images: [], checkoutRoute: `/checkout/${id}`,
});

const CATALOG = [
  product("hoodie-cordillera-m", "HOOD-CORD-M", "Hoodie Cordillera talla M", "Polerón con capucha de algodón orgánico."),
  product("hoodie-cordillera-l", "HOOD-CORD-L", "Hoodie Cordillera talla L", "Polerón con capucha de algodón orgánico."),
  product("polera-valpo-l", "POL-VALPO-L", "Polera Valpo talla L", "Polera de algodón peinado."),
  product("gorro-andes", "GOR-ANDES", "Gorro Andes de lana", "Gorro tejido a mano."),
  product("cafe-nunoa-250", "CAF-NUN-250", "Café de grano Ñuñoa 250 g", "Tueste medio, origen Colombia."),
  product("botella-patagonia-500", "BOT-PAT-500", "Botella térmica Patagonia 500 ml", "Acero inoxidable."),
];

describe("parseQuantity", () => {
  it("reads a number right after the verb, defaults to one", () => {
    expect(parseQuantity("compra el hoodie talla M")).toBe(1);
    expect(parseQuantity("compra 2 gorros")).toBe(2);
    expect(parseQuantity("quiero dos cafés")).toBe(2);
    expect(parseQuantity("cómprame tres poleras")).toBe(3);
    expect(parseQuantity("compra la botella de 500 ml")).toBe(1);
    expect(parseQuantity("un gorro")).toBe(1);
  });
});

describe("parseShipping", () => {
  it("extracts the city after the shipping verb, keeping accents", () => {
    expect(parseShipping("compra el hoodie talla M y envíalo a Ñuñoa")).toEqual({ city: "Ñuñoa", country: "CL" });
    expect(parseShipping("compra un gorro, despáchalo a Las Condes por favor")).toEqual({ city: "Las Condes", country: "CL" });
    expect(parseShipping("compra café y mándalo a la comuna de Providencia")).toEqual({ city: "Providencia", country: "CL" });
    expect(parseShipping("compra café y envíalo a Santiago y avísame")).toEqual({ city: "Santiago", country: "CL" });
    expect(parseShipping("compra café")).toEqual({ country: "CL" });
    expect(parseShipping("cómprame dos cafés y despáchalos a Providencia")).toEqual({ city: "Providencia", country: "CL" });
    expect(parseShipping("compra dos gorros y envíalos a Maipú")).toEqual({ city: "Maipú", country: "CL" });
  });
});

describe("matchProduct", () => {
  it("picks by name, respects the size, and explains itself", () => {
    const m = matchProduct(CATALOG, "compra el hoodie talla M y envíalo a Ñuñoa");
    expect(m.product.id).toBe("hoodie-cordillera-m");
    expect(m.reasons).toContain("talla M");
    expect(m.reasons).not.toContain('"m" en el nombre');
    expect(matchProduct(CATALOG, "quiero el hoodie talla l").product.id).toBe("hoodie-cordillera-l");
  });

  it("matches accents-insensitively, by SKU, and by plural", () => {
    expect(matchProduct(CATALOG, "compra cafe de grano").product.id).toBe("cafe-nunoa-250");
    expect(matchProduct(CATALOG, "compra 2 gorros de lana").product.id).toBe("gorro-andes");
    expect(matchProduct(CATALOG, "compra BOT-PAT-500").product.id).toBe("botella-patagonia-500");
    expect(matchProduct(CATALOG, "compra la botella térmica").product.id).toBe("botella-patagonia-500");
  });

  it("does not let the shipping city pollute the match", () => {
    // "Valpo" is a product; "Valparaíso" as a destination must not pick it when the item is a gorro.
    expect(matchProduct(CATALOG, "compra el gorro y envíalo a Valparaíso").product.id).toBe("gorro-andes");
  });

  it("refuses nonsense and ambiguity", () => {
    expect(() => matchProduct(CATALOG, "compra un dron")).toThrow(/no entendí/);
    expect(() => matchProduct(CATALOG, "compra el hoodie")).toThrow(/ambigua/);
  });
});

describe("parseIntent", () => {
  it("assembles product, quantity and shipping", () => {
    const intent = parseIntent(CATALOG, "cómprame dos cafés y envíalos a Ñuñoa");
    expect(intent.product.id).toBe("cafe-nunoa-250");
    expect(intent.quantity).toBe(2);
    expect(intent.shipping).toEqual({ city: "Ñuñoa", country: "CL" });
  });
});
