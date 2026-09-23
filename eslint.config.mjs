import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Scoped to Vitrinee on purpose. The rest of AgentPey does not run eslint, and
// adding a repo-wide lint is AgentPey's decision to make, not a side effect of
// merging a feature in (docs/DECISIONES.md, P-12).
const VITRINEE_TS = [
  "packages/vitrinee-*/**/*.ts",
  "apps/vitrinee-*/**/*.ts",
  "scripts/vitrinee/**/*.ts",
];
const DASHBOARD_JS = ["apps/vitrinee-dashboard/public/**/*.js"];

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/*.tsbuildinfo"] },
  {
    files: VITRINEE_TS,
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // Tests read loosely-typed JSON responses; production code may not.
    files: ["packages/vitrinee-*/**/*.test.ts", "apps/vitrinee-*/**/*.test.ts", "scripts/vitrinee/**/*.test.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    // The dashboard is plain browser JavaScript, not Node.
    files: DASHBOARD_JS,
    extends: [js.configs.recommended],
    languageOptions: {
      globals: {
        document: "readonly",
        window: "readonly",
        fetch: "readonly",
        atob: "readonly",
        Node: "readonly",
        TextDecoder: "readonly",
        setInterval: "readonly",
        Uint8Array: "readonly",
      },
    },
  },
);
