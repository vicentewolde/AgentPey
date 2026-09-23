/**
 * Reading a purchase instruction, deterministically.
 *
 * **This is the layer that is allowed to be wrong.** `PILOTO-F9.md` § 4.1 draws
 * the trust boundary right after it: interpreting and discovering happen on
 * RealOps' side, deciding and executing happen on AgentPey's. A misreading here
 * can pick the wrong product; it cannot grant a venue, an asset or an amount
 * the signed Mandate does not already allow. That is why a future LLM could
 * replace this file and nothing about the guarantees would change.
 *
 * **And it does not guess.** Anything it does not recognise comes back as
 * `InstructionNotRecognised` and the UI offers the two buttons instead.
 * Guessing is precisely what an agent holding spending permission must not do —
 * a wrong guess here is a real purchase of the wrong thing, refunded by nobody.
 *
 * Deterministic rather than a model call, for the same reasons `interpret.ts`
 * already gives: the pilot has to be reproducible, has to run offline, and the
 * same sentence must produce the same answer every time it is demonstrated.
 */
import { AgentPassError } from "@agentpass/core";

import { agentKindSchema, type AgentKind } from "./accounts.js";
import { bilingual, type Bilingual } from "./copy.js";

/** The one pair the pilot's brief covers. A closed dictionary, not a parser. */
export const KNOWN_PAIRS = ["XLM/USDC"] as const;

/** The pair used when the person picks the product from a button instead of typing. */
export const SUPPORTED_PAIR: string = KNOWN_PAIRS[0];

export interface Interpretation {
  readonly kind: AgentKind;
  /**
   * The merchant's own product id, verbatim — what lands in a signed intent.
   *
   * Needed since T96, when a kind stopped being the same thing as a product:
   * `bazaar_shopper` covers two products, so naming only the kind would leave
   * the buyer to pick, which is exactly the guess this module refuses to make.
   */
  readonly productId: string;
  readonly quantity: number;
  /** Present for `market_brief`. */
  readonly pair?: string;
}

/** Lowercase, accents stripped, punctuation collapsed — the same normalisation discovery uses. */
function normalise(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, " ")
    .trim();
}

/**
 * Small counts in words, in both languages the pages speak. Since the pilot
 * switched to English by default, "buy two reports" is as ordinary a sentence
 * as "compra dos informes".
 */
const NUMBER_WORDS: Readonly<Record<string, number>> = {
  un: 1,
  una: 1,
  uno: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
};

/**
 * Stems, matched as prefixes, so a plural or a diminutive does not need its
 * own entry — `informes` and `creditos` are the words people actually type,
 * and a vocabulary that only knew the singular refused perfectly ordinary
 * Spanish. (Found by a test, not by reading.) `report` also covers `reporte`,
 * and `pack` covers `package`.
 */
const BRIEF_STEMS = ["informe", "report", "brief", "mercado", "market"];
/**
 * `ia` and `ai` used to be enough on their own to mean credits. They are not
 * any more (T96): the bazaar sells an *AI* video scriptwriter, so a bare "ai"
 * names two different products and naming two is naming none. A sentence now
 * has to say credits, or pack, in either language — which every sentence the
 * tests were written from already did. The rule this follows is the module's
 * own: a vocabulary that matches too much stops refusing, and refusing is the
 * whole job.
 */
const CREDIT_STEMS = ["credito", "credit"];
/** The bazaar's swap risk quote. `riesgo`/`risk` alone would be too broad, so the pair of ideas is what matches. */
const SWAP_STEMS = ["swap", "cotizacion", "quote"];
/** The bazaar's video scriptwriter. `script` also covers `scriptwriter`; `guion` covers `guiones`. */
const SCRIPT_STEMS = ["video", "guion", "script", "scriptwriter"];

/**
 * The real store behind Vitrinee (T100). One row per product, in both
 * languages, by what the thing *is*, never by the store's brand words:
 * "Cordillera" names both the hoodie and the stickers, so it names neither.
 *
 * `pack` and `paquete` used to mean the credits on their own. They cannot any
 * more: "compra un pack de stickers" is the sentence the store's own demo
 * uses, and with `pack` in both rows it named two products, which is naming
 * none. Same narrowing as `ai` in T96, same reason. Every credits sentence
 * the tests were written from still reads, because each also says credits.
 * `polera` and `poleron` are different garments in Chile and neither is a
 * prefix of the other, which is what keeps the two rows apart.
 */
const HOODIE_STEMS = ["hoodie", "poleron", "sudadera"];
const TSHIRT_STEMS = ["polera", "camiseta", "tshirt", "shirt"];
const BEANIE_STEMS = ["gorro", "beanie"];
const COFFEE_STEMS = ["cafe", "coffee"];
const BOTTLE_STEMS = ["botella", "bottle", "termo", "thermos"];
const STICKER_STEMS = ["sticker", "calcomania", "pegatina"];

function namesAny(tokens: readonly string[], stems: readonly string[], exact: readonly string[] = []): boolean {
  return tokens.some((token) => exact.includes(token) || stems.some((stem) => token.startsWith(stem)));
}

/**
 * The closed dictionary, one row per product the pilot can buy.
 *
 * A row is deliberately (kind, product) and not just kind: since T96 one kind
 * (`bazaar_shopper`) covers more than one product, and the sentence has to say
 * which. Adding a merchant's new product here is what makes it typeable; until
 * then it is only clickable from the catalogue, which is the right default —
 * a vocabulary grown by guessing is the failure mode, not the feature.
 */
interface ProductVocabulary {
  readonly kind: AgentKind;
  readonly productId: string;
  readonly stems: readonly string[];
  readonly exact?: readonly string[];
}

const VOCABULARY: readonly ProductVocabulary[] = [
  { kind: "market_brief", productId: "signaldesk:market-brief-xlm-usdc", stems: BRIEF_STEMS },
  { kind: "ai_credits", productId: "signaldesk:ai-credits-1000", stems: CREDIT_STEMS },
  { kind: "bazaar_shopper", productId: "swap-risk-quote", stems: SWAP_STEMS },
  { kind: "bazaar_shopper", productId: "ai-video-scriptwriter", stems: SCRIPT_STEMS },
  // Jumpseller's own product ids for vitrinee.jumpseller.com (T100). They
  // need a shipping address, so a sentence only ever leads to the card.
  { kind: "vitrinee_shopper", productId: "37282902", stems: HOODIE_STEMS },
  { kind: "vitrinee_shopper", productId: "37282997", stems: TSHIRT_STEMS },
  { kind: "vitrinee_shopper", productId: "37282998", stems: BEANIE_STEMS, exact: ["hat"] },
  { kind: "vitrinee_shopper", productId: "37282999", stems: COFFEE_STEMS },
  { kind: "vitrinee_shopper", productId: "37283000", stems: BOTTLE_STEMS },
  { kind: "vitrinee_shopper", productId: "37283001", stems: STICKER_STEMS },
];

const MAX_INSTRUCTION_LENGTH = 500;
const MAX_QUANTITY = 5;

/**
 * Why a sentence was not understood, as a key the page turns into words in
 * either language. The error message stays in English, for logs.
 */
export const INSTRUCTION_PROBLEMS = ["empty", "too_long", "both_products", "no_product", "unknown_pair"] as const;
export type InstructionProblem = (typeof INSTRUCTION_PROBLEMS)[number];

function notRecognised(problem: InstructionProblem, message: string, instruction: string): AgentPassError {
  return new AgentPassError("InstructionNotUnderstood", message, {
    // The instruction is the person's own words, echoed back so the UI can
    // show what it read. It is not personal data and it is not interpreted
    // anywhere else — it never reaches a decision.
    details: { instruction, problem },
  });
}

/** The quantity, if the sentence names one. Defaults to 1; never silently large. */
function readQuantity(tokens: readonly string[]): number {
  for (const token of tokens) {
    const word = NUMBER_WORDS[token];
    if (word !== undefined) return word;
    if (/^\d{1,4}$/.test(token)) {
      const value = Number(token);
      // A bare "1000" in "1000 creditos de IA" is the pack size, not a count
      // of purchases. Only small numbers are read as quantities.
      if (value >= 1 && value <= MAX_QUANTITY) return value;
    }
  }
  return 1;
}

function readPair(normalised: string): string | undefined {
  for (const pair of KNOWN_PAIRS) {
    const spaced = normalise(pair).replace("/", " ");
    if (normalised.includes(normalise(pair)) || normalised.includes(spaced)) return pair;
  }
  return undefined;
}

/**
 * Reads one instruction into a structured request.
 *
 * @throws AgentPassError `InstructionNotUnderstood` when the sentence names
 * neither product, names both, is empty, or is too long to be an instruction.
 */
export function interpretInstruction(instruction: string): Interpretation {
  if (typeof instruction !== "string" || instruction.trim() === "") {
    throw notRecognised("empty", "the instruction is empty", String(instruction));
  }
  if (instruction.length > MAX_INSTRUCTION_LENGTH) {
    throw notRecognised("too_long", "the instruction is too long", instruction.slice(0, 80));
  }

  const normalised = normalise(instruction);
  const tokens = normalised.split(" ");

  const matched = VOCABULARY.filter((entry) => namesAny(tokens, entry.stems, entry.exact));

  // None, or more than one, is a sentence this cannot read. Picking among them
  // would be the guess this module exists not to make — and the sentence that
  // names two products is now as ordinary as the one that names none, with
  // four products in the dictionary instead of two.
  if (matched.length !== 1) {
    throw matched.length > 1
      ? notRecognised("both_products", "the instruction asks for more than one product at once", instruction)
      : notRecognised("no_product", "no product recognised in the instruction", instruction);
  }

  const entry = matched[0]!;
  const quantity = readQuantity(tokens);

  if (entry.kind !== "market_brief") {
    // The bazaar's products need parameters a sentence does not reliably carry
    // (which pair, which tone, how long), and the store's need a shipping
    // address. Reading the product and the quantity is as far as this goes;
    // the form asks for the rest rather than inventing it.
    return { kind: agentKindSchema.parse(entry.kind), productId: entry.productId, quantity };
  }

  const pair = readPair(normalised);
  if (pair === undefined) {
    throw notRecognised("unknown_pair", `only ${KNOWN_PAIRS.join(", ")} is known; the pair has to be named`, instruction);
  }
  return { kind: agentKindSchema.parse("market_brief"), productId: entry.productId, quantity, pair };
}

/** What the UI offers when the sentence was not understood: the two products, as buttons. */
export const FALLBACK_CHOICES: readonly { readonly kind: AgentKind; readonly label: Bilingual }[] = [
  { kind: "market_brief", label: bilingual("Buy the XLM/USDC market report", "Comprar el informe de mercado XLM/USDC") },
  { kind: "ai_credits", label: bilingual("Buy 1000 AI credits", "Comprar 1000 créditos de IA") },
];
