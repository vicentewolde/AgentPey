import { JumpsellerStoreAdapter, MockStoreAdapter, type StoreAdapter } from "@vitrinee/adapters";
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
  }
}
