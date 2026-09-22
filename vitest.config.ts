import { defineConfig } from "vitest/config";

// Repo-level scripts (bootstrap, deploy). Each package under packages/ and
// apps/ owns its own vitest config; `pnpm test` runs both.
export default defineConfig({
  test: { environment: "node", include: ["scripts/**/*.test.ts"] },
});
