import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@vitrinee/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
      "@vitrinee/adapters": fileURLToPath(new URL("../adapters/src/index.ts", import.meta.url)),
      "@vitrinee/anchor": fileURLToPath(new URL("../anchor/src/index.ts", import.meta.url)),
    },
  },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
