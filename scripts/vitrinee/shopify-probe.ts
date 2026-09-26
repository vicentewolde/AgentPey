#!/usr/bin/env node
/**
 * `pnpm run vitrinee:shopify:probe` — checks a real Shopify store against the
 * adapter, before anything is registered (T112, VT-33). Prints no secret, so
 * its output can be pasted in a chat.
 *
 * Reads SHOPIFY_SHOP, SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET from
 * `.env.vitrinee.local` (or the environment). Steps, stopping at the first failure:
 *
 * 1. Exchanges the client credentials for a token and reads the catalogue.
 * 2. Lists what an agent would see: id, SKU, name, price, stock.
 *
 * With `--order`, it also creates one PAID order for the first product with
 * stock, quantity 1, tagged as a probe, and reads it back. That order really
 * exists in the store (and decrements one unit of stock); cancel it there.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ShopifyStoreAdapter } from "../../packages/vitrinee-adapters/src/index.js";
import { readEnvFile } from "./lib/env-file.js";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

function die(message: string): never {
  process.stderr.write(`\n✗ ${message}\n`);
  process.exit(1);
}

const file = Object.fromEntries((await readEnvFile(resolve(REPO_ROOT, ".env.vitrinee.local"))).values);
const pick = (key: string): string | undefined => process.env[key] || file[key] || undefined;
const shop = pick("SHOPIFY_SHOP");
const clientId = pick("SHOPIFY_CLIENT_ID");
const clientSecret = pick("SHOPIFY_CLIENT_SECRET");
if (!shop || !clientId || !clientSecret) die("needs SHOPIFY_SHOP, SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET in .env.vitrinee.local");

const adapter = new ShopifyStoreAdapter({
  credentials: { shop, clientId, clientSecret },
  currency: pick("SHOPIFY_CURRENCY") ?? "CLP",
  onWarning: (message, details) => process.stdout.write(`  ! ${message} ${JSON.stringify(details)}\n`),
});

try {
  process.stdout.write(`store: ${shop}\n`);
  const products = await adapter.listProducts();
  process.stdout.write(`✓ token exchanged and catalogue read: ${products.length} product(s) on sale\n`);
  for (const p of products) {
    process.stdout.write(`  ${p.id}  ${p.sku.padEnd(16)} ${p.priceLocal.padStart(8)} ${p.currency}  stock ${p.stock ?? "untracked"}  ${p.name}\n`);
  }
  if (products.length === 0) die("no sellable product: each needs status Active and a SKU of its own");

  if (process.argv.includes("--order")) {
    const target = products.find((p) => p.stock === null || p.stock > 0);
    if (target === undefined) die("every product is out of stock");
    const order = await adapter.createOrder({
      productId: target.id,
      quantity: 1,
      buyer: {
        stellarAccount: "GPROBE",
        shipping: { name: "Probe Vitrinee", address: "Calle de Prueba 1", city: "Santiago", country: "CL" },
      },
      paymentRef: { txHash: "probe".padEnd(64, "0"), network: "stellar:testnet", asset: "USDC", amountUSDCAtomic: "1", payerAccount: "GPROBE" },
      reference: `probe_${Date.now()}`,
    });
    process.stdout.write(`✓ order created: #${order.platformOrderId}  ${order.totalLocal} ${order.currency}  ${order.adminUrl ?? ""}\n`);
    const back = await adapter.getOrder(order.platformOrderId);
    if (back === null) die("the order was created but reading it back returned nothing");
    process.stdout.write(`✓ read back: status ${back.status}, sku ${back.sku}, qty ${back.quantity}, reference ${back.reference}\n`);
    process.stdout.write("  Cancel the probe order in the Shopify admin (restock) when you are done.\n");
  }
} catch (error) {
  const e = error as { code?: string; message?: string; details?: unknown };
  die(`${e.code ?? "Error"}: ${e.message ?? String(error)}${e.details === undefined ? "" : `\n  ${JSON.stringify(e.details)}`}`);
}
