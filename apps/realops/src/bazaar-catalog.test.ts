import { describe, expect, it, vi } from "vitest";

import { isAgentPassError } from "@agentpass/core";

import { createBazaarCatalog, deduplicate, fillRoute, preflightResource, type BazaarResource } from "./bazaar-catalog.js";

const BASE = "https://bazaar.example";

function card(overrides: Partial<Record<string, unknown>> = {}): unknown {
  return {
    id: "swap-risk-quote",
    name: "Swap Risk Quote (Sandbox)",
    description: "Deterministic read-only swap risk quote.",
    payment: { scheme: "exact", asset: "USDC", amount: "0.001", destination: "GDVR2KDK" },
    routeTemplate: "/api/x402/swap-risk?pair={pair}&amount={amount}&side={side}",
    input: [
      { name: "pair", type: "string", required: true },
      { name: "amount", type: "number", required: true },
      { name: "side", type: "string", required: true },
    ],
    ...overrides,
  };
}

function searchResponse(resources: readonly unknown[]): Response {
  return new Response(JSON.stringify({ ok: true, results: resources.map((resource) => ({ resource })) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch that answers the search with `resources` and every other URL with `status`. */
function fetchFor(resources: readonly unknown[], status = 402): typeof fetch {
  return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.includes("/api/discovery/search")) return searchResponse(resources);
    return new Response("", { status });
  }) as unknown as typeof fetch;
}

const resource = (overrides: Partial<BazaarResource> = {}): BazaarResource => ({
  id: "swap-risk-quote",
  name: "Swap Risk Quote",
  description: "",
  declaredAmount: "0.001",
  declaredAsset: "USDC",
  declaredPayTo: "GDVR2KDK",
  routeTemplate: "/api/x402/swap-risk?pair={pair}",
  inputs: [{ name: "pair", type: "string", required: true }],
  ...overrides,
});

describe("fillRoute", () => {
  it("encodes every value it substitutes", () => {
    expect(fillRoute("/api/x?pair={pair}", { pair: "XLM/USDC" })).toBe("/api/x?pair=XLM%2FUSDC");
  });

  /**
   * A placeholder with no value is left as `{name}` rather than blanked, so a
   * template this does not understand produces a URL the merchant rejects
   * instead of a plausible-looking wrong one.
   */
  it("leaves a placeholder it has no value for", () => {
    expect(fillRoute("/api/x?pair={pair}&side={side}", { pair: "A" })).toBe("/api/x?pair=A&side={side}");
  });
});

describe("deduplicate", () => {
  /**
   * The live bazaar returns `ai-video-scriptwriter` twice, and the two rows
   * disagree about its inputs. Checked against the deployment on 2026-09-22,
   * not read from documentation.
   */
  it("keeps one row per id, preferring the better described duplicate", () => {
    const bare = resource({ id: "dup", inputs: [{ name: "topic", type: "string", required: true }] });
    const described = resource({
      id: "dup",
      inputs: [{ name: "topic", type: "string", required: true, description: "Subject of the video" }],
    });

    expect(deduplicate([bare, described])).toEqual([described]);
    // And the other way round: which row arrives first must not decide it.
    expect(deduplicate([described, bare])).toEqual([described]);
  });

  it("keeps distinct ids, in the order they first appeared", () => {
    const a = resource({ id: "a" });
    const b = resource({ id: "b" });
    expect(deduplicate([a, b, a]).map((row) => row.id)).toEqual(["a", "b"]);
  });
});

describe("preflightResource", () => {
  /**
   * The bug this function was rewritten for. The first version filled the
   * route's parameters with made-up values, and the live bazaar answered `400
   * INVALID_QUOTE_INPUT` — it validates before it quotes — so an open shop
   * showed as shut on the very screen built to tell those apart. It now asks
   * the bare route and invents nothing.
   */
  it("asks the route with no parameters filled in at all", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      seen.push(String(input));
      return new Response("", { status: 402 });
    }) as unknown as typeof fetch;

    await preflightResource(BASE, resource(), fetchImpl, 1000);
    expect(seen).toEqual([`${BASE}/api/x402/swap-risk`]);
    expect(seen[0]).not.toContain("{");
    expect(seen[0]).not.toContain("?");
  });

  it("calls a route that quotes sellable", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 402 })) as unknown as typeof fetch;
    await expect(preflightResource(BASE, resource(), fetchImpl, 1000)).resolves.toBe("sellable");
  });

  /**
   * A merchant that validates the empty request on its own terms is a merchant
   * that serves the route. The live `swap-risk` answers exactly this.
   */
  it("calls a route that rejects the empty request sellable", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 400 })) as unknown as typeof fetch;
    await expect(preflightResource(BASE, resource(), fetchImpl, 1000)).resolves.toBe("sellable");
  });

  /**
   * The live `ai-video-scriptwriter` advertises `/api/script`, which answers
   * `404` on every host the bazaar is reachable at. A listing is a claim; this
   * is the check.
   */
  it("calls a route that is not there unavailable", async () => {
    for (const status of [404, 405, 410]) {
      const fetchImpl = vi.fn(async () => new Response("", { status })) as unknown as typeof fetch;
      await expect(preflightResource(BASE, resource(), fetchImpl, 1000)).resolves.toBe("unavailable");
    }
  });

  /** A merchant erroring is not a merchant refusing to sell. */
  it("reports unknown when the merchant itself errs", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    await expect(preflightResource(BASE, resource(), fetchImpl, 1000)).resolves.toBe("unknown");
  });

  /** Our network failing is not the merchant refusing, and must not be reported as one. */
  it("reports unknown when the check itself could not be made", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    await expect(preflightResource(BASE, resource(), fetchImpl, 1000)).resolves.toBe("unknown");
  });

  it("reports unknown for a resource with no route to probe", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const without = { ...resource() } as BazaarResource & { routeTemplate?: string };
    delete without.routeTemplate;
    await expect(preflightResource(BASE, without, fetchImpl, 1000)).resolves.toBe("unknown");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  /**
   * A placeholder in the path cannot be dropped the way a query string can, and
   * filling it would be the guess this function exists to avoid.
   */
  it("does not probe a route whose path itself has a placeholder", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const awkward = resource({ routeTemplate: "/api/x402/{id}/quote" });
    await expect(preflightResource(BASE, awkward, fetchImpl, 1000)).resolves.toBe("unknown");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("createBazaarCatalog", () => {
  it("reads, deduplicates and marks availability in one pass", async () => {
    const catalog = createBazaarCatalog({
      baseUrl: BASE,
      fetchImpl: fetchFor([card(), card({ id: "other" }), card()]),
      cacheMs: 0,
    });

    const rows = await catalog.list();
    expect(rows.map((row) => row.id)).toEqual(["swap-risk-quote", "other"]);
    expect(rows.every((row) => row.availability === "sellable")).toBe(true);
    expect(rows[0]!.declaredAmount).toBe("0.001");
    expect(rows[0]!.declaredPayTo).toBe("GDVR2KDK");
  });

  it("marks a listed resource the merchant is not charging for", async () => {
    const catalog = createBazaarCatalog({ baseUrl: BASE, fetchImpl: fetchFor([card()], 404), cacheMs: 0 });
    const rows = await catalog.list();
    expect(rows[0]!.availability).toBe("unavailable");
  });

  /**
   * An unreachable or nonsensical catalogue throws a typed error rather than
   * coming back as an empty list: "published nothing" and "could not be asked"
   * are different facts and the screen shows them differently.
   */
  it("throws a typed error rather than returning an empty catalogue", async () => {
    const cases: readonly (() => typeof fetch)[] = [
      () => (vi.fn(async () => new Response("", { status: 500 })) as unknown as typeof fetch),
      () => (vi.fn(async () => new Response("not json", { status: 200 })) as unknown as typeof fetch),
      () =>
        (vi.fn(async () => new Response(JSON.stringify({ ok: true, results: [{ resource: { id: 1 } }] }), { status: 200 })) as unknown as typeof fetch),
      () =>
        (vi.fn(async () => new Response(JSON.stringify({ ok: false, results: [] }), { status: 200 })) as unknown as typeof fetch),
      () =>
        (vi.fn(async () => {
          throw new Error("ENOTFOUND");
        }) as unknown as typeof fetch),
    ];

    for (const make of cases) {
      const catalog = createBazaarCatalog({ baseUrl: BASE, fetchImpl: make(), cacheMs: 0 });
      const error = await catalog.list().catch((thrown: unknown) => thrown);
      expect(isAgentPassError(error)).toBe(true);
      expect((error as { code: string }).code).toBe("NetworkError");
    }
  });

  it("reuses a read inside the cache window and goes back after it", async () => {
    const fetchImpl = fetchFor([card()]);
    let clock = 0;
    const catalog = createBazaarCatalog({
      baseUrl: BASE,
      fetchImpl,
      cacheMs: 1000,
      now: () => new Date(clock),
    });

    await catalog.list();
    await catalog.list();
    // One search plus one preflight, not two of each.
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    clock = 5000;
    await catalog.list();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  /** A failed read is retried, not remembered as a failure. */
  it("does not cache a failure", async () => {
    let fail = true;
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      if (fail) throw new Error("down");
      const url = String(input);
      return url.includes("/api/discovery/search") ? searchResponse([card()]) : new Response("", { status: 402 });
    }) as unknown as typeof fetch;

    const catalog = createBazaarCatalog({ baseUrl: BASE, fetchImpl, cacheMs: 60_000 });
    await expect(catalog.list()).rejects.toBeDefined();
    fail = false;
    await expect(catalog.list()).resolves.toHaveLength(1);
  });
});
