import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BRAND_DIR, BRAND_FILES, brandRouter } from "./brand.js";

describe("AgentPey's brand files on Vitrinee hosts (T207)", () => {
  const dir = mkdtempSync(join(tmpdir(), "brand-"));
  writeFileSync(join(dir, "agentpey.css"), ":root{--ap-accent:#176bff}");
  writeFileSync(join(dir, "agentpey-mark.svg"), "<svg></svg>");
  writeFileSync(join(dir, "agentpey-favicon.svg"), "<svg></svg>");
  writeFileSync(join(dir, "agentpey-brand-kit.zip"), "zip");
  const app = express();
  app.use(brandRouter(dir));
  let base = "";
  let server: ReturnType<typeof app.listen>;
  beforeAll(async () => {
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it("serves the stylesheet, the logo and the favicon with their types", async () => {
    const css = await fetch(`${base}/brand/agentpey.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(css.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await css.text()).toContain("--ap-accent");
    const svg = await fetch(`${base}/brand/agentpey-mark.svg`);
    expect(svg.status).toBe(200);
    expect(svg.headers.get("content-type")).toContain("image/svg+xml");
    const favicon = await fetch(`${base}/brand/agentpey-favicon.svg`);
    expect(favicon.status).toBe(200);
    expect(favicon.headers.get("content-type")).toContain("image/svg+xml");
  });

  it("serves nothing else from that folder", async () => {
    expect((await fetch(`${base}/brand/agentpey-brand-kit.zip`)).status).toBe(404);
    expect((await fetch(`${base}/brand/../brand/agentpey.css`)).status).toBe(200);
    expect((await fetch(`${base}/brand/`)).status).toBe(404);
  });

  it("points at the files agentpey.com serves, which exist in the repo", async () => {
    const { existsSync } = await import("node:fs");
    for (const { file } of Object.values(BRAND_FILES)) expect(existsSync(join(BRAND_DIR, file))).toBe(true);
  });
});
