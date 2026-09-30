/**
 * The T121 test client against a real Vitrinee app, no network: what a UCP
 * agent sees from a storefront, and what it refuses.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MockStoreAdapter } from "../../packages/vitrinee-adapters/src/index.js";
import { createApp } from "../../packages/vitrinee-gateway/src/app.js";
import { fakeFacilitator } from "../../packages/vitrinee-gateway/src/test/fake-facilitator.js";
import { MERCHANT, fakeRegistry, testConfig } from "../../packages/vitrinee-gateway/src/test/fixtures.js";
import { listen } from "../../packages/vitrinee-gateway/src/test/listen.js";
import { readUcpStorefront } from "./lib/ucp-client.js";

describe("UCP test client", () => {
  const { anchorer, registry } = fakeRegistry();
  const app = createApp({ config: testConfig(), adapter: new MockStoreAdapter(), facilitator: fakeFacilitator(), anchorer, registry });
  let url = "";
  let close: () => Promise<void> = async () => {};

  beforeAll(async () => {
    ({ url, close } = await listen(app));
  });
  afterAll(() => close());

  it("reads the profile, checks it and lists every product across pages", async () => {
    const store = await readUcpStorefront(url);
    expect(store.endpoint).toBe(`${url}/ucp/v1`);
    expect(store.handler.pay_to).toBe(MERCHANT);
    expect(store.products.map((p) => p.id).sort()).toEqual([
      "botella-patagonia-500",
      "cafe-nunoa-250",
      "gorro-andes",
      "hoodie-cordillera-m",
      "polera-valpo-l",
      "stickers-cordillera",
    ]);
  });

  it("refuses a profile that advertises the handler from somebody else's domain", async () => {
    const hijacked: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (!String(input).endsWith("/.well-known/ucp")) return res;
      const profile = (await res.json()) as { ucp: { payment_handlers: Record<string, Array<{ spec: string }>> } };
      const [handler] = profile.ucp.payment_handlers["com.agentpey.stellar_x402"] ?? [];
      if (handler !== undefined) handler.spec = "https://evil.example/stellar-x402/spec";
      return Response.json(profile);
    };
    await expect(readUcpStorefront(url, hijacked)).rejects.toMatchObject({ code: "ValidationError", message: /outside its namespace/ });
  });

  it("refuses a host that does not speak UCP, and says so when it cannot connect", async () => {
    await expect(readUcpStorefront(`${url}/nothing-here`)).rejects.toMatchObject({ code: "NetworkError" });
    await expect(readUcpStorefront("http://127.0.0.1:9")).rejects.toMatchObject({ code: "NetworkError" });
  });
});
