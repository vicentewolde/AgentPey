import { hasErrorCode } from "@agentpass/core";
import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { makeVenueId } from "./ids.js";
import { expandPlatformVenues } from "./platforms.js";
import { baseUrlForVenue, loadVenueRegistry, mapAssetCodeForVenue } from "./registry.js";

const USDC = { code: "USDC", issuer: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA" };
const EURC = { code: "EURC", issuer: "CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ" };
const FIXED = "GB4D4PLLFEIKZK6MDW42MZRQ5XMPC6QRJN4FFRODO6D3PRB3MDGGYOOF";
const DIRECTORY = "https://vitrinee.example/api/comercios";

const registry = loadVenueRegistry([
  { slug: "signaldesk", address: FIXED, baseUrl: "https://signaldesk.example", assets: [USDC] },
  { kind: "platform", slug: "vitrinee", host: "vitrinee.example", directoryUrl: DIRECTORY, assets: [USDC] },
]);

function directoryFetch(body: unknown, status = 200): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const payA = Keypair.random().publicKey();
const entry = (slug: string, payTo = payA, url = `https://${slug}.vitrinee.example`) => ({ slug, name: slug, url, payTo });

describe("expandPlatformVenues (T104, C-141)", () => {
  it("turns each directory entry into a venue at the platform's own subdomain, with the platform's assets and a pinned payee", async () => {
    const fetchImpl = directoryFetch({ comercios: [{ ...entry("bazar"), assets: [EURC] }] });
    const expanded = await expandPlatformVenues(registry, { fetchImpl });
    const venueId = makeVenueId("vitrinee-bazar", payA);
    const venue = expanded.venues.get(venueId as never);
    expect(venue).toBeDefined();
    expect(baseUrlForVenue(expanded, venueId as never)).toBe("https://bazar.vitrinee.example");
    expect(venue?.payTo).toBe(payA);
    expect(mapAssetCodeForVenue(expanded, venueId as never, "USDC")).toBe(`USDC:${USDC.issuer}`);
    // The directory said EURC; the platform row did not. It is not an asset of this merchant.
    expect(() => mapAssetCodeForVenue(expanded, venueId as never, "EURC")).toThrow();
    // The fixed venue is still there, and the input registry was not touched.
    expect(expanded.venues.get(makeVenueId("signaldesk", FIXED) as never)).toBeDefined();
    expect(registry.venues.has(venueId as never)).toBe(false);
  });

  it("drops every entry that is not exactly one of the platform's stores", async () => {
    const issues: string[] = [];
    const fetchImpl = directoryFetch({
      comercios: [
        entry("otra-url", payA, "https://attacker.example"),
        entry("sufijo", payA, "https://sufijo.vitrinee.example.attacker.example"),
        entry("http", payA, "http://http.vitrinee.example"),
        entry("cuenta", "GNOTANACCOUNT"),
        entry("contrato", "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"),
        entry("a".repeat(32)),
        entry("Mayus"),
        { slug: "sin-url", payTo: payA },
        "not even an object",
      ],
    });
    const expanded = await expandPlatformVenues(registry, { fetchImpl, onIssue: (_p, issue) => issues.push(issue) });
    expect(expanded.venues.size).toBe(registry.venues.size);
    expect(issues).toHaveLength(9);
  });

  it("contributes no merchant when the directory cannot be read — paying them is refused, not guessed", async () => {
    for (const fetchImpl of [
      directoryFetch({ error: "down" }, 503),
      directoryFetch({ nope: [] }),
      (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    ]) {
      const expanded = await expandPlatformVenues(registry, { fetchImpl });
      expect(expanded.venues.size).toBe(registry.venues.size);
    }
  });

  it("reads the directory only for a venue that could be one of the platform's merchants", async () => {
    const fetchImpl = directoryFetch({ comercios: [entry("bazar")] });
    await expandPlatformVenues(registry, { fetchImpl, onlyFor: `comercio-hostil:${FIXED}` });
    await expandPlatformVenues(registry, { fetchImpl, onlyFor: `signaldesk:${FIXED}` });
    expect(fetchImpl.calls).toEqual([]);
    await expandPlatformVenues(registry, { fetchImpl, onlyFor: makeVenueId("vitrinee-bazar", payA) });
    expect(fetchImpl.calls).toEqual([DIRECTORY]);
  });

  it("reuses one directory answer for a short while", async () => {
    let clock = 0;
    const fetchImpl = directoryFetch({ comercios: [entry("bazar")] });
    await expandPlatformVenues(registry, { fetchImpl, now: () => clock });
    clock = 10_000;
    await expandPlatformVenues(registry, { fetchImpl, now: () => clock });
    expect(fetchImpl.calls).toHaveLength(1);
    clock = 40_000;
    await expandPlatformVenues(registry, { fetchImpl, now: () => clock });
    expect(fetchImpl.calls).toHaveLength(2);
  });

  it("allows http only for a localhost platform, for local runs", async () => {
    const local = loadVenueRegistry([{ kind: "platform", slug: "vitrinee", host: "localhost", directoryUrl: "http://localhost:4021/api/comercios", assets: [USDC] }]);
    const expanded = await expandPlatformVenues(local, { fetchImpl: directoryFetch({ comercios: [entry("bazar", payA, "http://bazar.localhost")] }) });
    expect(expanded.venues.size).toBe(1);
  });
});

describe("loadVenueRegistry with platforms", () => {
  it("refuses a fixed venue that uses a platform's slug, since the platform's merchants are named after it", () => {
    for (const slug of ["vitrinee", "vitrinee-bazar"]) {
      try {
        loadVenueRegistry([
          { slug, address: FIXED, baseUrl: "https://x.example", assets: [USDC] },
          { kind: "platform", slug: "vitrinee", host: "vitrinee.example", directoryUrl: DIRECTORY, assets: [USDC] },
        ]);
        expect.unreachable(slug);
      } catch (error) {
        expect(hasErrorCode(error, "InvalidVenueRegistry")).toBe(true);
      }
    }
  });

  it("refuses a platform named twice, or a host with a scheme", () => {
    const row = { kind: "platform", slug: "vitrinee", host: "vitrinee.example", directoryUrl: DIRECTORY, assets: [USDC] };
    expect(() => loadVenueRegistry([row, row])).toThrow();
    expect(() => loadVenueRegistry([{ ...row, host: "https://vitrinee.example" }])).toThrow();
  });
});
