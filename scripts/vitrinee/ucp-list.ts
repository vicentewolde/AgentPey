#!/usr/bin/env node
/**
 * `pnpm run vitrinee:ucp:list -- <store URL>` — reads a storefront the way a
 * UCP agent would (T121): its `/.well-known/ucp` profile, the namespace check
 * on every spec URL, the Stellar x402 handler, and the catalog. Read-only and
 * without secrets, so its output can be pasted in a chat.
 *
 *   pnpm run vitrinee:ucp:list -- https://bazar-cordillera.vitrinee.agentpey.com
 */
import { isVitrineeError } from "../../packages/vitrinee-core/src/index.js";
import { readUcpStorefront } from "./lib/ucp-client.js";

const baseUrl = process.argv.slice(2).find((arg) => arg !== "--");
if (baseUrl === undefined || !URL.canParse(baseUrl)) {
  process.stderr.write("usage: pnpm run vitrinee:ucp:list -- <store URL>\n");
  process.exit(1);
}

try {
  const store = await readUcpStorefront(baseUrl);
  const out = (line: string) => process.stdout.write(`${line}\n`);
  out(`✓ UCP profile ${store.profile.ucp.version} at ${baseUrl}`);
  out(`✓ every spec and schema URL is on its namespace's domain`);
  out(`✓ REST endpoint ${store.endpoint}`);
  out(`✓ pays with com.agentpey.stellar_x402: ${store.handler.asset.code} on ${store.handler.network}, to ${store.handler.pay_to}`);
  out(`\n${store.products.length} product(s):`);
  for (const product of store.products) {
    const [variant] = product.variants;
    const available = variant?.availability?.available === false ? " (sin stock)" : "";
    out(`  ${product.id.padEnd(28)} ${String(variant?.price.amount).padStart(9)} ${variant?.price.currency}  ${product.title}${available}`);
  }
} catch (error) {
  process.stderr.write(`\n✗ ${isVitrineeError(error) ? `${error.code}: ${error.message}` : String(error)}\n`);
  process.exit(1);
}
