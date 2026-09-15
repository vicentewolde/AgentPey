/**
 * The pure half of the F9 acceptance suite (T85): argument parsing, a cookie
 * jar, reading RealOps' HTML, and the vocabulary a case uses to say what it
 * expected and what it saw.
 *
 * Kept apart from `scripts/f9-acceptance.ts` so it can be unit-tested without
 * a network. Everything here is deliberately dumb: the suite's value is in
 * talking to the deployed services, and a clever helper would be one more
 * place for a wrong assumption to hide.
 */
import { AgentPassError } from "@agentpass/core";

/**
 * One persona per group of cases, each with its own RealOps account, tenant
 * and wallet. Separate on purpose: RealOps picks "the signed agent of this
 * kind" per account, so two scenarios sharing an account would read each
 * other's Mandate.
 */
export const PERSONAS = ["A", "B", "C", "D", "E", "F"] as const;
export type PersonaId = (typeof PERSONAS)[number];

/** `day2` needs a Mandate signed at least a day earlier by `day1`'s persona F. */
export const PHASES = ["day1", "day2"] as const;
export type Phase = (typeof PHASES)[number];

export interface AcceptanceArgs {
  readonly phase: Phase;
  /** `null` runs every persona of the phase. */
  readonly only: readonly PersonaId[] | null;
}

function invalid(message: string, details: Record<string, unknown>): AgentPassError {
  return new AgentPassError("InvalidArguments", message, { details });
}

function isPersonaId(value: string): value is PersonaId {
  return (PERSONAS as readonly string[]).includes(value);
}

function isPhase(value: string): value is Phase {
  return (PHASES as readonly string[]).includes(value);
}

/**
 * `--phase=day1|day2` and `--only=A,C`. A bare `--` (what `pnpm run x -- …`
 * may forward) is ignored; anything else unknown is refused rather than
 * silently running the whole suite, which spends sponsored rails.
 */
export function parseAcceptanceArgs(argv: readonly string[]): AcceptanceArgs {
  let phase: Phase = "day1";
  let only: PersonaId[] | null = null;

  for (const arg of argv) {
    if (arg === "--") continue;
    const separator = arg.indexOf("=");
    const flag = separator < 0 ? arg : arg.slice(0, separator);
    const value = separator < 0 ? "" : arg.slice(separator + 1);

    if (flag === "--phase") {
      if (!isPhase(value)) throw invalid(`--phase must be one of ${PHASES.join(", ")}`, { value });
      phase = value;
    } else if (flag === "--only") {
      const ids = value
        .split(",")
        .map((id) => id.trim().toUpperCase())
        .filter((id) => id !== "");
      const unknown = ids.filter((id) => !isPersonaId(id));
      if (ids.length === 0 || unknown.length > 0) {
        throw invalid(`--only takes a comma-separated list of ${PERSONAS.join(", ")}`, { value, unknown });
      }
      only = ids.filter(isPersonaId);
    } else {
      throw invalid(`unknown argument "${arg}"`, { arg });
    }
  }

  return { phase, only };
}

/** Just enough of a browser's cookie store to hold one RealOps session. */
export interface CookieJar {
  absorb(setCookieHeaders: readonly string[]): void;
  header(): string | undefined;
  clear(): void;
}

export function createCookieJar(): CookieJar {
  const cookies = new Map<string, string>();
  return {
    absorb(lines) {
      for (const line of lines) {
        const [pair = "", ...attributes] = line.split(";");
        const separator = pair.indexOf("=");
        if (separator <= 0) continue;
        const name = pair.slice(0, separator).trim();
        const value = pair.slice(separator + 1).trim();
        // RealOps signs out by sending the cookie back empty with `Max-Age=0`.
        const expired = attributes.some((attribute) => /^\s*max-age\s*=\s*0\s*$/i.test(attribute));
        if (value === "" || expired) cookies.delete(name);
        else cookies.set(name, value);
      }
    },
    header() {
      return cookies.size === 0 ? undefined : [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    },
    clear() {
      cookies.clear();
    },
  };
}

const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
};

export function unescapeHtml(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|#39|#x27);/g, (entity) => ENTITIES[entity] ?? entity);
}

function capture(html: string, pattern: RegExp): string | undefined {
  const value = pattern.exec(html)?.[1];
  return value === undefined ? undefined : unescapeHtml(value);
}

/** The per-form idempotency key of the purchase form (`C-106`). */
export function readRequestKey(html: string): string | undefined {
  return capture(html, /name="request_key" value="([^"]+)"/);
}

/** What the agent's review screen says once RealOps stored the Mandate. */
export function readSignedMandateId(html: string): string | undefined {
  return capture(html, /<code data-mandate-id>(mdt_[0-9A-Z]+)<\/code>/);
}

/** The opaque reference "Mis servicios" shows — what AgentPey knows the account as. */
export function readExternalRef(html: string): string | undefined {
  return capture(html, /<code>(rop_[0-9A-Z]+)<\/code>/);
}

export function agentIdFromLocation(location: string | undefined): string | undefined {
  return /\/agentes\/(rag_[0-9A-Z]+)$/.exec(location ?? "")?.[1];
}

/** `https://…/consent/{id}` → `{id}`. */
export function consentSessionIdFromUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return /^\/consent\/([^/]+)$/.exec(new URL(url).pathname)?.[1];
  } catch {
    return undefined;
  }
}

/** Whether a page shows a sentence, compared as text rather than as escaped markup. */
export function pageSays(html: string, sentence: string): boolean {
  return unescapeHtml(html).includes(sentence);
}

export type CheckStatus = "pass" | "fail" | "declared";

export interface Check {
  readonly name: string;
  readonly status: CheckStatus;
  readonly expected: string;
  readonly observed: string;
}

/** A refusal code that must be one of `accepted`. `null` — no refusal at all — always fails. */
export function checkCode(name: string, observed: string | null | undefined, accepted: readonly string[]): Check {
  return {
    name,
    status: observed !== null && observed !== undefined && accepted.includes(observed) ? "pass" : "fail",
    expected: accepted.join(" | "),
    observed: observed ?? "(ninguno)",
  };
}

export function checkThat(name: string, holds: boolean, expected: string, observed: string): Check {
  return { name, status: holds ? "pass" : "fail", expected, observed };
}

/**
 * A part of a case that cannot be forced against public services without a
 * failure switch in them — refused as an option in T84 — so its evidence is
 * the tests named here, and the run says so instead of pretending.
 */
export function declared(name: string, evidence: string): Check {
  return { name, status: "declared", expected: "no forzable contra los servicios públicos", observed: evidence };
}

export interface Tally {
  readonly pass: number;
  readonly fail: number;
  readonly declared: number;
}

export function tally(checks: readonly Check[]): Tally {
  return {
    pass: checks.filter((check) => check.status === "pass").length,
    fail: checks.filter((check) => check.status === "fail").length,
    declared: checks.filter((check) => check.status === "declared").length,
  };
}

/** A throwaway address on a reserved domain (RFC 6761): nobody receives mail there. */
export function personaEmail(runId: string, persona: PersonaId): string {
  return `t85-${runId.toLowerCase()}-${persona.toLowerCase()}@example.test`;
}

/**
 * Removes every secret from a serialised evidence file before it is written.
 *
 * Defence in depth: nothing in the suite should put a secret into evidence in
 * the first place, but an error's `details` can carry a request, and a
 * request carries an `authorization` header.
 */
export function redact(serialised: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length >= 8)
    .reduce((text, secret) => text.split(secret).join("[redactado]"), serialised);
}
