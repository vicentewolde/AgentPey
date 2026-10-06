/**
 * The wallet layer the signing screens load (T143, R-23): Stellar Wallets Kit bundled by `pnpm build`, served from
 * this origin so no CDN is in the page at load time. A 503 says the bundle is not built, rather than a page that
 * silently has no wallet.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";

import { WALLET_KIT_BUNDLE } from "@agentpey/wallet-kit";

export const WALLET_KIT_HEADERS = { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" } as const;

export async function serveWalletKit(res: ServerResponse, options: { readonly bundle?: string; readonly onMissing?: (path: string) => void } = {}): Promise<void> {
  const bundle = options.bundle ?? WALLET_KIT_BUNDLE;
  try {
    await stat(bundle);
  } catch {
    options.onMissing?.(bundle);
    res.writeHead(503, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ code: "NotFound", message: "the wallet layer is not built; run pnpm build" }));
    return;
  }
  res.writeHead(200, WALLET_KIT_HEADERS);
  createReadStream(bundle).pipe(res);
}
