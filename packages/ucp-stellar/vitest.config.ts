import { defineConfig } from "vitest/config";

// No aliases on purpose: this package depends on nothing in the monorepo (T136).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
