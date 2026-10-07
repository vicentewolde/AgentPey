import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Covers the repo-level scripts (bootstrap, deploy). Each package under
// packages/ owns its own vitest config; `pnpm test` runs both.
export default defineConfig({
  resolve: {
    alias: {
      "@agentpass/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@agentpass/sdk": fileURLToPath(new URL("./packages/sdk/src/index.ts", import.meta.url)),
      "@agentpey/vault": fileURLToPath(new URL("./packages/vault/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["scripts/**/*.test.ts"],
  },
});
