import { isAgentPassError } from "@agentpass/core";
import { describe, expect, it } from "vitest";

import { createStorefrontDirectory } from "./storefronts.js";

const PAY = "GC5ZY7UJ7CKD7O7YURRSDIDVYEETYP2JXPKUL5E6GIWHUPAH5DCIVCII";
const fakeFetch = (body: unknown, status = 200) => {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fn, calls };
};
const catalogFor = () => ({ list: async () => [] });

describe("the Vitrinee store directory, as RealOps reads it (T104)", () => {
  it("names each store with the same venue id AgentPey builds from the same directory", async () => {
    const { fn } = fakeFetch({ comercios: [{ slug: "bazar-cordillera", name: "Bazar Cordillera", url: "https://bazar-cordillera.vitrinee.agentpey.com", payTo: PAY }] });
    const directory = createStorefrontDirectory({ directoryUrl: "https://d", platformHost: "vitrinee.agentpey.com", fetchImpl: fn, catalogFor });
    const [store] = await directory.list();
    expect(store).toMatchObject({ slug: "bazar-cordillera", venueId: `vitrinee-bazar-cordillera:${PAY}`, payTo: PAY, baseUrl: "https://bazar-cordillera.vitrinee.agentpey.com" });
    expect(await directory.get("bazar-cordillera")).toBeDefined();
    expect(await directory.get("nadie")).toBeUndefined();
  });

  it("skips any store AgentPey would refuse: another host, an http URL, a bad account, a slug too long", async () => {
    const { fn } = fakeFetch({
      comercios: [
        { slug: "a", name: "A", url: "https://attacker.example", payTo: PAY },
        { slug: "b", name: "B", url: "http://b.vitrinee.agentpey.com", payTo: PAY },
        { slug: "c", name: "C", url: "https://c.vitrinee.agentpey.com", payTo: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA" },
        { slug: "d".repeat(32), name: "D", url: `https://${"d".repeat(32)}.vitrinee.agentpey.com`, payTo: PAY },
        "junk",
      ],
    });
    const directory = createStorefrontDirectory({ directoryUrl: "https://d", platformHost: "vitrinee.agentpey.com", fetchImpl: fn, catalogFor });
    expect(await directory.list()).toEqual([]);
  });

  it("fails as a NetworkError when the directory cannot be read, so the page says so", async () => {
    const { fn } = fakeFetch({ error: "down" }, 503);
    const directory = createStorefrontDirectory({ directoryUrl: "https://d", platformHost: "vitrinee.agentpey.com", fetchImpl: fn, catalogFor });
    await expect(directory.list()).rejects.toSatisfy((error: unknown) => isAgentPassError(error) && error.code === "NetworkError");
  });

  it("reuses one directory answer for a short while", async () => {
    let clock = 0;
    const { fn, calls } = fakeFetch({ comercios: [] });
    const directory = createStorefrontDirectory({ directoryUrl: "https://d", platformHost: "vitrinee.agentpey.com", fetchImpl: fn, catalogFor, now: () => clock });
    await directory.list();
    clock = 10_000;
    await directory.list();
    expect(calls).toHaveLength(1);
  });
});
