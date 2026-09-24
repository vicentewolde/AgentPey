import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // The neutral piece C-88 lets Vitrinee import: SEP-0053 verification (T105).
      "@agentpass/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
      "@vitrinee/core": fileURLToPath(new URL("../vitrinee-core/src/index.ts", import.meta.url)),
      "@vitrinee/adapters": fileURLToPath(new URL("../vitrinee-adapters/src/index.ts", import.meta.url)),
      "@vitrinee/anchor": fileURLToPath(new URL("../vitrinee-anchor/src/index.ts", import.meta.url)),
    },
  },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
