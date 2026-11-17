/**
 * Problem 6, "vender por agentes" — a PROTOTYPE: a Model Context Protocol
 * endpoint where a shopping agent searches the pilot stores' catalogues and gets
 * a link that goes through AgentPey (/ir/<click>) to the product page, so the
 * visit and a later purchase are credited to the agent channel. No payments.
 *
 * Only "piloto" stores are listed: they said yes. JSON-RPC over HTTP POST,
 * answering with plain JSON (the streamable HTTP transport's JSON mode).
 */
import type { Product, Store } from "./model.js";
import { scoreProducts } from "./vender.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface AgentDeps {
  readonly stores: readonly Store[];
  readonly products: (storeId: string) => readonly Product[];
  readonly policySummary: (storeId: string) => string | undefined;
  /** Records a click and returns the AgentPey link that will redirect to `url`. */
  readonly link: (storeId: string, productId: string, url: string) => string;
}

type JsonRpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

const TOOLS = [
  {
    name: "buscar_productos",
    description: "Busca productos en tiendas online chilenas (precios en CLP, IVA incluido). Devuelve título, precio, tienda, disponibilidad y un enlace de compra.",
    inputSchema: {
      type: "object",
      properties: {
        consulta: { type: "string", description: "Qué busca el comprador, en sus palabras. Puede incluir presupuesto, por ejemplo 'hasta 50 mil'." },
        tienda: { type: "string", description: "Opcional: id de una tienda." },
      },
      required: ["consulta"],
    },
  },
  {
    name: "politicas_tienda",
    description: "Despacho, cambios, garantía y medios de pago de una tienda, aprobados por su dueño.",
    inputSchema: { type: "object", properties: { tienda: { type: "string" } }, required: ["tienda"] },
  },
];

function ok(id: JsonRpc["id"], result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function fail(id: JsonRpc["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}
const text = (s: string, isError = false) => ({ content: [{ type: "text", text: s }], isError });

/** One JSON-RPC message in, one answer out (undefined for notifications). */
export function handleMcp(deps: AgentDeps, msg: JsonRpc): unknown {
  const pilots = deps.stores.filter((s) => s.source === "piloto");
  switch (msg.method) {
    case "initialize":
      return ok(msg.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "agentpey-comercios", version: "0.1.0" },
        instructions: "Catálogo de tiendas chilenas del piloto AgentPey. Usa buscar_productos y entrega al comprador el enlace tal cual.",
      });
    case "notifications/initialized":
      return undefined;
    case "ping":
      return ok(msg.id, {});
    case "tools/list":
      return ok(msg.id, { tools: TOOLS });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      if (name === "buscar_productos") {
        const consulta = String(args.consulta ?? "").trim();
        if (consulta === "") return ok(msg.id, text("Falta 'consulta'.", true));
        const tienda = typeof args.tienda === "string" ? args.tienda : undefined;
        const stores = tienda === undefined ? pilots.filter((s) => s.sellsOnline) : pilots.filter((s) => s.id === tienda);
        if (stores.length === 0) return ok(msg.id, text(`No hay una tienda "${tienda}" en el piloto. Tiendas: ${pilots.map((s) => s.id).join(", ")}`, true));
        // Ranked across stores, not store by store, so the best matches come first wherever they are.
        const found = stores
          .flatMap((s) => scoreProducts(deps.products(s.id), consulta).slice(0, 5).map((x) => ({ s, p: x.p, score: x.score })))
          .sort((a, b) => b.score - a.score)
          .filter((x, _i, all) => x.score >= all[0]!.score * 0.5);
        if (found.length === 0) return ok(msg.id, text("No encontré productos para esa búsqueda."));
        const lines = found.slice(0, 8).map(({ s, p }) =>
          `- ${p.title} · ${p.price === undefined ? "precio no publicado" : `$${p.price.toLocaleString("es-CL")}`} · ${s.name} · ${p.available === false ? "sin stock" : "disponible"}\n  ${deps.link(s.id, p.id, p.url)}`,
        );
        return ok(msg.id, text(lines.join("\n")));
      }
      if (name === "politicas_tienda") {
        const tienda = String(args.tienda ?? "");
        const store = pilots.find((s) => s.id === tienda);
        if (store === undefined) return ok(msg.id, text(`No hay una tienda "${tienda}" en el piloto.`, true));
        return ok(msg.id, text(deps.policySummary(store.id) ?? "Esta tienda aún no tiene políticas aprobadas."));
      }
      return fail(msg.id, -32602, `herramienta desconocida: ${name}`);
    }
    default:
      return msg.id === undefined ? undefined : fail(msg.id, -32601, `método no soportado: ${msg.method ?? ""}`);
  }
}
