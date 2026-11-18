/**
 * AgentPey's own base of Chilean online stores: who they are (from the public
 * participant list of blackfriday.cl), what platform they run on, their public
 * catalogue score, whether AI assistants name them, who shows up instead, and
 * the public contact address on their own site.
 *
 * Only code lives here. The list, catalogues, answers and contacts are written
 * to data/ (git-ignored): the repository is public.
 */
import { hostOf, judge, type EngineAnswer } from "./diagnostico.js";
import type { Platform, Store } from "./model.js";
import type { Readiness } from "./readiness.js";

/** One brand as blackfriday.cl lists it. */
export interface BfEntry {
  readonly slug: string;
  readonly name: string;
  /** The link the site sends visitors to (sometimes an affiliate redirect). */
  readonly link: string;
  readonly categories: readonly string[];
  /** What the site's own guide says the brand sells, when it has one. */
  readonly sells?: string;
}

/** Finds the JSON object that starts at `start` (a "{"), respecting strings. */
export function jsonObjectAt(text: string, start: number): unknown {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error("JSON sin cerrar");
}

type Json = Record<string, unknown>;

/**
 * The brands on blackfriday.cl's home page. The page carries its data as one
 * JSON object (with "marcas", "fichas" and "edit"); a brand may appear more
 * than once (featured and listed), so entries are merged by slug.
 */
export function parseBlackFriday(html: string): BfEntry[] {
  const at = html.indexOf('"marcas":[');
  if (at < 0) throw new Error("no encontré la lista de marcas en la página");
  // Walk back to the object that holds "marcas".
  let start = html.lastIndexOf('{"paginas"', at);
  if (start < 0) start = html.lastIndexOf("{", at);
  const data = jsonObjectAt(html, start) as Json;
  const fichas = (data.fichas ?? {}) as Record<string, Json>;
  const edit = (data.edit ?? {}) as Record<string, Json>;
  const bySlug = new Map<string, { slug: string; name: string; link: string; categories: Set<string> }>();
  for (const m of (data.marcas ?? []) as Json[]) {
    const slug = String(m.p ?? "");
    if (slug === "") continue;
    const cats = Array.isArray(m.c) ? m.c.map(String) : [];
    const prev = bySlug.get(slug);
    if (prev === undefined) bySlug.set(slug, { slug, name: String(m.n ?? slug), link: String(m.l ?? ""), categories: new Set(cats) });
    else for (const c of cats) prev.categories.add(c);
  }
  return [...bySlug.values()].map((e) => {
    const sitio = typeof fichas[e.slug]?.sitio === "string" ? String(fichas[e.slug]!.sitio) : undefined;
    const sellsList = edit[e.slug]?.que_vende;
    const sells = Array.isArray(sellsList) ? sellsList.map(String).join(" ") : typeof fichas[e.slug]?.descripcion === "string" ? String(fichas[e.slug]!.descripcion) : undefined;
    return {
      slug: e.slug, name: e.name,
      // The brand's own card names its site directly; prefer it over an affiliate link.
      link: sitio !== undefined && !isAffiliate(e.link) ? e.link : sitio ?? e.link,
      categories: [...e.categories],
      ...(sells ? { sells: sells.slice(0, 600) } : {}),
    };
  });
}

const AFFILIATE = /(^|\.)(soicos\.com|tidd\.ly|awin1\.com|gfl85trk\.com|gravitalstudio\.com|bit\.ly)$/;

export function isAffiliate(link: string): boolean {
  const h = hostOf(link);
  return h !== undefined && AFFILIATE.test(h);
}

/** Categories that are not online shops with a product catalogue. */
const NOT_SHOPS = new Set(["Inmobiliarias", "Viajes y Turismo", "Servicios"]);
const BIG = "Marketplaces y Grandes Tiendas";

export type Segment = "pyme" | "grande" | "no-tienda" | "sin-dominio";

/** The category a store is compared in: its first one that is not "Marketplaces y Grandes Tiendas". */
export function mainRubro(categories: readonly string[]): string {
  return categories.find((c) => c !== BIG) ?? categories[0] ?? "Sin categoría";
}

/**
 * Which stores the base targets. Affiliate links belong to big brands (Nike,
 * Paris…) unless the store is already known by name; categories with no
 * product catalogue (real estate, travel, services) are left out.
 */
export function segmentOf(e: BfEntry, domain: string | undefined, overrides: Readonly<Record<string, Segment>> = {}): Segment {
  const forced = overrides[e.slug];
  if (forced !== undefined) return forced;
  if (e.categories.length > 0 && e.categories.every((c) => NOT_SHOPS.has(c))) return "no-tienda";
  if (domain === undefined) return isAffiliate(e.link) ? "grande" : "sin-dominio";
  if (e.categories.includes(BIG)) return "grande";
  return "pyme";
}

/** One brand as cyber.cl lists it (CyberDay, run by the Santiago Chamber of Commerce). */
export interface CyberEntry {
  readonly id: number;
  readonly name: string;
  readonly url: string;
  readonly category: string;
}

/**
 * The brands in cyber.cl's page data. The page is a Next.js app: the data is a
 * JSON string inside a script, so quotes come escaped once.
 */
export function parseCyber(html: string): CyberEntry[] {
  const raw = html.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  const at = raw.indexOf('"brands":[');
  if (at < 0) throw new Error("no encontré la lista de marcas en cyber.cl");
  const brands = jsonObjectAt(raw, at + '"brands":'.length) as Json[];
  return brands.filter((b) => typeof b.url === "string" && b.url !== "").map((b) => ({
    id: Number(b.id), name: String(b.name ?? "").trim(), url: String(b.url),
    category: String(((b.category ?? {}) as Json).name ?? "Sin categoría"),
  }));
}

/** cyber.cl's categories, in blackfriday.cl's names so both lists compare in the same rubro; null = not a shop with a catalogue. */
const CYBER_RUBRO: Readonly<Record<string, string | null>> = {
  "Vestuario y Calzado": "Vestuario y Calzado", "Ropa Interior y Pijamas": "Vestuario y Calzado", "Vestuario Industrial": "Vestuario y Calzado",
  "Salud y Belleza": "Salud y Belleza", Hogar: "Hogar y Decoración", Muebles: "Hogar y Decoración",
  "Deportes y Outdoor": "Deportes y Outdoor", Tecnología: "Tecnología y Gaming", "Ferretería y Construcción": "Ferretería",
  "Alimentos y Bebidas": "Alimentos y Bebidas", "Accesorios Moda": "Moda y Accesorios", "Equipaje, Bolsos y Maletas": "Moda y Accesorios",
  Mascotas: "Mascotas", Infantil: "Infantil y Juguetería", Entretención: "Entretención y Cultura", "Educación y Cultura": "Entretención y Cultura",
  "Música y Audio": "Música y Audio", "Neumáticos y Accesorios": "Automotriz", Automotriz: "Automotriz",
  "Multitiendas y Supermercados": BIG,
  "Viajes y Turismo": null, Inmobiliarias: null, "Instituciones Benéficas": null, "Seguros y Servicios": null, Cuponeras: null,
};

export function cyberRubro(category: string): { rubro: string; segment: Segment } {
  const r = CYBER_RUBRO[category];
  if (r === null) return { rubro: category, segment: "no-tienda" };
  if (r === undefined) return { rubro: category, segment: "pyme" };
  return { rubro: r, segment: r === BIG ? "grande" : "pyme" };
}

/** The base's record of one store. */
export interface Tienda {
  readonly id: string;
  readonly domain: string | undefined;
  readonly origin: string | undefined;
  readonly name: string;
  readonly rubro: string;
  readonly categories: readonly string[];
  readonly sells?: string;
  readonly platform: Platform | undefined;
  readonly segment: Segment;
  readonly bfSlug: string;
  readonly bfLink: string;
  /** Where the store came from: blackfriday.cl (the default), cyber.cl or the pilot. */
  readonly sources?: readonly ("blackfriday" | "cyber" | "piloto")[];
  /** Public contact addresses found on the store's own pages, with the page each came from. */
  readonly emails?: readonly { email: string; page: string }[];
  readonly checkedAt?: string;
  readonly notes?: readonly string[];
}

export function toStore(t: Tienda): Store {
  return {
    id: t.id, name: t.name, origin: t.origin ?? `https://${t.domain}`, platform: t.platform ?? "propia",
    rubro: t.sells ? `${t.rubro}: ${t.sells}` : t.rubro, source: "black-friday", sellsOnline: true,
  };
}

// ---------------------------------------------------------------------------
// Public contact addresses

const NOT_EMAIL = /\.(png|jpe?g|gif|webp|svg|css|js)$|sentry|wixpress|example\.|domain\.com|email\.com|correo\.com|tucorreo|tuemail|yourmail|@2x|@3x|u003e|^[0-9a-f]{16,}@/i;

/** Email addresses written on a page (mailto links and plain text), lower-case, without image names or placeholders. */
export function findEmails(html: string): string[] {
  // Escaped JSON inside scripts writes "\ncontacto@…" or "\u003econtacto@…": drop the escape before matching.
  const text = html.replace(/\\[nrt]|\\u00[0-9a-f]{2}/gi, " ").replace(/&#64;|&#x40;|\[at\]|\(at\)/gi, "@").replace(/%40/g, "@");
  const found = new Set<string>();
  for (const m of text.matchAll(/(?:mailto:)?([a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})/gi)) {
    const email = m[1]!.toLowerCase().replace(/^[._-]+/, "");
    if (!NOT_EMAIL.test(email) && email.length <= 80) found.add(email);
  }
  return [...found];
}

/** Same-site links that look like a contact, about or help page, most likely first. */
export function contactLinks(html: string, pageUrl: string, max = 3): string[] {
  const host = hostOf(pageUrl);
  const out: string[] = [];
  for (const m of html.matchAll(/href=["']([^"'#]+)["']/gi)) {
    let url: string;
    try {
      url = new URL(m[1]!, pageUrl).toString();
    } catch {
      continue;
    }
    if (hostOf(url) !== host || out.includes(url)) continue;
    if (/contact|contacto|contactanos|cont[aá]ctenos|atencion|ayuda|nosotros|quienes-somos|about/i.test(new URL(url).pathname)) out.push(url);
  }
  return out.sort((a, b) => Number(/contact/i.test(b)) - Number(/contact/i.test(a))).slice(0, max);
}

/** Addresses on the store's own domain first, then the rest (a Gmail is still the store's public contact). */
export function rankEmails(emails: readonly string[], domain: string | undefined): string[] {
  const own = (e: string) => domain !== undefined && e.endsWith(`@${domain}`) || (domain !== undefined && e.split("@")[1]!.endsWith(`.${domain}`));
  const generic = (e: string) => /^(contacto|contact|hola|info|ventas|tienda|atencion|clientes|servicio)/.test(e);
  return [...emails].sort((a, b) => Number(own(b)) - Number(own(a)) || Number(generic(b)) - Number(generic(a)));
}

/**
 * The address a draft may go to: one on the store's own domain, or a generic
 * role address (contacto@, ventas@…) on a free mail service. A person's name
 * on another domain, or a platform's support address, is not used.
 */
export function mailableEmail(emails: readonly { email: string; page: string }[] | undefined, domain: string | undefined): { email: string; page: string } | undefined {
  const base = domain?.replace(/^www\./, "");
  const own = (e: string) => base !== undefined && (e.endsWith(`@${base}`) || e.split("@")[1]!.endsWith(`.${base}`) || e.split("@")[1]!.split(".")[0] === base.split(".")[0]);
  const generic = (e: string) => /^(contacto|contact|hola|info|ventas|tienda|atencion|clientes|servicio|pedidos|soporte)/.test(e) && /@(gmail|hotmail|outlook|yahoo|live)\./.test(e);
  return emails?.find((e) => own(e.email)) ?? emails?.find((e) => generic(e.email));
}

// ---------------------------------------------------------------------------
// Comparison by rubro

export interface StoredAnswer {
  readonly engine: string;
  readonly question: string;
  readonly text: string;
  readonly urls: readonly string[];
  readonly at: string;
}

export interface StoreInput {
  readonly tienda: Tienda;
  readonly store: Store;
  readonly readiness: Readiness | undefined;
  readonly products: number;
  /** Answers to the store's own buyer questions in this run. */
  readonly answers: readonly StoredAnswer[];
  /** Questions an engine could not answer in this run (error, time-out). */
  readonly failed: number;
}

export interface StoreResult {
  readonly id: string;
  readonly name: string;
  readonly domain: string;
  readonly rubro: string;
  readonly platform: string;
  readonly products: number;
  readonly score: number | undefined;
  readonly answers: number;
  /** Answers that send the buyer to the store's own site (domain written or a page linked). */
  readonly mentioned: number;
  /** Answers that name the store or brand but send the buyer somewhere else. */
  readonly brandOnly: number;
  /** Questions asked again to the same engine in a later sample, and how many of them changed verdict. */
  readonly repeated: number;
  readonly changed: number;
  readonly cited: number;
  readonly failed: number;
  readonly byEngine: Readonly<Record<string, { answers: number; mentioned: number }>>;
  /** Other sites in this store's answers, by number of answers they appear in. */
  readonly instead: readonly { domain: string; count: number }[];
  /** Sites that are not stores (reviews, press, comparison sites) the answers relied on. */
  readonly sources: readonly { domain: string; count: number }[];
  /** In every answer of the rubro (all its stores' questions), how often each store of the rubro is named. */
  readonly rubroShare: readonly { id: string; name: string; mentioned: number }[];
  readonly rubroAnswers: number;
  readonly rubroAvgScore: number | undefined;
  readonly rubroBest: { name: string; score: number } | undefined;
  readonly rubroStores: number;
  /** Stores of the rubro whose catalogue could be read. */
  readonly rubroScored: number;
  readonly rubroAvgMentionRate: number | undefined;
  readonly weakest: readonly { key: string; label: string; pass: number }[];
  readonly example?: { engine: string; question: string; instead: readonly string[] };
  /** An answer that named the brand but linked other sites for it. */
  readonly brandExample?: { engine: string; question: string; instead: readonly string[] };
}

const BIG_MARKETS = /(^|\.)(mercadolibre\.cl|falabella\.com|paris\.cl|ripley\.cl|lider\.cl|sodimac\.cl|easy\.cl|jumbo\.cl|pcfactory\.cl|amazon\.com|aliexpress\.com|temu\.com|hites\.com|abcdin\.cl|abc\.cl|tottus\.cl|santaisabel\.cl|unimarc\.cl|mercadolibre\.com)$/;

/** Hosts that are a store or brand site rather than a review, a news site or the engine's own pages. */
function storeLike(h: string): boolean {
  return !/(^|\.)(gob\.cl|cl\.linkedin\.com|wikipedia\.org|reddit\.com|youtube\.com|chatgpt\.com|openai\.com|claude\.ai|anthropic\.com|google\.com|google\.cl|bing\.com|blogspot\.com|wordpress\.com|tripadvisor\.cl|tripadvisor\.com|biobiochile\.cl|emol\.com|latercera\.com|cooperativa\.cl|df\.cl|t13\.cl|24horas\.cl|lun\.com|elmostrador\.cl|xataka\.com|xataka\.cl|rtings\.com|notebookcheck\.net|gsmarena\.com|reclamos\.cl|sernac\.cl|solotodo\.cl|knasta\.cl|blackfriday\.cl|cyber\.cl|cyberday\.cl)$/.test(h);
}

const ENGINE_SITES = /(^|\.)(chatgpt\.com|openai\.com|claude\.ai|anthropic\.com|google\.com|google\.cl|bing\.com|gob\.cl)$/;

export function isBigMarket(h: string): boolean {
  return BIG_MARKETS.test(h);
}

const sameHost = (h: string, domain: string) => h === domain || h.endsWith(`.${domain}`);

const foldText = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/**
 * The base counts a store as recommended only when the answer sends the buyer
 * to its own site: its domain is written in the answer or one of its pages is
 * linked. A store that is also a product brand (Osoji, Bebesit…) is often
 * named while the answer sends the buyer to buy it elsewhere: that is counted
 * apart, as "brand only".
 */
export function presence(store: Store, a: { engine: string; text: string; urls: readonly string[] }): { mentioned: boolean; brandOnly: boolean; cited: boolean; others: string[] } {
  const v = judge(store, { engine: a.engine, text: a.text, urls: [...a.urls] } as EngineAnswer);
  const domain = hostOf(store.origin) ?? "";
  const site = v.cited || foldText(a.text).includes(domain);
  return { mentioned: site, brandOnly: v.mentioned && !site, cited: v.cited, others: [...v.others] };
}

/** Per store: its own answers, then the rubro's averages, best score and who gets named across the rubro's answers. */
export function compare(inputs: readonly StoreInput[]): StoreResult[] {
  const byRubro = new Map<string, StoreInput[]>();
  for (const i of inputs) byRubro.set(i.tienda.rubro, [...(byRubro.get(i.tienda.rubro) ?? []), i]);
  return inputs.map((i) => {
    const domain = i.tienda.domain ?? hostOf(i.store.origin) ?? "";
    const verdicts = i.answers.map((a) => ({ a, v: presence(i.store, a) }));
    const instead = new Map<string, number>();
    for (const { v } of verdicts) for (const h of new Set(v.others.filter(storeLike))) if (!sameHost(h, domain)) instead.set(h, (instead.get(h) ?? 0) + 1);
    const byEngine: Record<string, { answers: number; mentioned: number }> = {};
    for (const { a, v } of verdicts) {
      const e = (byEngine[a.engine] ??= { answers: 0, mentioned: 0 });
      e.answers++;
      if (v.mentioned) e.mentioned++;
    }
    const peers = byRubro.get(i.tienda.rubro) ?? [i];
    const rubroAnswers = peers.flatMap((p) => p.answers);
    const rubroShare = peers.map((p) => ({
      id: p.tienda.id, name: p.tienda.name,
      mentioned: rubroAnswers.filter((a) => presence(p.store, a).mentioned).length,
    })).sort((a, b) => b.mentioned - a.mentioned);
    const scored = peers.filter((p) => p.readiness !== undefined && p.products > 0);
    const best = [...scored].sort((a, b) => b.readiness!.score - a.readiness!.score)[0];
    const rates = peers.filter((p) => p.answers.length > 0).map((p) => p.answers.filter((a) => presence(p.store, a).mentioned).length / p.answers.length);
    // The example for the sheet and the email: ChatGPT's when there is one (it is the assistant most buyers use).
    const missing = verdicts.filter(({ v }) => !v.mentioned && v.others.filter(storeLike).length >= 2);
    const firstMissing = missing.find(({ a }) => a.engine === "chatgpt") ?? missing[0];
    // Same engine, same question, asked more than once: did the verdict change between samples?
    const runsOf = new Map<string, boolean[]>();
    for (const { a, v } of verdicts) runsOf.set(`${a.engine}\u0000${a.question}`, [...(runsOf.get(`${a.engine}\u0000${a.question}`) ?? []), v.mentioned]);
    const repeatedRuns = [...runsOf.values()].filter((xs) => xs.length >= 2);
    const brandHits = verdicts.filter(({ v }) => v.brandOnly && v.others.filter(storeLike).length >= 1);
    const brandHit = brandHits.find(({ a }) => a.engine === "chatgpt") ?? brandHits[0];
    const sources = new Map<string, number>();
    for (const { v } of verdicts) for (const h of new Set(v.others.filter((x) => !storeLike(x) && !ENGINE_SITES.test(x)))) sources.set(h, (sources.get(h) ?? 0) + 1);
    return {
      id: i.tienda.id, name: i.tienda.name, domain, rubro: i.tienda.rubro, platform: i.tienda.platform ?? "?", products: i.products,
      score: i.products > 0 ? i.readiness?.score : undefined,
      answers: i.answers.length,
      mentioned: verdicts.filter(({ v }) => v.mentioned).length,
      brandOnly: verdicts.filter(({ v }) => v.brandOnly).length,
      repeated: repeatedRuns.length,
      changed: repeatedRuns.filter((xs) => xs.some((x) => x !== xs[0])).length,
      cited: verdicts.filter(({ v }) => v.cited).length,
      failed: i.failed,
      byEngine,
      sources: [...sources.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([d, count]) => ({ domain: d, count })),
      instead: [...instead.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([d, count]) => ({ domain: d, count })),
      rubroShare, rubroAnswers: rubroAnswers.length,
      rubroAvgScore: scored.length === 0 ? undefined : Math.round(scored.reduce((a, p) => a + p.readiness!.score, 0) / scored.length),
      rubroBest: best === undefined ? undefined : { name: best.tienda.name, score: best.readiness!.score },
      rubroStores: peers.length,
      rubroScored: scored.length,
      rubroAvgMentionRate: rates.length === 0 ? undefined : rates.reduce((a, b) => a + b, 0) / rates.length,
      weakest: (i.products > 0 ? i.readiness?.checks ?? [] : []).filter((c) => c.notVisible !== true && c.pass < 0.9)
        .sort((a, b) => b.weight * (1 - b.pass) - a.weight * (1 - a.pass)).slice(0, 3).map((c) => ({ key: c.key, label: c.label, pass: c.pass })),
      ...(brandHit ? { brandExample: { engine: brandHit.a.engine, question: brandHit.a.question, instead: brandHit.v.others.filter(storeLike).slice(0, 3) } } : {}),
      ...(firstMissing ? { example: { engine: firstMissing.a.engine, question: firstMissing.a.question, instead: firstMissing.v.others.filter(storeLike).slice(0, 3) } } : {}),
    };
  });
}
