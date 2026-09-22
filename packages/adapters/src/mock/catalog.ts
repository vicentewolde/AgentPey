import type { Product } from "../types.js";

/**
 * Bazar Cordillera — a fictional shop in Ñuñoa, Santiago. Six products with
 * the shape a Jumpseller store would expose, priced in CLP (no decimals).
 * Used by tests and as the fallback adapter if the real platform is down.
 */
export const MOCK_STORE_NAME = "Bazar Cordillera";

export const MOCK_CATALOG: readonly Product[] = [
  {
    id: "hoodie-cordillera-m",
    sku: "HOOD-CORD-M",
    name: "Hoodie Cordillera talla M",
    description: "Polerón con capucha de algodón orgánico, bordado de la cordillera al frente. Talla M.",
    priceLocal: "34990",
    currency: "CLP",
    stock: 12,
    images: ["https://static.example.com/vitrinee/hoodie-cordillera-m.jpg"],
  },
  {
    id: "polera-valpo-l",
    sku: "POL-VALPO-L",
    name: "Polera Valpo talla L",
    description: "Polera de algodón peinado con serigrafía de los cerros de Valparaíso. Talla L.",
    priceLocal: "14990",
    currency: "CLP",
    stock: 20,
    images: ["https://static.example.com/vitrinee/polera-valpo-l.jpg"],
  },
  {
    id: "gorro-andes",
    sku: "GOR-ANDES",
    name: "Gorro Andes de lana",
    description: "Gorro tejido a mano en lana de oveja, talla única.",
    priceLocal: "12990",
    currency: "CLP",
    stock: 8,
    images: ["https://static.example.com/vitrinee/gorro-andes.jpg"],
  },
  {
    id: "cafe-nunoa-250",
    sku: "CAF-NUN-250",
    name: "Café de grano Ñuñoa 250 g",
    description: "Tueste medio, origen Colombia, notas a chocolate y frutos rojos. Bolsa de 250 g.",
    priceLocal: "8990",
    currency: "CLP",
    stock: 30,
    images: ["https://static.example.com/vitrinee/cafe-nunoa-250.jpg"],
  },
  {
    id: "botella-patagonia-500",
    sku: "BOT-PAT-500",
    name: "Botella térmica Patagonia 500 ml",
    description: "Acero inoxidable de doble pared, mantiene frío 24 h y calor 12 h.",
    priceLocal: "19990",
    currency: "CLP",
    stock: 2,
    images: ["https://static.example.com/vitrinee/botella-patagonia-500.jpg"],
  },
  {
    // The cheapest item on purpose: real-testnet integration runs buy it, so
    // one faucet drip (20 USDC) covers ~19 runs instead of two (V-14).
    id: "stickers-cordillera",
    sku: "STK-CORD-5",
    name: "Pack de stickers Cordillera",
    description: "Cinco stickers de vinilo mate con paisajes de la cordillera, resistentes al agua.",
    priceLocal: "990",
    currency: "CLP",
    stock: 200,
    images: ["https://static.example.com/vitrinee/stickers-cordillera.jpg"],
  },
];
