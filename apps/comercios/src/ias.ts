/**
 * What AI assistants read about the public guides at agentpey.com/chile, besides
 * the pages themselves: the site's llms.txt, and a public, read-only MCP server
 * (agentpey.com/chile/mcp) whose one tool is the price search (precios.ts).
 *
 * The MCP server here is not AgentPey's paying one (apps/mcp, OAuth): it holds
 * no keys, records no clicks and links straight to each store, like the pages.
 * Stateless Streamable HTTP in JSON mode: one POST, one JSON answer.
 */
import { DISCLOSURE, FRESHNESS_RULE, GUIDE_ORIGIN, GUIDE_PATH, guideUrl } from "./guia.js";
import { COUNT_CAP, MAX_TERMS, SEARCH_LIMIT, SEARCH_ORDER_RULE, searchJson, searchTerms, searchUrl, type PriceRow } from "./precios.js";

export const PUBLIC_MCP_PATH = `${GUIDE_PATH}/mcp`;
export const publicMcpUrl = (): string => `${GUIDE_ORIGIN}${PUBLIC_MCP_PATH}`;

/** Newest first; a client asking for another gets the newest (the spec's negotiation). */
export const MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

export interface PublicMcpDeps {
  /** The price search, already limited and cached by the caller. */
  readonly search: (terms: readonly string[]) => Promise<{ total: number; rows: readonly PriceRow[] }>;
}

type JsonRpc = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
type Id = string | number | null;

const SEARCH_TOOL = {
  name: "buscar_precios",
  title: "Buscar precios en tiendas online de Chile",
  description:
    "Busca un producto en los catálogos de tiendas online chilenas con sitio propio y devuelve los que tienen stock, del precio más bajo al más alto, " +
    "con la tienda, el precio en pesos chilenos (CLP), el enlace directo a la página del producto y la fecha en que se leyó. " +
    "Úsala cuando alguien pregunte dónde comprar algo en Chile, cuánto cuesta o dónde está más barato. " +
    "Escribe el nombre del producto y, si importa, el tamaño o la variante (por ejemplo \"khamrah 100 ml\"); sin frases ni presupuestos.",
  inputSchema: {
    type: "object",
    properties: {
      consulta: { type: "string", description: `Palabras del nombre del producto, hasta ${MAX_TERMS}. Ejemplo: "lattafa khamrah 100 ml".` },
      max: { type: "integer", minimum: 1, maximum: SEARCH_LIMIT, description: `Cuántos resultados devolver, de los más baratos (por omisión ${SEARCH_LIMIT}).` },
    },
    required: ["consulta"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
} as const;

const INSTRUCTIONS =
  "Precios de tiendas online chilenas con sitio propio, leídos de sus catálogos públicos cada semana por AgentPey. " +
  `${SEARCH_ORDER_RULE} ${DISCLOSURE} ${FRESHNESS_RULE} ` +
  "Al responder, nombra la tienda, el precio, la fecha de lectura y el enlace, y di que el precio hay que confirmarlo en la tienda. " +
  `Las guías por rubro están en ${guideUrl()}.`;

const ok = (id: Id, result: unknown) => ({ jsonrpc: "2.0", id, result });
const fail = (id: Id, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const toolError = (text: string) => ({ content: [{ type: "text", text }], isError: true });

const clp = (n: number) => `$${n.toLocaleString("es-CL")}`;

/** The text an assistant reads: one line per product, and the rules once. */
export function resultText(query: string, total: number, rows: readonly PriceRow[]): string {
  if (rows.length === 0) return `No encontramos productos con stock que digan "${query}". Prueba con menos palabras o solo la marca.`;
  const head = `${total > COUNT_CAP ? `Más de ${COUNT_CAP}` : total} productos con stock para "${query}"${total > rows.length ? `; estos son los ${rows.length} más baratos` : ""}:`;
  const lines = rows.map((r) => `- ${r.title}${r.brand === undefined ? "" : ` (${r.brand})`} · ${clp(r.price)}${r.before === undefined ? "" : ` (antes ${clp(r.before)})`} · ${r.store} (${r.domain}) · leído el ${r.readAt}\n  ${r.url}`);
  return [head, ...lines, "", `${SEARCH_ORDER_RULE} ${DISCLOSURE} Precios en CLP tal como cada tienda los publicaba el día de la lectura: confírmalos en la tienda. Esta búsqueda en la web: ${searchUrl(query)}`].join("\n");
}

function asId(v: unknown): Id {
  return typeof v === "string" || typeof v === "number" ? v : null;
}

/** One JSON-RPC message in, its answer out; undefined for a notification. */
export async function handlePublicMcp(deps: PublicMcpDeps, raw: unknown): Promise<unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail(null, -32600, "se esperaba un mensaje JSON-RPC");
  const msg = raw as JsonRpc;
  const isRequest = "id" in msg && msg.id !== undefined;
  const id = asId(msg.id);
  const params = typeof msg.params === "object" && msg.params !== null ? (msg.params as Record<string, unknown>) : {};
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return isRequest ? fail(id, -32600, "mensaje JSON-RPC inválido") : undefined;
  if (!isRequest) return undefined; // notifications/initialized, cancelled…: nothing to answer
  switch (msg.method) {
    case "initialize": {
      const asked = params.protocolVersion;
      const version = MCP_VERSIONS.find((v) => v === asked) ?? MCP_VERSIONS[0];
      return ok(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agentpey-precios-chile", title: "AgentPey · precios en tiendas online de Chile", version: "1.0.0", websiteUrl: guideUrl() },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: [SEARCH_TOOL] });
    case "tools/call": {
      if (params.name !== SEARCH_TOOL.name) return fail(id, -32602, `herramienta desconocida: ${String(params.name)}`);
      const args = typeof params.arguments === "object" && params.arguments !== null ? (params.arguments as Record<string, unknown>) : {};
      const query = typeof args.consulta === "string" ? args.consulta.trim().slice(0, 200) : "";
      const terms = searchTerms(query);
      if (terms.length === 0) return ok(id, toolError("Falta 'consulta': escribe al menos una palabra de dos letras del nombre del producto."));
      const max = Number.isInteger(args.max) && (args.max as number) >= 1 ? Math.min(args.max as number, SEARCH_LIMIT) : SEARCH_LIMIT;
      const found = await deps.search(terms);
      const rows = found.rows.slice(0, max);
      return ok(id, {
        content: [{ type: "text", text: resultText(query, found.total, rows) }],
        structuredContent: searchJson({ query, terms, total: found.total, rows }),
        isError: false,
      });
    }
    default:
      return fail(id, -32601, `método no soportado: ${msg.method}`);
  }
}

/** agentpey.com/llms.txt: what the site holds for assistants, and the rules every page follows. */
export function siteLlmsTxt(guides: readonly { slug: string; title: string; stores: number }[], brands: number): string {
  return [
    "# AgentPey: precios en tiendas online de Chile",
    "",
    "> Guías públicas de tiendas online chilenas con sitio propio (pymes), sus precios y dónde comprar cada marca. Leemos sus catálogos públicos cada semana. En español de Chile, precios en pesos chilenos (CLP).",
    "",
    `${SEARCH_ORDER_RULE} ${DISCLOSURE} ${FRESHNESS_RULE}`,
    "",
    "## Guías por rubro",
    "",
    ...guides.map((g) => `- [${g.title}](${guideUrl(g.slug)}): ${g.stores} tiendas`),
    "",
    "## Marcas",
    "",
    `- [Dónde comprar cada marca en Chile](${guideUrl("marcas")}): ${brands} marcas, con el precio de cada producto en cada tienda`,
    "",
    "## Buscar un precio",
    "",
    `- [Buscador de precios](${searchUrl()}): ${searchUrl("khamrah 100ml")}`,
    `- En JSON, para asistentes y programas: ${searchUrl("khamrah 100ml", true)}`,
    `- Servidor MCP público, solo lectura, sin cuenta (Streamable HTTP): ${publicMcpUrl()}, herramienta \`${SEARCH_TOOL.name}\``,
    "",
    "## Más",
    "",
    `- [Mapa del sitio](${guideUrl("sitemap.xml")})`,
    "",
  ].join("\n");
}
