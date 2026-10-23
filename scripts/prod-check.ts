#!/usr/bin/env node
/**
 * Asks production whether it is up, and prints one line per surface (T172).
 *
 * Strictly read-only and without secrets: plain GETs, plus the MCP's unauthenticated answer. Run it before opening a
 * pull request and again right after anything reaches `main` (every push there deploys to Render), so that what a
 * visitor, a judge or a connected agent would see never breaks unnoticed. Exits 1 if any surface is wrong.
 *
 * Run with `pnpm run prod:check`. To point it somewhere else, `pnpm run prod:check -- https://staging.example`.
 */
const root = new URL(process.argv.slice(2).find((arg) => arg !== "--") ?? "https://agentpey.com");
const hostOf = (sub: string) => (sub === "" ? root.host : `${sub}.${root.host}`);
const TIMEOUT_MS = 25_000;

interface Probe {
  name: string;
  url: string;
  /** The status the surface is meant to answer with. */
  status: number;
  /** Extra proof that it is the right thing and not just any page. */
  check?: (body: string) => string | undefined;
}

const json = (body: string): unknown => {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
};

const STORES = ["agentcommerce", "bazar-cordillera", "mycokit"];

const probes: Probe[] = [
  { name: "web", url: `https://${hostOf("")}/`, status: 200 },
  { name: "stores page", url: `https://${hostOf("")}/tiendas`, status: 200 },
  { name: "live page", url: `https://${hostOf("")}/en-vivo`, status: 200 },
  {
    name: "live data",
    url: `https://${hostOf("")}/api/live`,
    status: 200,
    check: (body) => {
      const data = json(body) as { ok?: boolean; totals?: { purchases?: number } } | undefined;
      return data?.ok === true && typeof data.totals?.purchases === "number" ? undefined : "not the live data";
    },
  },
  { name: "realops", url: `https://${hostOf("realops")}/`, status: 200 },
  { name: "signaldesk", url: `https://${hostOf("signaldesk")}/`, status: 200 },
  ...STORES.map((slug) => ({
    name: `store ${slug}`,
    url: `https://${slug}.${hostOf("vitrinee")}/.well-known/ucp`,
    status: 200,
    check: (body: string) => {
      const profile = json(body) as { ucp?: { version?: string; services?: unknown } } | undefined;
      return typeof profile?.ucp?.version === "string" && profile.ucp.services !== undefined ? undefined : "not a UCP profile";
    },
  })),
  {
    name: "mcp auth metadata",
    url: `https://${hostOf("mcp")}/.well-known/oauth-authorization-server`,
    status: 200,
  },
  // Without a token the MCP must refuse, not answer: a 200 here would mean it is open.
  { name: "mcp refuses without a token", url: `https://${hostOf("mcp")}/mcp`, status: 401 },
];

async function run(probe: Probe): Promise<{ probe: Probe; ok: boolean; note: string; ms: number }> {
  const started = Date.now();
  try {
    const res = await fetch(probe.url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "manual" });
    const ms = Date.now() - started;
    if (res.status !== probe.status) return { probe, ok: false, note: `answered ${res.status}, expected ${probe.status}`, ms };
    const problem = probe.check?.(await res.text());
    return problem === undefined ? { probe, ok: true, note: String(res.status), ms } : { probe, ok: false, note: problem, ms };
  } catch (error) {
    return { probe, ok: false, note: error instanceof Error ? error.message : String(error), ms: Date.now() - started };
  }
}

const results = await Promise.all(probes.map(run));
for (const r of results) process.stdout.write(`${r.ok ? "✓" : "✗"} ${r.probe.name.padEnd(30)} ${r.note.padEnd(10)} ${String(r.ms).padStart(5)} ms\n`);
const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} surfaces right${failed.length === 0 ? "" : `; wrong: ${failed.map((r) => r.probe.name).join(", ")}`}\n`);
process.exit(failed.length === 0 ? 0 : 1);
