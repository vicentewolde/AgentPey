import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@agentpass/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
      "@agentpass/sdk": fileURLToPath(new URL("../../packages/sdk/src/index.ts", import.meta.url)),
      "@agentpey/ap2": fileURLToPath(new URL("../../packages/ap2/src/index.ts", import.meta.url)),
      "@agentpey/mandate": fileURLToPath(new URL("../../packages/mandate/src/index.ts", import.meta.url)),
      "@agentpey/vault": fileURLToPath(new URL("../../packages/vault/src/index.ts", import.meta.url)),
      "@agentpey/ucp-stellar": fileURLToPath(new URL("../../packages/ucp-stellar/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
