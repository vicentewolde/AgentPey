/**
 * The pure half of `pnpm run arbiter:console` (T155, `R-34`): what the page may
 * send, what the commands print and who may talk to the local server. No I/O
 * here, so each rule has a test.
 *
 * The console is a window on the three arbiter commands (`resolve:open`,
 * `resolve:decide`, `resolve:execute`); it decides nothing and holds no key.
 */
import { timingSafeEqual } from "node:crypto";

import { AgentPassError } from "@agentpass/core";
import { z } from "zod";

/** A claim is a compact JWS of a few KB; anything near this is not one. */
export const MAX_CLAIM_BYTES = 20_000;
/** A signed merchant response is under 2 KB; this leaves room for long statements. */
export const MAX_RESPONSE_BYTES = 40_000;

const HASH = /^[0-9a-f]{64}$/;
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function invalid(message: string, details: Record<string, unknown> = {}): AgentPassError {
  return new AgentPassError("InvalidArguments", message, { details });
}

export function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH.test(value);
}

const claimPayload = z.object({
  type: z.literal("AgentResolveClaim"),
  claimId: z.string().min(1),
  receipt: z.object({ hash: z.string().regex(HASH) }),
});

export interface ParsedClaim {
  /** The claim exactly as signed, without surrounding whitespace. */
  readonly jws: string;
  /** The receipt it is about: the key of the whole dispute. */
  readonly receiptHash: string;
}

/**
 * Reads what the person pasted from the chat. It only checks the shape and
 * names the receipt; the signature, the window and who paid are the arbiter's
 * job (`resolve:open` does them, and refuses what fails).
 */
export function parseClaim(input: string): ParsedClaim {
  const jws = input.replace(/\s+/g, "");
  if (jws === "") throw invalid("Pega el reclamo que te dio Claude (el texto largo que empieza con eyJ)");
  if (Buffer.byteLength(jws) > MAX_CLAIM_BYTES) throw invalid("Ese texto es demasiado largo para ser un reclamo", { bytes: Buffer.byteLength(jws) });
  if (!COMPACT_JWS.test(jws)) throw invalid("Eso no es un reclamo: debe tener tres partes separadas por puntos");
  const payloadPart = jws.split(".")[1] ?? "";
  let parsed: ReturnType<typeof claimPayload.safeParse>;
  try {
    parsed = claimPayload.safeParse(JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")));
  } catch {
    throw invalid("Eso no es un reclamo: no se puede leer su contenido");
  }
  if (!parsed.success) throw invalid("Eso no es un reclamo de AgentResolve");
  return { jws, receiptHash: parsed.data.receipt.hash };
}

const responseFile = z.object({
  response: z.looseObject({ type: z.literal("AgentResolveResponse"), receiptHash: z.string().regex(HASH) }),
  signature: z.unknown(),
});

/**
 * Checks that a downloaded file is a merchant response for this dispute and
 * returns it to be written as is. Who signed it is checked by the arbiter.
 */
export function parseResponseFile(text: string, expectedReceiptHash: string): string {
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw invalid("Ese archivo es demasiado grande para ser la respuesta de una tienda");
  let parsed: ReturnType<typeof responseFile.safeParse>;
  try {
    parsed = responseFile.safeParse(JSON.parse(text));
  } catch {
    throw invalid("Ese archivo no es la respuesta de una tienda: no es JSON");
  }
  if (!parsed.success) throw invalid("Ese archivo no es una respuesta de agentpey.com/resolve/responder");
  if (parsed.data.response.receiptHash !== expectedReceiptHash) {
    throw invalid("Esa respuesta es de otra compra", { expected: expectedReceiptHash, got: parsed.data.response.receiptHash });
  }
  return text;
}

/** The newest `agentresolve-response-*.json` among the given names, or null. */
export function newestResponseName(names: readonly { readonly name: string; readonly mtimeMs: number }[]): string | null {
  const matches = names.filter((entry) => /^agentresolve-response-[0-9a-f]+(?: \(\d+\))?\.json$/.test(entry.name));
  const [first] = [...matches].sort((a, b) => b.mtimeMs - a.mtimeMs);
  return first?.name ?? null;
}

// ---------------------------------------------------------------------------
// What the commands print
// ---------------------------------------------------------------------------

export type Tone = "ok" | "bad" | "plain";

export interface OutputRow {
  readonly tone: Tone;
  /** Empty for a line of free text. */
  readonly label: string;
  readonly value: string;
}

export interface OutputSection {
  readonly heading: string;
  readonly rows: readonly OutputRow[];
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
/** Sections whose lines are prose, not `label   value` pairs. */
const PROSE = /^(Razonamiento|Hechos)$/;

/** Drops the colour codes and the `pnpm`/`tsx` echo, then groups what is left under its headings. */
export function parseCliOutput(raw: string): { readonly title: string; readonly sections: readonly OutputSection[] } {
  const lines = raw
    .replace(ANSI, "")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => !/^\$ /.test(line) && !/^\[ELIFECYCLE\]/.test(line));

  let title = "";
  const sections: { heading: string; rows: OutputRow[] }[] = [];
  let current: { heading: string; rows: OutputRow[] } | null = null;

  for (const line of lines) {
    if (line.trim() === "") continue;
    if (!line.startsWith(" ")) {
      if (title === "" && current === null && !line.startsWith("[")) {
        title = line;
        continue;
      }
      current = { heading: line, rows: [] };
      sections.push(current);
      continue;
    }
    if (current === null) {
      current = { heading: "", rows: [] };
      sections.push(current);
    }
    const prose = PROSE.test(current.heading);
    const check = /^\s+(✅|❌)\s+(\S+(?: \S+)?)\s{2,}(.+)$/.exec(line);
    if (check !== null) {
      current.rows.push({ tone: check[1] === "✅" ? "ok" : "bad", label: check[2] ?? "", value: check[3] ?? "" });
      continue;
    }
    const pair = prose ? null : /^\s{2}(\S.{0,22}?)\s{2,}(\S.*)$/.exec(line);
    if (pair !== null) {
      current.rows.push({ tone: "plain", label: pair[1] ?? "", value: pair[2] ?? "" });
      continue;
    }
    current.rows.push({ tone: "plain", label: "", value: line.trim() });
  }
  return { title, sections };
}

/** The first `https://stellar.expert/...` link in what a command printed. */
export function firstExplorerUrl(output: string): string | null {
  return /https:\/\/stellar\.expert\/explorer\/testnet\/[A-Za-z0-9/_-]+/.exec(output)?.[0] ?? null;
}

/** The hash a person must type to confirm a verdict (`E-18`). */
export function verdictHashOf(output: string): string | null {
  const match = /Hash del veredicto\s+sha256\s+([0-9a-f]{64})/.exec(output.replace(ANSI, ""));
  return match?.[1] ?? null;
}

export interface VerdictSummary {
  /** `refund_full`, `refund_partial`, `reject`... exactly as the command printed it. */
  readonly outcome: string;
  readonly refund: string;
  readonly reasoning: string;
  readonly hash: string;
}

/** What the page shows big once the arbiter has decided. Null when the output is not a verdict. */
export function summarizeVerdict(output: string): VerdictSummary | null {
  const text = output.replace(ANSI, "");
  const hash = verdictHashOf(text);
  const outcome = /^\s+resultado\s+(\S+)/m.exec(text)?.[1];
  const refund = /^\s+reembolso\s+(.+)$/m.exec(text)?.[1]?.trim();
  if (hash === null || outcome === undefined || refund === undefined) return null;
  const reasoning = /Razonamiento\n([\s\S]*?)\n\s*\nHechos/.exec(text)?.[1] ?? "";
  const paragraphs = reasoning
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.split("\n").map((line) => line.trim()).join(" ").trim())
    .filter((paragraph) => paragraph !== "");
  return { outcome, refund, reasoning: paragraphs.join("\n\n"), hash };
}

/** The verdict's outcome as a person reads it; an unknown outcome is shown as the command printed it. */
export function outcomeLabel(outcome: string): string {
  switch (outcome) {
    case "refund_full":
      return "Reembolso completo";
    case "refund_partial":
      return "Reembolso parcial";
    case "rejected":
      return "Reclamo rechazado";
    default:
      return outcome;
  }
}

/** Why a command failed, from what it wrote to stderr: its typed code and message, or its last line. */
export function failureOf(stderr: string): { readonly message: string; readonly detail: string } {
  const text = stderr.replace(ANSI, "").trim();
  const typed = /^([A-Za-z]+): (.+)$/m.exec(text);
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  return {
    message: typed !== null ? `${typed[1] ?? ""}: ${typed[2] ?? ""}` : (lines.at(-1) ?? "el comando falló sin decir por qué"),
    detail: lines.slice(-14).join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Who may talk to the server
// ---------------------------------------------------------------------------

/**
 * The server moves funds, so it answers only the page it served: the Host must
 * be this machine on this port (a page on another site pointed at 127.0.0.1
 * through DNS rebinding arrives with another Host), a browser's Origin, when it
 * sends one, must be that same address, and the API key printed at startup must
 * come with the request.
 */
export function checkAccess(input: {
  readonly host: string | undefined;
  readonly origin: string | undefined;
  readonly key: string | undefined;
  readonly expectedKey: string;
  readonly port: number;
}): void {
  const allowedHosts = [`127.0.0.1:${input.port}`, `localhost:${input.port}`];
  if (input.host === undefined || !allowedHosts.includes(input.host)) {
    throw new AgentPassError("ConfigError", "Esta pantalla responde solo en este computador", { details: { host: input.host ?? null } });
  }
  if (input.origin !== undefined && !allowedHosts.some((host) => input.origin === `http://${host}`)) {
    throw new AgentPassError("ConfigError", "Esta pantalla no responde a pedidos de otros sitios", { details: { origin: input.origin } });
  }
  const given = Buffer.from(input.key ?? "");
  const wanted = Buffer.from(input.expectedKey);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    throw new AgentPassError("ConfigError", "Falta la clave de la pantalla o es incorrecta: abre la dirección que imprimió el comando");
  }
}
