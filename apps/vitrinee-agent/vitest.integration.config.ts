import { defineConfig } from "vitest/config";

import { aliases } from "./vitest.config.js";

// Real Stellar testnet, real facilitator, real USDC. Never part of `pnpm test`.
export default defineConfig({
  resolve: { alias: aliases },
  test: { environment: "node", include: ["src/**/*.integration.test.ts"], testTimeout: 120_000, hookTimeout: 60_000 },
});
