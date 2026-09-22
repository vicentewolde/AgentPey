/**
 * Turns "compra el hoodie talla M y envíalo a Ñuñoa" into a product, a
 * quantity and a shipping city — deterministically, with no model behind it,
 * so the demo never waits on an external API. An LLM matcher can sit behind
 * `--llm` later; this one is the floor it must beat.
 */
import type { ManifestProduct } from "@vitrinee/core";
import { VitrineeError } from "@vitrinee/core";

export interface PurchaseIntent {
  product: ManifestProduct;
  quantity: number;
  shipping: { city?: string; country: string };
  /** Why this product won, for the terminal. */
  reasons: string[];
}

const STOPWORDS = new Set([
  "compra", "comprar", "comprame", "quiero", "dame", "pide", "pedir", "necesito", "porfa", "favor",
  "el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "y", "a", "al", "en", "por",
  "para", "con", "que", "me", "lo", "le", "mi", "su", "e",
  "envialo", "enviarlo", "enviar", "envia", "envio", "enviamelo", "despachalo", "despachar", "despacho",
  "mandalo", "mandar", "manda", "entregar", "entregalo", "entrega", "hasta", "comuna", "ciudad",
  "talla", "size", "unidad", "unidade",
]);

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
};

export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stem(token: string): string {
  return token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token;
}

export function tokenize(text: string): string[] {
  return normalize(text).split(" ").filter((t) => t !== "").map(stem);
}

/** A number right after the verb ("compra 2 gorros", "quiero dos cafés"); anything else is 1. */
export function parseQuantity(instruction: string): number {
  const n = normalize(instruction);
  const match = /^(?:[a-z]+\s+)?(?:me\s+)?(\d{1,2}|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+/.exec(n);
  const word = match?.[1];
  if (word === undefined) return 1;
  const quantity = NUMBER_WORDS[word] ?? Number(word);
  return quantity >= 1 ? quantity : 1;
}

const SHIPPING_RE =
  /(?:env[ií]a(?:los|lo|melos|melo|rlos|rlo|r)?|desp[aá]ch(?:alos|alo|ar|o)|m[aá]nda(?:los|lo|r)?|entr[eé]g(?:alos|alo|ar|a))\s+(?:a|en|para|hasta)\s+(?:la\s+comuna\s+de\s+|la\s+ciudad\s+de\s+)?([\p{L}][\p{L}0-9]*(?:\s+[\p{L}][\p{L}0-9]*)?)/iu;

const TRAILING_STOP = new Set(["y", "con", "por", "para", "en", "a", "de"]);

export function parseShipping(instruction: string): { city?: string; country: string } {
  const match = SHIPPING_RE.exec(instruction);
  const raw = match?.[1];
  if (raw === undefined) return { country: "CL" };
  const words = raw.trim().split(/\s+/);
  while (words.length > 1 && TRAILING_STOP.has(normalize(words[words.length - 1]!))) words.pop();
  return { city: words.join(" "), country: "CL" };
}

function sizeOf(normalized: string): string | undefined {
  return /\btalla\s+([a-z0-9]{1,3})\b/.exec(normalized)?.[1];
}

export function matchProduct(products: readonly ManifestProduct[], instruction: string): { product: ManifestProduct; reasons: string[] } {
  const normalized = normalize(instruction);
  const shipping = parseShipping(instruction);
  const cityTokens = new Set(shipping.city === undefined ? [] : tokenize(shipping.city));
  const wantedSize = sizeOf(normalized);
  const wanted = tokenize(instruction).filter(
    (t) => !STOPWORDS.has(t) && NUMBER_WORDS[t] === undefined && !/^\d+$/.test(t) && !cityTokens.has(t) && t !== wantedSize,
  );

  const scored = products.map((product) => {
    const name = new Set(tokenize(product.name));
    const sku = new Set(tokenize(product.sku.replace(/-/g, " ")));
    const description = new Set(tokenize(product.description));
    const reasons: string[] = [];
    let score = 0;
    for (const token of wanted) {
      if (name.has(token)) { score += 3; reasons.push(`"${token}" en el nombre`); }
      else if (sku.has(token)) { score += 2; reasons.push(`"${token}" en el SKU`); }
      else if (description.has(token)) { score += 1; reasons.push(`"${token}" en la descripción`); }
    }
    if (normalized.includes(normalize(product.id)) || normalized.includes(normalize(product.sku))) {
      score += 10; reasons.push("id o SKU exacto");
    }
    const productSize = sizeOf(normalize(product.name));
    if (wantedSize !== undefined && productSize !== undefined) {
      if (productSize === wantedSize) { score += 2; reasons.push(`talla ${wantedSize.toUpperCase()}`); }
      else { score = 0; reasons.length = 0; reasons.push(`talla ${productSize.toUpperCase()} ≠ ${wantedSize.toUpperCase()}`); }
    }
    return { product, score, reasons };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const runnerUp = scored[1];
  if (best === undefined || best.score === 0) {
    throw new VitrineeError("ValidationError", `no entendí qué producto comprar en "${instruction}"`, {
      details: { catalog: products.map((p) => p.name) },
    });
  }
  if (runnerUp !== undefined && runnerUp.score === best.score) {
    throw new VitrineeError("ValidationError", `la instrucción es ambigua entre "${best.product.name}" y "${runnerUp.product.name}"`, {
      details: { candidates: [best.product.name, runnerUp.product.name] },
    });
  }
  return { product: best.product, reasons: best.reasons };
}

export function parseIntent(products: readonly ManifestProduct[], instruction: string): PurchaseIntent {
  const { product, reasons } = matchProduct(products, instruction);
  return { product, quantity: parseQuantity(instruction), shipping: parseShipping(instruction), reasons };
}
