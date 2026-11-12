/**
 * Local demo server for AgentPey comercios: the store panels, the AI seller,
 * the measurement beacon and snippet, the feeds, the agent (MCP) endpoint and
 * the click redirect. Binds to 127.0.0.1 unless HOST says otherwise.
 *
 *   PORT=3100 npx tsx src/server.ts
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import { handleMcp } from "./agente.js";
import { openDb } from "./db.js";
import type { Analysis } from "./entender.js";
import { llmsTxt, openAiFeed } from "./feeds.js";
import { createLlm } from "./llm.js";
import { AI_SOURCES, snippet, summarize, type MeasureEvent, type Source } from "./medir.js";
import { indexPage, panel, sellerPage } from "./panel.js";
import type { Policy } from "./politicas.js";
import { rankForPromotion } from "./promover.js";
import { readiness } from "./readiness.js";
import { STORES } from "./stores.js";
import { reply, searchProducts, trackedLink, type Turn } from "./vender.js";

try {
  process.loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url)));
} catch {
  /* no .env.local */
}

const db = openDb(fileURLToPath(new URL("../data/comercios.db", import.meta.url)));
const CSS = readFileSync(fileURLToPath(new URL("../../web/public/brand/agentpey.css", import.meta.url)), "utf8");
const llm = createLlm();
const PORT = Number(process.env.PORT ?? 3100);
const HOST = process.env.HOST ?? "127.0.0.1";
const productCache = new Map<string, ReturnType<typeof db.products>>();
const products = (id: string) => {
  let p = productCache.get(id);
  if (p === undefined) productCache.set(id, (p = db.products(id)));
  return p;
};

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

function origin(req: IncomingMessage): string {
  return `http://${req.headers.host ?? `${HOST}:${PORT}`}`;
}

/** An AgentPey link for a product: records the click, then /ir/<id> redirects to the store. */
function link(base: string, storeId: string, productId: string, url: string, channel: string): string {
  const id = randomBytes(6).toString("hex");
  db.saveClick({ id, storeId, productId, url, channel });
  return `${base}/ir/${id}`;
}

function policyOf(storeId: string): Policy | undefined {
  return db.policy(storeId)?.data as Policy | undefined;
}

function storePanel(req: IncomingMessage, storeId: string): string | undefined {
  const store = STORES.find((s) => s.id === storeId);
  if (store === undefined) return undefined;
  const ps = products(store.id);
  const analyses = db.analyses(store.id).map((a) => ({ productId: a.productId, data: a.data as Analysis }));
  const answers = db.answers(store.id);
  const missed = answers.filter((a) => !a.mentioned).flatMap((a) => a.question.split(/\s+/));
  const pol = db.policy(store.id);
  return panel({
    store, products: ps, readiness: readiness(store, ps), analyses,
    policy: pol === undefined ? undefined : { data: pol.data as Policy, pages: pol.pages, status: pol.status },
    answers, measure: summarize(store.id, db.events(store.id)),
    promote: rankForPromotion({ products: ps, listingScore: new Map(analyses.map((a) => [a.productId, a.data.puntaje])), missedDemand: missed }),
    snippetUrl: `${origin(req)}/m/snippet.js?tienda=${store.id}`, mcpUrl: `${origin(req)}/mcp`,
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", origin(req));
  const path = url.pathname;
  try {
    if (req.method === "GET" && path === "/brand/agentpey.css") return send(res, 200, "text/css; charset=utf-8", CSS);
    if (req.method === "GET" && path === "/") {
      return send(res, 200, "text/html; charset=utf-8", indexPage(STORES.map((store) => {
        const answers = db.answers(store.id);
        return { store, products: products(store.id).length, score: readiness(store, products(store.id)).score, appear: answers.length === 0 ? "—" : `${answers.filter((a) => a.mentioned).length}/${answers.length}` };
      })));
    }
    let m = /^\/tienda\/([a-z0-9-]+)$/.exec(path);
    if (req.method === "GET" && m) {
      const html = storePanel(req, m[1]!);
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
      const body = (await readBody(req)) as { pregunta?: unknown; historial?: unknown };
      const pregunta = typeof body.pregunta === "string" ? body.pregunta.trim().slice(0, 500) : "";
      if (pregunta === "") return json(res, 400, { error: "Falta la pregunta" });
      const history = (Array.isArray(body.historial) ? body.historial : [])
        .filter((t): t is Turn => typeof t === "object" && t !== null && ((t as Turn).role === "cliente" || (t as Turn).role === "vendedor") && typeof (t as Turn).text === "string")
        .slice(-6);
      const context = [...history.filter((t) => t.role === "cliente").map((t) => t.text), pregunta].join(" ");
      const candidates = searchProducts(products(store.id), context, 10);
      const out = await reply(llm, store, policyOf(store.id), candidates, history, pregunta);
      if (out === undefined) return json(res, 502, { error: "El vendedor no pudo responder" });
      const byId = new Map(candidates.map((p) => [p.id, p]));
      return json(res, 200, {
        respuesta: out.respuesta,
        no_se: out.no_se,
        productos: out.recomendados.map((r) => {
          const p = byId.get(r.id)!;
          return { titulo: p.title, precio: p.price === undefined ? "precio no publicado" : `$${p.price.toLocaleString("es-CL")}`, por_que: r.por_que, enlace: link(origin(req), store.id, p.id, p.url, "vendedor") };
        }),
      });
    }
    m = /^\/ir\/([a-f0-9]{12})$/.exec(path);
    if (req.method === "GET" && m) {
      const click = db.click(m[1]!);
      if (click === undefined) return send(res, 404, "text/plain; charset=utf-8", "Enlace desconocido");
      db.saveEvent({ storeId: click.storeId, kind: "visita", source: "agentpey", at: new Date().toISOString(), productIds: [click.productId] });
      res.writeHead(302, { location: trackedLink(click.url, m[1]!) });
      return res.end();
    }
    if (req.method === "POST" && path === "/mcp") {
      const body = await readBody(req);
      const deps = {
        stores: STORES, products,
        policySummary: (id: string) => {
          const p = policyOf(id);
          return p === undefined ? undefined : `Despacho: ${p.despacho.cobertura}. Costo: ${p.despacho.costo}. Cambios: ${p.cambios_y_devoluciones.acepta}${p.cambios_y_devoluciones.plazo_dias ? ` (${p.cambios_y_devoluciones.plazo_dias} días)` : ""}. Garantía: ${p.garantia}. Pago: ${p.medios_de_pago.join(", ")}. ${p.cuotas}`;
        },
        link: (storeId: string, productId: string, u: string) => link(origin(req), storeId, productId, u, "mcp"),
      };
      const msgs = Array.isArray(body) ? body : [body];
      const answers = msgs.map((msg) => handleMcp(deps, msg as Record<string, unknown>)).filter((a) => a !== undefined);
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
      db.saveEvent(event);
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
