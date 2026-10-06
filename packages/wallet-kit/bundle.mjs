// Bundles src/browser.ts into dist/wallet-kit.js: one self-hosted file per app, no CDN at page load (T143).
import { build } from "esbuild";

const result = await build({
  entryPoints: ["src/browser.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  minify: true,
  outfile: "dist/wallet-kit.js",
  legalComments: "eof",
  metafile: true,
  logLevel: "warning",
});
const bytes = Object.values(result.metafile.outputs).reduce((sum, output) => sum + output.bytes, 0);
console.log(`dist/wallet-kit.js ${(bytes / 1024).toFixed(0)} KB`);
