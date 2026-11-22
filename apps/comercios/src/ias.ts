/**
 * What AI assistants read about the public guides at agentpey.com/chile, besides
 * the pages themselves: the site's llms.txt, and a public, read-only MCP server
 * (agentpey.com/chile/mcp) whose one tool is the price search (precios.ts).
 *
 * The MCP server here is not AgentPey's paying one (apps/mcp, OAuth): it holds
 * no keys, records no clicks and links straight to each store, like the pages.
 * Stateless Streamable HTTP in JSON mode: one POST, one JSON answer.
 */
import { z } from "zod";

import { DISCLOSURE, FRESHNESS_RULE, GUIDE_ORIGIN, GUIDE_PATH, guideUrl } from "./guia.js";
import { COUNT_CAP, MAX_TERMS, SEARCH_LIMIT, SEARCH_ORDER_RULE, searchJson, searchTerms, searchUrl, type PriceRow } from "./precios.js";

export const PUBLIC_MCP_PATH = `${GUIDE_PATH}/mcp`;
export const publicMcpUrl = (): string => `${GUIDE_ORIGIN}${PUBLIC_MCP_PATH}`;

/** Newest first; a client asking for another gets the newest (the spec's negotiation). */
export const MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

/** The search's own limit (per IP and hour) said no: answered as a tool error the assistant can relay. */
export const LIMITED = "limitado" as const;

export interface PublicMcpDeps {
  /** The price search, cached by the caller; LIMITED when this client is over the limit. */
  readonly search: (terms: readonly string[]) => Promise<{ total: number; rows: readonly PriceRow[] } | typeof LIMITED>;
}

type Id = string | number;

/** A JSON-RPC 2.0 request or notification; MCP ids are strings or numbers, never null. */
const MessageSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});
/** A response the client sends back (to a server request): this server sends none, so there is nothing to do with it. */
const ResponseSchema = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number(), z.null()]) }).and(z.union([z.object({ result: z.unknown() }), z.object({ error: z.unknown() })]));
const CallSchema = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() });
const SearchArgsSchema = z.object({ consulta: z.string(), max: z.number().int().min(1).optional() });

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
const fail = (id: Id | null, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const toolError = (text: string) => ({ content: [{ type: "text", text }], isError: true });

const clp = (n: number) => `$${n.toLocaleString("es-CL")}`;

/** The text an assistant reads: one line per product, and the rules once. */
export function resultText(query: string, total: number, rows: readonly PriceRow[]): string {
  if (rows.length === 0) return `No encontramos productos con stock que digan "${query}". Prueba con menos palabras o solo la marca.`;
  const head = `${total > COUNT_CAP ? `Más de ${COUNT_CAP}` : total} productos con stock para "${query}"${total > rows.length ? `; estos son los ${rows.length} más baratos` : ""}:`;
  const lines = rows.map((r) => `- ${r.title}${r.brand === undefined ? "" : ` (${r.brand})`} · ${clp(r.price)}${r.before === undefined ? "" : ` (antes ${clp(r.before)})`} · ${r.store} (${r.domain}) · leído el ${r.readAt}\n  ${r.url}`);
  return [head, ...lines, "", `${SEARCH_ORDER_RULE} ${DISCLOSURE} Precios en CLP tal como cada tienda los publicaba el día de la lectura: confírmalos en la tienda. Esta búsqueda en la web: ${searchUrl(query)}`].join("\n");
}

/** One JSON-RPC message in, its answer out; undefined for a notification or a client response. */
export async function handlePublicMcp(deps: PublicMcpDeps, raw: unknown): Promise<unknown> {
  const parsed = MessageSchema.safeParse(raw);
  if (!parsed.success) {
    if (ResponseSchema.safeParse(raw).success) return undefined;
    const id = typeof raw === "object" && raw !== null && "id" in raw && (typeof raw.id === "string" || typeof raw.id === "number") ? raw.id : null;
    return fail(id, -32600, "mensaje JSON-RPC inválido");
  }
  const msg = parsed.data;
  if (msg.id === undefined) return undefined; // notifications/initialized, cancelled…: nothing to answer
  const id = msg.id;
  const params = msg.params ?? {};
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
      const call = CallSchema.safeParse(params);
      if (!call.success) return fail(id, -32602, "falta el nombre de la herramienta");
      if (call.data.name !== SEARCH_TOOL.name) return fail(id, -32602, `herramienta desconocida: ${call.data.name}`);
      const args = SearchArgsSchema.safeParse(call.data.arguments ?? {});
      const query = args.success ? args.data.consulta.trim().slice(0, 200) : "";
      const terms = searchTerms(query);
      if (!args.success || terms.length === 0) return ok(id, toolError("Falta 'consulta': escribe al menos una palabra de dos letras del nombre del producto."));
      const max = Math.min(args.data.max ?? SEARCH_LIMIT, SEARCH_LIMIT);
      let found: Awaited<ReturnType<PublicMcpDeps["search"]>>;
      try {
        found = await deps.search(terms);
      } catch {
        return ok(id, toolError("No pudimos buscar en este momento; prueba de nuevo en un rato."));
      }
      if (found === LIMITED) return ok(id, toolError("Demasiadas búsquedas seguidas desde esta conexión; prueba de nuevo en un rato."));
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

/** Messages one POST may carry (batches are pre-2025-06-18 MCP; kept for older clients). */
export const MAX_BATCH = 10;
/** Bytes of one POST. */
export const MAX_BODY = 16_000;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, accept, mcp-protocol-version, mcp-session-id",
  "access-control-expose-headers": "mcp-session-id",
};

export interface HttpAnswer { readonly status: number; readonly headers: Record<string, string>; readonly body?: string }
const jsonAnswer = (status: number, body: unknown): HttpAnswer => ({ status, headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: JSON.stringify(body) });

/**
 * The HTTP face of the public MCP server: method and raw body in (undefined
 * when it was over MAX_BODY), the answer out. No Origin check, on purpose: no
 * account, no state and public data, so a page in a browser gains nothing a
 * plain request would not.
 */
export async function publicMcpHttp(deps: PublicMcpDeps, method: string | undefined, body: string | undefined): Promise<HttpAnswer> {
  if (method === "OPTIONS") return { status: 204, headers: { ...CORS, "access-control-max-age": "86400" } };
  // No server-to-client stream: GET is not offered (the spec's answer is 405).
  if (method !== "POST") return { status: 405, headers: { ...CORS, allow: "POST, OPTIONS", "content-type": "text/plain; charset=utf-8" }, body: `Servidor MCP (Streamable HTTP): envía JSON-RPC por POST a ${publicMcpUrl()}` };
  if (body === undefined) return jsonAnswer(413, fail(null, -32600, `el mensaje supera ${MAX_BODY} bytes`));
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return jsonAnswer(400, fail(null, -32700, "JSON inválido"));
  }
  if (Array.isArray(raw) && (raw.length === 0 || raw.length > MAX_BATCH)) return jsonAnswer(400, fail(null, -32600, `un lote lleva de 1 a ${MAX_BATCH} mensajes`));
  const msgs: unknown[] = Array.isArray(raw) ? raw : [raw];
  const answers = (await Promise.all(msgs.map((m) => handlePublicMcp(deps, m)))).filter((a) => a !== undefined);
  if (answers.length === 0) return { status: 202, headers: CORS };
  if (!Array.isArray(raw)) {
    const one = answers[0] as { id: unknown; error?: { code: number } };
    // A message that is not JSON-RPC at all: the HTTP status says so too.
    return jsonAnswer(one.error?.code === -32600 ? 400 : 200, one);
  }
  return jsonAnswer(200, answers);
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
