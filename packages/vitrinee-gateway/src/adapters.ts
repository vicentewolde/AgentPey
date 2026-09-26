import { JumpsellerStoreAdapter, MockStoreAdapter, ShopifyStoreAdapter, type StoreAdapter } from "@vitrinee/adapters";
import { VitrineeError } from "@vitrinee/core";

import type { GatewayConfig } from "./config.js";

/** The store adapter a gateway config names. Moved out of `main.ts` so each comercio's store gets its own (T103). */
export function createAdapter(config: GatewayConfig, log: (message: string, fields?: Record<string, unknown>) => void = () => {}): StoreAdapter {
  switch (config.adapter) {
    case "mock":
      return new MockStoreAdapter({ ordersFile: config.mockOrdersFile });
    case "jumpseller": {
      if (config.jumpseller === undefined) {
        throw new VitrineeError("ConfigError", "ADAPTER=jumpseller needs JUMPSELLER_LOGIN and JUMPSELLER_AUTHTOKEN");
      }
      return new JumpsellerStoreAdapter({
        credentials: config.jumpseller,
        currency: config.merchant.currency,
        onWarning: (message, details) => log(message, details),
      });
    }
    case "shopify": {
      if (config.shopify === undefined) {
        throw new VitrineeError("ConfigError", "ADAPTER=shopify needs SHOPIFY_SHOP, SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET");
      }
      return new ShopifyStoreAdapter({
        credentials: config.shopify,
        currency: config.merchant.currency,
        onWarning: (message, details) => log(message, details),
      });
    }
  }
}
