/**
 * The public quick diagnosis ("pon tu URL"): a store owner types their store's
 * address and what they sell; AgentPey reads the public catalogue, scores it
 * for AI readiness, writes three buyer questions that do not name the store,
 * asks each available AI assistant with web search on, and reports whether the
 * store shows up and who shows up instead.
 *
 * It runs on AgentPey's own API keys, so the server caps it per IP and per day
 * and reuses a recent result for the same domain. It reads public pages only,
 * through the polite fetcher (robots.txt, delays), and refuses hosts that
 * resolve to private addresses.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { buyerQuestions, judge, type Engine } from "./diagnostico.js";
import type { Fetcher } from "./http.js";
import { ingestStore } from "./ingest/index.js";
import type { Llm } from "./llm.js";
import type { Platform, Product, Store } from "./model.js";
import { readiness } from "./readiness.js";

export interface QuickAnswer {
  readonly engine: string;
  readonly mentioned: boolean;
  readonly cited: boolean;
  readonly others: readonly string[];
  /** Set when the engine failed; the answer then counts as neither yes nor no. */
  readonly error?: string;
}

export interface QuickResult {
  readonly id: string;
  readonly domain: string;
  readonly name: string;
  readonly rubro: string;
  readonly at: string;
  readonly platform: Platform;
  readonly products: number;
  readonly method: string;
  /** 0–100, or undefined when no product could be read. */
  readonly score: number | undefined;
  readonly checks: readonly { label: string; pass: number }[];
  readonly engines: readonly string[];
  readonly questions: readonly { question: string; answers: readonly QuickAnswer[] }[];
  /** Other stores' domains across every answer, most frequent first. */
  readonly instead: readonly { domain: string; count: number }[];
}

export class BadUrl extends Error {}

/** "csbyte.cl", "https://www.csbyte.cl/collections/x" → https://www.csbyte.cl */
export function normalizeUrl(raw: string): URL {
  const text = raw.trim();
  if (text === "" || text.length > 300) throw new BadUrl("Escribe la dirección de tu tienda, por ejemplo mitienda.cl");
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new BadUrl("Esa dirección no es válida");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new BadUrl("La dirección debe empezar con https://");
  if (url.username !== "" || url.password !== "" || (url.port !== "" && url.port !== "443" && url.port !== "80")) throw new BadUrl("Esa dirección no es válida");
  const host = url.hostname.toLowerCase();
  if (isIP(host.replace(/^\[|\]$/g, "")) !== 0 || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) || /(^|\.)(localhost|local|internal|onrender\.com|agentpey\.com)$/.test(host)) {
    throw new BadUrl("Esa dirección no es una tienda pública");
  }
  return new URL(`${url.protocol}//${host}`);
}

const PRIVATE = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^::1$/, /^f[cd]/i, /^fe80/i, /^::ffff:(10|127|192\.168|169\.254)\./i];

/** Refuses a host that resolves to a private or loopback address (the server must not be steered inside its own network). */
export async function assertPublicHost(host: string, resolve: (h: string) => Promise<{ address: string }[]> = (h) => lookup(h, { all: true })): Promise<void> {
  let addresses: { address: string }[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new BadUrl("No encontré ese sitio. Revisa la dirección");
  }
  if (addresses.length === 0 || addresses.some((a) => PRIVATE.some((re) => re.test(a.address)))) throw new BadUrl("Esa dirección no es una tienda pública");
}

/** The platform from the home page's markup; "propia" when nothing matches (ingest then uses the sitemap). */
export function detectPlatform(html: string): Platform {
  if (/cdn\.shopify\.com|Shopify\.theme|myshopify\.com/i.test(html)) return "shopify";
  if (/woocommerce|wp-content\/plugins\/woo/i.test(html)) return "woocommerce";
  if (/vtex(commercestable|assets|img)|vteximg\.com\.br|\.vtex\.com/i.test(html)) return "vtex";
  if (/jumpseller/i.test(html)) return "jumpseller";
  if (/prestashop/i.test(html)) return "prestashop";
  return "propia";
}

/** The store's name: og:site_name, else the <title> before its first separator, else the domain's first label. */
export function siteName(html: string, domain: string): string {
  const og = /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']{2,60})["']/i.exec(html)?.[1];
  const title = /<title[^>]*>([^<]{2,120})<\/title>/i.exec(html)?.[1]?.split(/\s[|–—-]\s/)[0];
  const decoded = (s: string | undefined) => s?.replace(/&amp;/g, "&").replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').trim();
  return decoded(og) || decoded(title) || domain.replace(/^www\./, "").split(".")[0]!;
}

export interface QuickDeps {
  readonly llm: Llm;
  readonly engines: readonly Engine[];
  readonly fetcher: Fetcher;
  readonly log?: (line: string) => void;
  readonly maxProducts?: number;
}

/**
 * Runs the whole quick diagnosis. The catalogue read can come up empty (a site
 * that blocks bots, a store without structured data): the questions then come
 * from the rubro alone and the score is left out, never invented.
 */
export async function quickDiagnosis(deps: QuickDeps, id: string, url: URL, rubro: string, questions = 3): Promise<QuickResult> {
  const log = deps.log ?? (() => {});
  const domain = url.hostname.replace(/^www\./, "");
  const home = await deps.fetcher.text(`${url.origin}/`).catch(() => ({ status: 0, body: "", url: url.origin }));
  const origin = home.status === 200 ? new URL(home.url).origin : url.origin;
  const platform = detectPlatform(home.body);
  const store: Store = { id: domain.replace(/[^a-z0-9]+/g, "-"), name: siteName(home.body, domain), origin, platform, rubro, source: "black-friday", sellsOnline: true };
  log(`${domain}: ${platform}, leyendo el catálogo`);

  let products: Product[] = [];
  let method = "no se pudo leer el catálogo";
  try {
    const max = deps.maxProducts ?? 120;
    const read = await ingestStore(store, deps.fetcher, { maxProducts: max, maxPages: Math.min(25, max) });
    products = read.products;
    method = read.method;
  } catch (error) {
    log(`${domain}: catálogo falló: ${(error as Error).message}`);
  }
  const ready = products.length > 0 ? readiness(store, products) : undefined;

  log(`${domain}: ${products.length} productos; preguntas`);
  const asked = await buyerQuestions(deps.llm, store, products, questions);
  const rows = await Promise.all(asked.map(async (question) => ({
    question,
    answers: await Promise.all(deps.engines.map(async (engine): Promise<QuickAnswer> => {
      try {
        const answer = await engine.ask(question);
        return { engine: engine.name, ...judge(store, answer) };
      } catch (error) {
        log(`${domain}: ${engine.name} falló: ${(error as Error).message}`);
        return { engine: engine.name, mentioned: false, cited: false, others: [], error: "no respondió" };
      }
    })),
  })));

  const counts = new Map<string, number>();
  for (const r of rows) for (const a of r.answers) for (const o of a.others) counts.set(o, (counts.get(o) ?? 0) + 1);
  return {
    id, domain, name: store.name, rubro, at: new Date().toISOString(), platform, products: products.length, method,
    score: ready?.score,
    checks: (ready?.checks ?? []).filter((c) => c.notVisible !== true).map((c) => ({ label: c.label, pass: c.pass })),
    engines: deps.engines.map((e) => e.name),
    questions: rows,
    instead: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([d, count]) => ({ domain: d, count })),
  };
}

const ASSISTANT_SYSTEM = "Eres un asistente de compras. El usuario está en Chile y quiere comprar online. Recomienda tiendas y productos concretos con enlaces. Busca en internet para verificar precios, stock y despacho actuales antes de responder.";

/**
 * ChatGPT's models through OpenAI's Responses API with its web search tool.
 * Needs OPENAI_API_KEY. Not the ChatGPT app itself: close, not identical.
 * Untested until AgentPey has an OpenAI API key; a failure shows as "no respondió".
 */
export function openAiEngine(apiKey: string, model = process.env.OPENAI_MODEL ?? "gpt-5-mini"): Engine {
  return {
    name: "chatgpt",
    async ask(question) {
      const res = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model, instructions: ASSISTANT_SYSTEM, input: question,
          tools: [{ type: "web_search", user_location: { type: "approximate", country: "CL" } }],
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`OpenAI respondió ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = (await res.json()) as { output?: { type?: string; content?: { type?: string; text?: string; annotations?: { type?: string; url?: string }[] }[] }[] };
      let text = "";
      const urls = new Set<string>();
      for (const item of data.output ?? []) {
        if (item.type !== "message") continue;
        for (const c of item.content ?? []) {
          if (c.type !== "output_text") continue;
          text += c.text ?? "";
          for (const a of c.annotations ?? []) if (a.type === "url_citation" && typeof a.url === "string") urls.add(a.url);
        }
      }
      for (const m of text.matchAll(/https?:\/\/[^\s)\]>"']+/g)) urls.add(m[0].replace(/[.,;]+$/, ""));
      return { engine: "chatgpt", text, urls: [...urls] };
    },
  };
}

/** Per-IP and per-day caps for the quick diagnosis, which spends AgentPey's API credit. */
export class QuickLimits {
  private readonly byIp = new Map<string, number[]>();
  private day = "";
  private today = 0;

  constructor(readonly perIpPerDay: number, readonly perDay: number) {}

  /** A reason to refuse, or undefined (and the run is counted). */
  take(ip: string, now = Date.now()): string | undefined {
    const d = new Date(now).toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.today = 0;
    }
    if (this.today >= this.perDay) return "Hoy ya se hicieron todos los diagnósticos gratis. Vuelve mañana o escríbenos a vicente@agentpey.com";
    const recent = (this.byIp.get(ip) ?? []).filter((t) => now - t < 86_400_000);
    if (recent.length >= this.perIpPerDay) return "Ya hiciste los diagnósticos gratis de hoy. Vuelve mañana";
    this.byIp.set(ip, [...recent, now]);
    this.today++;
    return undefined;
  }
}
