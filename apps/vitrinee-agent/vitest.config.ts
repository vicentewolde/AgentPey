import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export const aliases = {
  "@vitrinee/core": fileURLToPath(new URL("../../packages/vitrinee-core/src/index.ts", import.meta.url)),
  "@vitrinee/adapters": fileURLToPath(new URL("../../packages/vitrinee-adapters/src/index.ts", import.meta.url)),
  "@vitrinee/gateway": fileURLToPath(new URL("../../packages/vitrinee-gateway/src/index.ts", import.meta.url)),
  "@vitrinee/anchor": fileURLToPath(new URL("../../packages/vitrinee-anchor/src/index.ts", import.meta.url)),
};

export default defineConfig({
  resolve: { alias: aliases },
  test: { environment: "node", include: ["src/**/*.test.ts"], exclude: ["src/**/*.integration.test.ts", "**/node_modules/**"] },
});
