import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ucpPublicPath } from "./ucp-public.js";

const PUBLIC_DIR = resolve(fileURLToPath(new URL("../public", import.meta.url)));

describe("the UCP documents agentpey.com publishes (Fase 7, E-1)", () => {
  const published = [
    { url: "https://agentpey.com/ucp/handlers/stellar-x402/spec", file: "/ucp/handlers/stellar-x402/spec.md" },
    { url: "https://agentpey.com/ucp/handlers/stellar-x402/schema.json", file: "/ucp/handlers/stellar-x402/schema.json" },
    { url: "https://agentpey.com/ucp/extensions/receipt/spec", file: "/ucp/extensions/receipt/spec.md" },
    { url: "https://agentpey.com/ucp/extensions/receipt/schema.json", file: "/ucp/extensions/receipt/schema.json" },
  ];

  for (const { url, file } of published) {
    it(`serves ${url} from a file that exists`, async () => {
      expect(ucpPublicPath(new URL(url).pathname)).toBe(file);
      await expect(stat(resolve(PUBLIC_DIR, `.${file}`))).resolves.toBeTruthy();
    });
  }

  it("gives each schema the $id of the URL it is served at, so references resolve", async () => {
    for (const { url, file } of published.filter((p) => p.file.endsWith(".json"))) {
      const schema = JSON.parse(await readFile(resolve(PUBLIC_DIR, `.${file}`), "utf8")) as { $id: string };
      expect(schema.$id).toBe(url);
    }
  });

  it("claims nothing else under /ucp/", () => {
    expect(ucpPublicPath("/ucp/handlers/other/spec")).toBeUndefined();
    expect(ucpPublicPath("/ucp/handlers/stellar-x402/spec/../../../../.env")).toBeUndefined();
    expect(ucpPublicPath("/ucp/handlers/stellar-x402/")).toBeUndefined();
    expect(ucpPublicPath("/landing")).toBeUndefined();
  });
});
