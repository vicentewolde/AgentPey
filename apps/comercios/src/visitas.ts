/**
 * Who reads the public guides: a daily count per AI crawler, per assistant
 * fetching a page for someone, and per person arriving from an assistant's
 * answer, for each public page. It is the measure of whether AI assistants
 * find and cite agentpey.com/chile, so the pages can be judged by it.
 *
 * Only pages actually served (200 or 304) are counted, so the paths are the
 * site's own and cannot be invented. Only categories are kept: no IP, no user-agent string, no query (a search's
 * words stay out). User agents can be faked, so these are counts of what the
 * requests said they were, not verified crawlers.
 */
import { z } from "zod";

import { GUIDE_PATH } from "./guia.js";

/** How the request reached the page: a crawler building an index, one gathering training data, an assistant fetching it for a person, or a person following an assistant's answer. */
export const VISIT_KINDS = ["indexa", "entrena", "lee para una persona", "persona desde una IA"] as const;
export type VisitKind = (typeof VISIT_KINDS)[number];

/** Known user agents, first match wins; by each company's published names. */
const AGENTS: readonly { token: string; agent: string; kind: VisitKind }[] = [
  { token: "chatgpt-user", agent: "ChatGPT-User (OpenAI)", kind: "lee para una persona" },
  { token: "oai-searchbot", agent: "OAI-SearchBot (OpenAI)", kind: "indexa" },
  { token: "gptbot", agent: "GPTBot (OpenAI)", kind: "entrena" },
  { token: "claude-user", agent: "Claude-User (Anthropic)", kind: "lee para una persona" },
  { token: "claude-searchbot", agent: "Claude-SearchBot (Anthropic)", kind: "indexa" },
  { token: "claudebot", agent: "ClaudeBot (Anthropic)", kind: "entrena" },
  { token: "perplexity-user", agent: "Perplexity-User", kind: "lee para una persona" },
  { token: "perplexitybot", agent: "PerplexityBot", kind: "indexa" },
  { token: "mistralai-user", agent: "MistralAI-User", kind: "lee para una persona" },
  { token: "duckassistbot", agent: "DuckAssistBot (DuckDuckGo)", kind: "lee para una persona" },
  { token: "google-cloudvertexbot", agent: "Google-CloudVertexBot", kind: "lee para una persona" },
  { token: "googlebot", agent: "Googlebot (Google, también Gemini)", kind: "indexa" },
  { token: "bingbot", agent: "Bingbot (Bing, también ChatGPT y Copilot)", kind: "indexa" },
  { token: "applebot", agent: "Applebot (Apple)", kind: "indexa" },
  { token: "yandexbot", agent: "YandexBot", kind: "indexa" },
  { token: "meta-externalagent", agent: "meta-externalagent (Meta)", kind: "entrena" },
  { token: "amazonbot", agent: "Amazonbot", kind: "entrena" },
  { token: "ccbot", agent: "CCBot (Common Crawl)", kind: "entrena" },
  { token: "bytespider", agent: "Bytespider (ByteDance)", kind: "entrena" },
];

/** Assistants whose answers link out: by the referring host, or the utm_source ChatGPT adds to its links. */
const ASSISTANT_HOSTS: readonly { host: string; agent: string }[] = [
  { host: "chatgpt.com", agent: "desde ChatGPT" },
  { host: "chat.openai.com", agent: "desde ChatGPT" },
  { host: "perplexity.ai", agent: "desde Perplexity" },
  { host: "claude.ai", agent: "desde Claude" },
  { host: "gemini.google.com", agent: "desde Gemini" },
  { host: "copilot.microsoft.com", agent: "desde Copilot" },
  { host: "chat.mistral.ai", agent: "desde Mistral" },
  { host: "chat.deepseek.com", agent: "desde DeepSeek" },
];

const hostIs = (host: string, name: string) => host === name || host.endsWith(`.${name}`);

/** Who a request is, by what it says; undefined for everyone else (people, other bots), who are not counted. */
export function visitor(userAgent: string | undefined, referer: string | undefined, utmSource: string | null): { agent: string; kind: VisitKind } | undefined {
  const ua = (userAgent ?? "").toLowerCase();
  const known = AGENTS.find((a) => ua.includes(a.token));
  if (known !== undefined) return { agent: known.agent, kind: known.kind };
  let host = "";
  try {
    host = referer === undefined ? "" : new URL(referer).hostname.toLowerCase();
  } catch {
    host = "";
  }
  const utm = (utmSource ?? "").toLowerCase();
  const from = ASSISTANT_HOSTS.find((a) => hostIs(host, a.host) || utm === a.host);
  return from === undefined ? undefined : { agent: from.agent, kind: "persona desde una IA" };
}

/**
 * The visitor's address, for the per-IP limits (never stored). Render serves
 * through Cloudflare, which sets cf-connecting-ip itself; x-forwarded-for keeps
 * whatever the client sent in front (a rotating fake first value got past the
 * search limit, measured 2026-11-22), so only its last entry, the one the
 * proxy added, is used when Cloudflare's is missing. `behindCloudflare` is the
 * hosted mode (PUBLIC=1, Render), the only place that header comes from Cloudflare.
 */
export function requestIp(headers: Record<string, string | string[] | undefined>, socketAddress: string | undefined, behindCloudflare: boolean): string {
  // Only Cloudflare sets it where it can be trusted: anywhere else a client could choose its own address.
  const cf = behindCloudflare ? headers["cf-connecting-ip"] : undefined;
  if (typeof cf === "string" && cf.trim() !== "") return cf.trim();
  // With a proxy behind Cloudflare the last entry may be Cloudflare's edge, shared by many: hence cf-connecting-ip first.
  const fwd = headers["x-forwarded-for"];
  const last = typeof fwd === "string" ? fwd.split(",").at(-1)?.trim() : undefined;
  return last !== undefined && last !== "" ? last : (socketAddress ?? "?");
}

/** The public pages counted, by their path without the query; undefined for anything else. */
export function countedPath(path: string): string | undefined {
  if (path === "/robots.txt" || path === "/llms.txt") return path;
  const p = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  if (p !== GUIDE_PATH && !p.startsWith(`${GUIDE_PATH}/`)) return undefined;
  // The same shape the gateway lets through: no dots but the sitemap and key file, nothing odd kept.
  return /^\/chile(?:\/[a-z0-9-]{1,80}(?:\.(?:xml|txt))?){0,2}$/.test(p) ? p : undefined;
}

export const VisitRowSchema = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), agent: z.string(), kind: z.enum(VISIT_KINDS), path: z.string(), n: z.number().int().positive() });
export type VisitRow = z.infer<typeof VisitRowSchema>;

/** Counts kept in memory and written in one go every few minutes: a page view costs no database write. */
export class VisitCounter {
  readonly #counts = new Map<string, VisitRow>();
  constructor(readonly maxKeys = 20_000) {}

  hit(who: { agent: string; kind: VisitKind }, path: string, at = new Date()): void {
    const day = at.toISOString().slice(0, 10);
    const key = `${day}|${who.agent}|${path}`;
    const row = this.#counts.get(key);
    if (row !== undefined) row.n += 1;
    else if (this.#counts.size < this.maxKeys) this.#counts.set(key, { day, agent: who.agent, kind: who.kind, path, n: 1 });
  }

  /** The counts so far, emptied: the caller adds them to what is stored. */
  drain(): VisitRow[] {
    const rows = [...this.#counts.values()];
    this.#counts.clear();
    return rows;
  }
}

/** A plain report: per kind and agent, then the most read pages, for the days given. */
export function visitsReport(rows: readonly VisitRow[]): string {
  if (rows.length === 0) return "Sin visitas de robots ni de asistentes en esas fechas.";
  const sum = (rs: readonly VisitRow[]) => rs.reduce((n, r) => n + r.n, 0);
  const days = [...new Set(rows.map((r) => r.day))].sort();
  const out = [`Del ${days[0]} al ${days.at(-1)} (días en UTC): ${sum(rows)} visitas contadas.`];
  for (const kind of VISIT_KINDS) {
    const of = rows.filter((r) => r.kind === kind);
    if (of.length === 0) continue;
    out.push("", `${kind}: ${sum(of)}`);
    const byAgent = new Map<string, VisitRow[]>();
    for (const r of of) byAgent.set(r.agent, [...(byAgent.get(r.agent) ?? []), r]);
    for (const [agent, rs] of [...byAgent].sort((a, b) => sum(b[1]) - sum(a[1]))) {
      const pages = new Map<string, number>();
      for (const r of rs) pages.set(r.path, (pages.get(r.path) ?? 0) + r.n);
      const top = [...pages].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p, n]) => `${p} ${n}`).join(" · ");
      out.push(`  ${agent}: ${sum(rs)} en ${pages.size} páginas. ${top}`);
    }
  }
  return out.join("\n");
}
