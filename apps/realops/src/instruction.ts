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
const CREDIT_STEMS = ["credito", "credit", "paquete", "pack"];
/**
 * Two-letter words are matched exactly. A prefix rule on `ia` or `ai` would
 * claim half the dictionary, and a vocabulary that matches too much is the
 * same failure as one that matches too little: it stops refusing.
 */
const CREDIT_EXACT = ["ia", "ai"];

function namesAny(tokens: readonly string[], stems: readonly string[], exact: readonly string[] = []): boolean {
  return tokens.some((token) => exact.includes(token) || stems.some((stem) => token.startsWith(stem)));
}

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

  const wantsBrief = namesAny(tokens, BRIEF_STEMS);
  const wantsCredits = namesAny(tokens, CREDIT_STEMS, CREDIT_EXACT);

  // Both, or neither, is a sentence this cannot read. Picking one would be the
  // guess this module exists not to make.
  if (wantsBrief === wantsCredits) {
    throw wantsBrief
      ? notRecognised("both_products", "the instruction asks for both products at once", instruction)
      : notRecognised("no_product", "no product recognised in the instruction", instruction);
  }

  const quantity = readQuantity(tokens);

  if (wantsCredits) {
    return { kind: agentKindSchema.parse("ai_credits"), quantity };
  }

  const pair = readPair(normalised);
  if (pair === undefined) {
    throw notRecognised("unknown_pair", `only ${KNOWN_PAIRS.join(", ")} is known; the pair has to be named`, instruction);
  }
  return { kind: agentKindSchema.parse("market_brief"), quantity, pair };
}

/** What the UI offers when the sentence was not understood: the two products, as buttons. */
export const FALLBACK_CHOICES: readonly { readonly kind: AgentKind; readonly label: Bilingual }[] = [
  { kind: "market_brief", label: bilingual("Buy the XLM/USDC market report", "Comprar el informe de mercado XLM/USDC") },
  { kind: "ai_credits", label: bilingual("Buy 1000 AI credits", "Comprar 1000 créditos de IA") },
];
