/**
 * A polite fetcher for public store pages: it says who it is, reads robots.txt
 * before touching a host, waits between requests to the same host, and backs
 * off on 429/503. Stores' public data only; nothing behind a login.
 */
export const USER_AGENT = "Mozilla/5.0 (compatible; AgentPeyBot/0.1; +https://agentpey.com)";

export interface PoliteFetchOptions {
  /** Minimum gap between two requests to the same host. */
  readonly delayMs?: number;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly respectRobots?: boolean;
}

export class BlockedByRobots extends Error {
  constructor(readonly url: string) {
    super(`robots.txt disallows ${url}`);
    this.name = "BlockedByRobots";
  }
}

export interface Fetcher {
  text(url: string): Promise<{ status: number; body: string; url: string }>;
  json<T = unknown>(url: string): Promise<{ status: number; body: T | undefined; url: string }>;
}

/** Disallow rules for our agent from a robots.txt: the group for AgentPeyBot if there is one, else the `*` group. */
export function parseRobots(text: string): string[] {
  const groups: { agents: string[]; disallow: string[] }[] = [];
  let current: { agents: string[]; disallow: string[] } | undefined;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "user-agent") {
      if (!lastWasAgent || current === undefined) {
        current = { agents: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (key === "disallow" && current !== undefined && value !== "") current.disallow.push(value);
    }
  }
  const ours = groups.find((g) => g.agents.some((a) => a.includes("agentpeybot")));
  const star = groups.find((g) => g.agents.includes("*"));
  return (ours ?? star)?.disallow ?? [];
}

export function allowedByRobots(rules: readonly string[], pathWithQuery: string): boolean {
  return !rules.some((rule) => {
    const anchored = rule.endsWith("$");
    const body = anchored ? rule.slice(0, -1) : rule;
    const re = new RegExp("^" + body.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : ""));
    return re.test(pathWithQuery);
  });
}

export function createFetcher(options: PoliteFetchOptions = {}): Fetcher {
  const delayMs = options.delayMs ?? 1200;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxRetries = options.maxRetries ?? 3;
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const respectRobots = options.respectRobots ?? true;
  const lastHit = new Map<string, number>();
  const robots = new Map<string, Promise<string[]>>();

  async function waitTurn(host: string): Promise<void> {
    const last = lastHit.get(host) ?? 0;
    const gap = Date.now() - last;
    if (gap < delayMs) await sleep(delayMs - gap);
    lastHit.set(host, Date.now());
  }

  async function raw(url: string, accept: string): Promise<Response> {
    const host = new URL(url).host;
    for (let attempt = 0; ; attempt++) {
      await waitTurn(host);
      const res = await doFetch(url, {
        headers: { "user-agent": USER_AGENT, accept, "accept-language": "es-CL,es;q=0.9" },
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if ((res.status === 429 || res.status === 503) && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : 2000 * 2 ** attempt);
        continue;
      }
      return res;
    }
  }

  async function rulesFor(origin: string): Promise<string[]> {
    let p = robots.get(origin);
    if (p === undefined) {
      p = raw(`${origin}/robots.txt`, "text/plain")
        .then(async (res) => (res.ok ? parseRobots(await res.text()) : []))
        .catch(() => []);
      robots.set(origin, p);
    }
    return p;
  }

  async function guarded(url: string, accept: string): Promise<Response> {
    const u = new URL(url);
    if (respectRobots && !allowedByRobots(await rulesFor(u.origin), u.pathname + u.search)) throw new BlockedByRobots(url);
    return raw(url, accept);
  }

  return {
    async text(url) {
      const res = await guarded(url, "text/html,application/xml;q=0.9,*/*;q=0.8");
      return { status: res.status, body: res.ok ? await res.text() : "", url: res.url || url };
    },
    async json<T>(url: string) {
      const res = await guarded(url, "application/json");
      if (!res.ok) return { status: res.status, body: undefined, url: res.url || url };
      const text = await res.text();
      try {
        return { status: res.status, body: JSON.parse(text) as T, url: res.url || url };
      } catch {
        return { status: res.status, body: undefined, url: res.url || url };
      }
    },
  };
}
