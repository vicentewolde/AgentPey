/**
 * AgentPey's web design system on every Vitrinee host (T207, Y-7).
 *
 * The one stylesheet and the logo live in `apps/web/public/brand/` and agentpey.com serves them from there. The portal
 * (vitrinee.agentpey.com) and each store's pages (the receipt) are other origins, so this gateway serves the very same
 * files (stylesheet, logo, favicon) at the same paths: a page links `/brand/agentpey.css` wherever it is, and there is still one file to edit.
 *
 * A closed list, never a static folder: nothing else in that directory (a brand-kit zip, older logos) is served here.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import express, { type Router } from "express";

/** `src/` and `dist/` sit at the same depth, so one path works in both (as the dashboard's does). */
export const BRAND_DIR = fileURLToPath(new URL("../../../apps/web/public/brand", import.meta.url));

/** Published path → file name and type. */
export const BRAND_FILES: Readonly<Record<string, { readonly file: string; readonly type: string }>> = {
  "/brand/agentpey.css": { file: "agentpey.css", type: "text/css; charset=utf-8" },
  "/brand/agentpey-mark.svg": { file: "agentpey-mark.svg", type: "image/svg+xml" },
  "/brand/agentpey-favicon.svg": { file: "agentpey-favicon.svg", type: "image/svg+xml" },
};

export function brandRouter(dir: string = BRAND_DIR, log: (message: string, fields?: Record<string, unknown>) => void = () => {}): Router {
  const router = express.Router();
  for (const [path, { file, type }] of Object.entries(BRAND_FILES)) {
    router.get(path, (_req, res) => {
      if (!existsSync(`${dir}/${file}`)) {
        log("brand file missing", { path, dir });
        res.status(404).type("text/plain").send("not found");
        return;
      }
      res.set({ "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" });
      res.type(type).sendFile(file, { root: dir });
    });
  }
  return router;
}
