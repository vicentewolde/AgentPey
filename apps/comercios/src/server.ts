/**
 * Local demo server for AgentPey comercios: the store panels, the AI seller,
 * the measurement beacon and snippet, the feeds, the agent (MCP) endpoint and
 * the click redirect. Binds to 127.0.0.1 unless HOST says otherwise.
 *
 *   PORT=3100 npx tsx src/server.ts
 *
 * Data: with DATABASE_URL it reads and writes the `comercios` schema in
 * Postgres (the hosted mode, filled by scripts/setup-postgres.ts); without it,
 * the local SQLite file (DB_PATH or data/comercios.db) the CLI fills.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import { handleMcp } from "./agente.js";
import { claudeEngine, geminiEngine, type Engine } from "./diagnostico.js";
import { createFetcher } from "./http.js";
import { quickErrorPage, quickFormPage, quickResultPage, quickWaitPage } from "./panel-rapido.js";
import { assertPublicHost, BadUrl, normalizeUrl, openAiEngine, QuickLimits, quickDiagnosis, type QuickResult } from "./rapido.js";
import pg from "pg";

import { openDb } from "./db.js";
import type { Analysis } from "./entender.js";
import { llmsTxt, openAiFeed } from "./feeds.js";
import { GUIDE_ORIGIN, GUIDE_PATH, GUIDE_RUBROS, guideHtml, guidesIndexHtml, INDEXNOW_KEY, robotsTxt, sitemapXml } from "./guia.js";
import { brandHtml, brandsIndexHtml } from "./marcas.js";
import { LIMITED, MAX_BODY, PUBLIC_MCP_PATH, publicMcpHttp, siteLlmsTxt } from "./ias.js";
import { SEARCH_LIMIT, searchHtml, searchJson, searchTerms, type PriceRow } from "./precios.js";
import { createLlm } from "./llm.js";
import { AI_SOURCES, snippet, summarize, type MeasureEvent, type Source } from "./medir.js";
import { indexPage, panel, sellerPage } from "./panel.js";
import type { Policy } from "./politicas.js";
import { rankForPromotion } from "./promover.js";
import { readiness } from "./readiness.js";
import { migrate, pgStore, sqliteStore, type PanelStore } from "./store.js";
import { STORES as ALL_STORES } from "./stores.js";
import { reply, searchProducts, trackedLink, type Turn } from "./vender.js";

try {
  process.loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url)));
} catch {
  /* no .env.local */
}

const DATABASE_URL = process.env.DATABASE_URL ?? "";
async function openPostgres(url: string): Promise<PanelStore> {
  const pool = new pg.Pool({
    connectionString: url,
    // Same as SignalDesk and Vitrinee: the pooler requires TLS, and Node's default CA bundle does not carry Supabase's chain.
    ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
    max: 5,
  });
  // An idle client the server drops is emitted here; unlistened, it crashes the process.
  pool.on("error", (error) => console.error(`comercios: idle Postgres client failed: ${error.message}`));
  // The role owns its schema: new tables (the quick diagnoses) are created here, without the admin.
  await migrate(pool);
  return pgStore(pool);
}
const data: PanelStore = DATABASE_URL === ""
  ? sqliteStore(openDb(process.env.DB_PATH ?? fileURLToPath(new URL("../data/comercios.db", import.meta.url))))
  : await openPostgres(DATABASE_URL);
const CSS = readFileSync(fileURLToPath(new URL("../../web/public/brand/agentpey.css", import.meta.url)), "utf8");
/**
 * PUBLIC=1 is the hosted mode: only the stores listed in PUBLIC_STORES are
 * visible (Black Friday stores and any pilot without a written OK stay out),
 * the AI seller always uses the paid API (the subscription cannot serve the
 * public), and the seller endpoint is rate-limited per IP.
 */
const PUBLIC = process.env.PUBLIC === "1";
const STORES = PUBLIC
  ? ALL_STORES.filter((s) => (process.env.PUBLIC_STORES ?? "").split(",").map((x) => x.trim()).includes(s.id))
  : ALL_STORES;
// Render wipes local files on every deploy: hosted, the data must live in Postgres.
if (PUBLIC && DATABASE_URL === "") throw new Error("PUBLIC=1 necesita DATABASE_URL");
if (PUBLIC && (process.env.ANTHROPIC_API_KEY ?? "") === "") throw new Error("PUBLIC=1 necesita ANTHROPIC_API_KEY");
if (PUBLIC && STORES.length === 0) throw new Error("PUBLIC=1 necesita PUBLIC_STORES con al menos una tienda");
const llm = createLlm(PUBLIC ? "api" : undefined);
const PORT = Number(process.env.PORT ?? 3100);
const HOST = process.env.HOST ?? "127.0.0.1";

const SELLER_LIMIT = Number(process.env.SELLER_LIMIT_PER_HOUR ?? 30);
const hits = new Map<string, number[]>();
/** True when this IP has used up its seller questions for the last hour. */
/** The public price search: searches per IP and hour, and the last results kept (the pages change once a week). */
const SEARCHES_PER_HOUR = 300;
const searchHits = new Map<string, number[]>();
function searchLimited(ip: string, now = Date.now()): boolean {
  if (!PUBLIC) return false;
  const recent = (searchHits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (searchHits.size > 10_000) searchHits.clear();
  searchHits.set(ip, recent.length >= SEARCHES_PER_HOUR ? recent : [...recent, now]);
  return recent.length >= SEARCHES_PER_HOUR;
}
const searchCache = new Map<string, { total: number; rows: PriceRow[] }>();
async function cachedSearch(terms: readonly string[]): Promise<{ total: number; rows: PriceRow[] }> {
  const key = terms.join(" ");
  const kept = searchCache.get(key);
  if (kept !== undefined) return kept;
  const found = await data.searchPrices(terms, SEARCH_LIMIT);
  rememberSearch(key, found);
  return found;
}
function rememberSearch(key: string, found: { total: number; rows: PriceRow[] }): void {
  if (searchCache.size >= 500) searchCache.delete(searchCache.keys().next().value!);
  searchCache.set(key, found);
}

function limited(ip: string, now = Date.now()): boolean {
  if (!PUBLIC) return false;
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= SELLER_LIMIT) {
    hits.set(ip, recent);
    return true;
  }
  hits.set(ip, [...recent, now]);
  return false;
}
function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  return (typeof fwd === "string" ? fwd.split(",")[0]!.trim() : undefined) ?? req.socket.remoteAddress ?? "?";
}
/**
 * Catalogues change only when the CLI or the setup script loads them, and the
 * server is restarted after that, so they are read once at start-up. The MCP
 * handler needs them synchronously.
 */
/** The quick diagnosis asks every assistant whose key is present; Claude always. */
const engines: Engine[] = [claudeEngine(llm)];
if ((process.env.OPENAI_API_KEY ?? "") !== "") engines.push(openAiEngine(process.env.OPENAI_API_KEY!));
if ((process.env.GEMINI_API_KEY ?? "") !== "") engines.push(geminiEngine(process.env.GEMINI_API_KEY!));
const quickLimits = new QuickLimits(Number(process.env.DIAG_PER_IP_PER_DAY ?? 3), Number(process.env.DIAG_PER_DAY ?? 20));
const quickJobs = new Map<string, { estado: "corriendo" | "error"; paso: string; error?: string }>();
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i;

async function startQuick(ip: string, body: { url?: unknown; rubro?: unknown; email?: unknown }): Promise<{ status: number; body: unknown }> {
  const rubro = typeof body.rubro === "string" ? body.rubro.trim().slice(0, 120) : "";
  const email = typeof body.email === "string" && body.email.trim() !== "" ? body.email.trim() : undefined;
  if (rubro === "") return { status: 400, body: { error: "Cuéntanos qué vendes" } };
  if (email !== undefined && !EMAIL.test(email)) return { status: 400, body: { error: "Ese correo no es válido" } };
  let url: URL;
  try {
    url = normalizeUrl(typeof body.url === "string" ? body.url : "");
    await assertPublicHost(url.hostname);
  } catch (error) {
    if (error instanceof BadUrl) return { status: 400, body: { error: error.message } };
    throw error;
  }
  const domain = url.hostname.replace(/^www\./, "");
  const recent = await data.recentQuick(domain, new Date(Date.now() - 86_400_000).toISOString());
  if (recent !== undefined) return { status: 200, body: { id: recent.id } };
  const refused = quickLimits.take(ip);
  if (refused !== undefined) return { status: 429, body: { error: refused } };
  const id = randomBytes(8).toString("hex");
  const job = { estado: "corriendo" as const, paso: "Leyendo tu tienda…" };
  quickJobs.set(id, job);
  const fetcher = createFetcher({ delayMs: 300, timeoutMs: 10_000, maxRetries: 1 });
  void (async () => {
    try {
      const result: QuickResult = await quickDiagnosis({ llm, engines, fetcher, log: (l) => {
        console.error(`diagnóstico ${id}: ${l}`);
        job.paso = l.includes("preguntas") ? "Preguntándole a las IAs…" : "Leyendo tu catálogo…";
      } }, id, url, rubro);
      await data.saveQuick(result, email);
      quickJobs.delete(id);
    } catch (error) {
      console.error(`diagnóstico ${id} falló: ${(error as Error).message}`);
      quickJobs.set(id, { estado: "error", paso: "", error: "Algo falló al consultar las IAs. Intenta de nuevo en un rato." });
    }
  })();
  return { status: 202, body: { id } };
}

const productCache = new Map(await Promise.all(STORES.map(async (s) => [s.id, await data.products(s.id)] as const)));
const products = (id: string) => productCache.get(id) ?? [];

function send(res: ServerResponse, status: number, type: string, body: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...headers });
  res.end(body);
}
const json = (res: ServerResponse, status: number, body: unknown) => send(res, status, "application/json; charset=utf-8", JSON.stringify(body));

async function readBody(req: IncomingMessage, limit = 64_000): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw new Error("demasiado grande");
  }
  return raw === "" ? {} : JSON.parse(raw);
}

/** The raw body, or undefined past `limit` bytes (the rest is not read). */
async function readRaw(req: IncomingMessage, limit: number): Promise<string | undefined> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > limit) return undefined;
  }
  return raw;
}

/** A subdomain of the guides' host (panel.agentpey.com), not the host itself: those redirect to it. */
function isAgentpeySubdomain(host: string | undefined): boolean {
  const name = (host ?? "").split(":")[0]!.toLowerCase();
  const main = new URL(GUIDE_ORIGIN).hostname;
  return name.endsWith(`.${main}`);
}

function origin(req: IncomingMessage): string {
  const proto = req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
  return `${proto}://${req.headers.host ?? `${HOST}:${PORT}`}`;
}

/**
 * An AgentPey link for a product: records the click, then /ir/<id> redirects
 * to the store. Returns at once (the MCP handler is synchronous); the save goes
 * into `pending`, which the caller awaits before answering, so a link is never
 * handed out before its click exists.
 */
function link(pending: Promise<void>[], base: string, storeId: string, productId: string, url: string, channel: string): string {
  const id = randomBytes(6).toString("hex");
  pending.push(data.saveClick({ id, storeId, productId, url, channel }));
  return `${base}/ir/${id}`;
}

async function policyOf(storeId: string): Promise<Policy | undefined> {
  return (await data.policy(storeId))?.data as Policy | undefined;
}

async function storePanel(req: IncomingMessage, storeId: string): Promise<string | undefined> {
  const store = STORES.find((s) => s.id === storeId);
  if (store === undefined) return undefined;
  const ps = products(store.id);
  const [rawAnalyses, answers, pol, events] = await Promise.all([data.analyses(store.id), data.answers(store.id), data.policy(store.id), data.events(store.id)]);
  const analyses = rawAnalyses.map((a) => ({ productId: a.productId, data: a.data as Analysis }));
  const missed = answers.filter((a) => !a.mentioned).flatMap((a) => a.question.split(/\s+/));
  return panel({
    store, products: ps, readiness: readiness(store, ps), analyses,
    policy: pol === undefined ? undefined : { data: pol.data as Policy, pages: pol.pages, status: pol.status },
    answers, measure: summarize(store.id, events),
    promote: rankForPromotion({ products: ps, listingScore: new Map(analyses.map((a) => [a.productId, a.data.puntaje])), missedDemand: missed }),
    snippetUrl: `${origin(req)}/m/snippet.js?tienda=${store.id}`, mcpUrl: `${origin(req)}/mcp`,
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", origin(req));
  const path = url.pathname;
  try {
    // Public pages for crawlers: some check with HEAD first (Node sends no body for HEAD).
    const read = req.method === "GET" || req.method === "HEAD";
    const publicPage = { "cache-control": "public, max-age=3600" };
    if (read && path === "/robots.txt") return send(res, 200, "text/plain; charset=utf-8", robotsTxt(), publicPage);
    if (read && path === "/llms.txt") {
      const guides = await data.guides();
      return send(res, 200, "text/plain; charset=utf-8", siteLlmsTxt(guides.map((g) => ({ slug: g.slug, title: g.title, stores: g.stores.length })), (await data.brandSummaries()).length), publicPage);
    }
    // The public MCP server (ias.ts): read-only, no account, answers from any origin.
    if (path === PUBLIC_MCP_PATH || path === `${PUBLIC_MCP_PATH}/`) {
      const ip = clientIp(req);
      const body = req.method === "POST" ? await readRaw(req, MAX_BODY) : undefined;
      const answer = await publicMcpHttp({ search: async (terms) => (searchLimited(ip) ? LIMITED : cachedSearch(terms)) }, req.method, body);
      res.writeHead(answer.status, answer.headers);
      return res.end(answer.body);
    }
    // The guides: published at agentpey.com/chile (the gateway routes those paths here, GUIDE_ORIGIN).
    const guidePath = path === GUIDE_PATH || path.startsWith(`${GUIDE_PATH}/`);
    if (read && guidePath && isAgentpeySubdomain(req.headers.host)) {
      // Same pages on panel.agentpey.com would split them in two for search engines: one address only.
      res.writeHead(301, { location: `${GUIDE_ORIGIN}${path}`, ...publicPage });
      return void res.end();
    }
    if (read && path === `${GUIDE_PATH}/sitemap.xml`) return send(res, 200, "application/xml; charset=utf-8", sitemapXml(await data.guides(), await data.brandSummaries()), publicPage);
    if (read && path === `${GUIDE_PATH}/${INDEXNOW_KEY}.txt`) return send(res, 200, "text/plain; charset=utf-8", INDEXNOW_KEY, publicPage);
    if (read && (path === `${GUIDE_PATH}/marcas` || path === `${GUIDE_PATH}/marcas/`)) return send(res, 200, "text/html; charset=utf-8", brandsIndexHtml(await data.brandSummaries()), publicPage);
    const brandMatch = new RegExp(`^${GUIDE_PATH}/marcas/([a-z0-9-]+)/?$`).exec(path);
    if (read && brandMatch) {
      const page = await data.brandPage(brandMatch[1]!);
      if (page === undefined) return send(res, 404, "text/plain; charset=utf-8", "No tenemos esa marca");
      const guides = await data.guides();
      return send(res, 200, "text/html; charset=utf-8", brandHtml(page, GUIDE_RUBROS.filter((r) => guides.some((x) => x.slug === r.slug))), publicPage);
    }
    if (read && (path === GUIDE_PATH || path === `${GUIDE_PATH}/`)) {
      const guides = await data.guides();
      return send(res, 200, "text/html; charset=utf-8", guidesIndexHtml(guides.map((g) => ({ slug: g.slug, title: g.title, updatedAt: g.updatedAt, stores: g.stores.length })), (await data.brandSummaries()).length), publicPage);
    }
    // Before the guide slugs: "buscar" would read as one.
    if (read && (path === `${GUIDE_PATH}/buscar` || path === `${GUIDE_PATH}/buscar/`)) {
      const q = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
      const asJson = url.searchParams.get("formato") === "json";
      const terms = searchTerms(q);
      const results = { ...publicPage, "x-robots-tag": "noindex", ...(asJson ? { "access-control-allow-origin": "*" } : {}) };
      if (terms.length > 0 && searchLimited(clientIp(req))) {
        return send(res, 429, asJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8", asJson ? JSON.stringify({ error: "Demasiadas búsquedas seguidas; prueba de nuevo en un rato" }) : "Demasiadas búsquedas seguidas; prueba de nuevo en un rato", { "retry-after": "600" });
      }
      const found = terms.length === 0 ? { total: 0, rows: [] } : await cachedSearch(terms);
      const result = { query: q, terms, ...found };
      if (asJson) return send(res, 200, "application/json; charset=utf-8", JSON.stringify(searchJson(result)), results);
      return send(res, 200, "text/html; charset=utf-8", searchHtml(q === "" ? undefined : result), q === "" ? publicPage : results);
    }
    const g = new RegExp(`^${GUIDE_PATH}/([a-z0-9-]+)/?$`).exec(path);
    if (read && g) {
      const guides = await data.guides();
      const guide = guides.find((x) => x.slug === g![1]);
      if (guide === undefined) return send(res, 404, "text/plain; charset=utf-8", "No existe esa guía");
      const others = GUIDE_RUBROS.filter((r) => guides.some((x) => x.slug === r.slug));
      const brandSlugs = new Set((await data.brandSummaries()).map((b) => b.slug));
      return send(res, 200, "text/html; charset=utf-8", guideHtml(guide, others, brandSlugs), publicPage);
    }
    if (req.method === "GET" && path === "/brand/agentpey.css") return send(res, 200, "text/css; charset=utf-8", CSS);
    if (req.method === "GET" && path === "/") {
      const rows = await Promise.all(STORES.map(async (store) => {
        const answers = await data.answers(store.id);
        return { store, products: products(store.id).length, score: readiness(store, products(store.id)).score, appear: answers.length === 0 ? "—" : `${answers.filter((a) => a.mentioned).length}/${answers.length}` };
      }));
      return send(res, 200, "text/html; charset=utf-8", indexPage(rows));
    }
    if (req.method === "GET" && path === "/diagnostico") return send(res, 200, "text/html; charset=utf-8", quickFormPage(engines.map((e) => e.name)));
    if (req.method === "POST" && path === "/api/diagnostico") {
      const out = await startQuick(clientIp(req), (await readBody(req, 4_000)) as Record<string, unknown>);
      return json(res, out.status, out.body);
    }
    let m = /^\/(api\/)?diagnostico\/([a-f0-9]{16})$/.exec(path);
    if (req.method === "GET" && m) {
      const id = m[2]!;
      const job = quickJobs.get(id);
      const result = job === undefined ? await data.quick(id) : undefined;
      if (m[1] !== undefined) {
        if (job !== undefined) return json(res, 200, job);
        return result === undefined ? json(res, 404, { error: "No existe ese diagnóstico" }) : json(res, 200, { estado: "listo" });
      }
      if (job?.estado === "corriendo") return send(res, 200, "text/html; charset=utf-8", quickWaitPage(id, job.paso));
      if (job?.estado === "error") return send(res, 200, "text/html; charset=utf-8", quickErrorPage(job.error ?? "Algo falló"));
      return result === undefined ? send(res, 404, "text/plain; charset=utf-8", "No existe ese diagnóstico") : send(res, 200, "text/html; charset=utf-8", quickResultPage(result));
    }
    m = /^\/tienda\/([a-z0-9-]+)$/.exec(path);
    if (req.method === "GET" && m) {
      const html = await storePanel(req, m[1]!);
      return html === undefined ? send(res, 404, "text/plain; charset=utf-8", "No existe esa tienda") : send(res, 200, "text/html; charset=utf-8", html);
    }
    m = /^\/tienda\/([a-z0-9-]+)\/vendedor$/.exec(path);
    if (req.method === "GET" && m) {
      const store = STORES.find((s) => s.id === m![1]);
      return store === undefined ? send(res, 404, "text/plain; charset=utf-8", "No existe esa tienda") : send(res, 200, "text/html; charset=utf-8", sellerPage(store));
    }
    m = /^\/api\/vender\/([a-z0-9-]+)$/.exec(path);
    if (req.method === "POST" && m) {
      const store = STORES.find((s) => s.id === m![1]);
      if (store === undefined) return json(res, 404, { error: "No existe esa tienda" });
      if (limited(clientIp(req))) return json(res, 429, { error: "Demasiadas preguntas seguidas; prueba de nuevo en un rato" });
      const body = (await readBody(req)) as { pregunta?: unknown; historial?: unknown };
      const pregunta = typeof body.pregunta === "string" ? body.pregunta.trim().slice(0, 500) : "";
      if (pregunta === "") return json(res, 400, { error: "Falta la pregunta" });
      const history = (Array.isArray(body.historial) ? body.historial : [])
        .filter((t): t is Turn => typeof t === "object" && t !== null && ((t as Turn).role === "cliente" || (t as Turn).role === "vendedor") && typeof (t as Turn).text === "string")
        .slice(-6);
      const context = [...history.filter((t) => t.role === "cliente").map((t) => t.text), pregunta].join(" ");
      const candidates = searchProducts(products(store.id), context, 10);
      const out = await reply(llm, store, await policyOf(store.id), candidates, history, pregunta);
      if (out === undefined) return json(res, 502, { error: "El vendedor no pudo responder" });
      const byId = new Map(candidates.map((p) => [p.id, p]));
      const pending: Promise<void>[] = [];
      const productos = out.recomendados.map((r) => {
        const p = byId.get(r.id)!;
        return { titulo: p.title, precio: p.price === undefined ? "precio no publicado" : `$${p.price.toLocaleString("es-CL")}`, por_que: r.por_que, enlace: link(pending, origin(req), store.id, p.id, p.url, "vendedor") };
      });
      await Promise.all(pending);
      return json(res, 200, { respuesta: out.respuesta, no_se: out.no_se, productos });
    }
    m = /^\/ir\/([a-f0-9]{12})$/.exec(path);
    if (req.method === "GET" && m) {
      const click = await data.click(m[1]!);
      if (click === undefined) return send(res, 404, "text/plain; charset=utf-8", "Enlace desconocido");
      await data.saveEvent({ storeId: click.storeId, kind: "visita", source: "agentpey", at: new Date().toISOString(), productIds: [click.productId] });
      res.writeHead(302, { location: trackedLink(click.url, m[1]!) });
      return res.end();
    }
    if (req.method === "POST" && path === "/mcp") {
      const body = await readBody(req);
      const policies = new Map(await Promise.all(STORES.map(async (s) => [s.id, await policyOf(s.id)] as const)));
      const pending: Promise<void>[] = [];
      const deps = {
        stores: STORES, products,
        policySummary: (id: string) => {
          const p = policies.get(id);
          return p === undefined ? undefined : `Despacho: ${p.despacho.cobertura}. Costo: ${p.despacho.costo}. Cambios: ${p.cambios_y_devoluciones.acepta}${p.cambios_y_devoluciones.plazo_dias ? ` (${p.cambios_y_devoluciones.plazo_dias} días)` : ""}. Garantía: ${p.garantia}. Pago: ${p.medios_de_pago.join(", ")}. ${p.cuotas}`;
        },
        link: (storeId: string, productId: string, u: string) => link(pending, origin(req), storeId, productId, u, "mcp"),
      };
      const msgs = Array.isArray(body) ? body : [body];
      const answers = msgs.map((msg) => handleMcp(deps, msg as Record<string, unknown>)).filter((a) => a !== undefined);
      await Promise.all(pending);
      if (answers.length === 0) {
        res.writeHead(202);
        return res.end();
      }
      return json(res, 200, Array.isArray(body) ? answers : answers[0]);
    }
    if (req.method === "GET" && path === "/m/snippet.js") {
      const tienda = url.searchParams.get("tienda") ?? "";
      if (!STORES.some((s) => s.id === tienda)) return send(res, 404, "text/plain; charset=utf-8", "tienda desconocida");
      return send(res, 200, "application/javascript; charset=utf-8", snippet(tienda, `${origin(req)}/m`), { "access-control-allow-origin": "*" });
    }
    if (req.method === "POST" && path === "/m") {
      const b = (await readBody(req, 8_000)) as Record<string, unknown>;
      const store = STORES.find((s) => s.id === b.tienda);
      const source = String(b.fuente ?? "") as Source;
      if (store === undefined || !(source === "sin_ia" || (AI_SOURCES as readonly string[]).includes(source)) || (b.tipo !== "visita" && b.tipo !== "compra")) {
        res.writeHead(400, { "access-control-allow-origin": "*" });
        return res.end();
      }
      const event: MeasureEvent = {
        storeId: store.id, kind: b.tipo, source, at: new Date().toISOString(),
        ...(b.tipo === "compra" ? { total: Math.max(0, Math.round(Number(b.total) || 0)), orderId: String(b.pedido ?? "").slice(0, 64) } : {}),
        productIds: Array.isArray(b.productos) ? b.productos.slice(0, 50).map((x) => String(x).slice(0, 64)) : [],
      };
      await data.saveEvent(event);
      res.writeHead(204, { "access-control-allow-origin": "*" });
      return res.end();
    }
    m = /^\/feeds\/([a-z0-9-]+)\.jsonl$/.exec(path);
    if (req.method === "GET" && m) {
      const store = STORES.find((s) => s.id === m![1]);
      if (store === undefined) return send(res, 404, "text/plain; charset=utf-8", "No existe esa tienda");
      return send(res, 200, "application/x-ndjson; charset=utf-8", openAiFeed(store, products(store.id)).jsonl);
    }
    m = /^\/feeds\/([a-z0-9-]+)\/llms\.txt$/.exec(path);
    if (req.method === "GET" && m) {
      const store = STORES.find((s) => s.id === m![1]);
      if (store === undefined) return send(res, 404, "text/plain; charset=utf-8", "No existe esa tienda");
      return send(res, 200, "text/plain; charset=utf-8", llmsTxt(store, products(store.id), `${origin(req)}/feeds/${store.id}.jsonl`));
    }
    return send(res, 404, "text/plain; charset=utf-8", "No encontrado");
  } catch (error) {
    console.error(`${req.method} ${path}:`, (error as Error).message);
    if (!res.headersSent) json(res, 500, { error: "Error interno" });
  }
});

server.listen(PORT, HOST, () => console.log(`AgentPey comercios en http://${HOST}:${PORT} (IA: ${llm.name})`));
