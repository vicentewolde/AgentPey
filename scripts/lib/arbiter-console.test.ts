import { describe, expect, it } from "vitest";

import {
  checkAccess,
  firstExplorerUrl,
  failureOf,
  isHash,
  newestResponseName,
  outcomeLabel,
  parseClaim,
  parseCliOutput,
  parseResponseFile,
  summarizeVerdict,
  verdictHashOf,
} from "./arbiter-console.js";

const RECEIPT = "62aaeddaf2caaa5ba247736490d0318fed71a4abec14ae5cd1538e784897faca";
const VERDICT = "ac618810c3dec4af6d478758f370acb568bee115b5164ff5a6e176dcf030ca27";

function jws(payload: unknown): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "EdDSA" })}.${part(payload)}.c2lnbmF0dXJl`;
}
const claim = jws({ type: "AgentResolveClaim", claimId: "00f72ce7-9f7e-479c-a911-6307ca1ec916", receipt: { hash: RECEIPT } });

describe("parseClaim", () => {
  it("names the receipt a claim is about and ignores the line breaks of a copied code block", () => {
    const wrapped = `${claim.slice(0, 40)}\n  ${claim.slice(40)}\n`;
    expect(parseClaim(wrapped)).toEqual({ jws: claim, receiptHash: RECEIPT });
  });

  it("refuses what is not a claim, with a message a person can read", () => {
    expect(() => parseClaim("")).toThrow(/Pega el reclamo/);
    expect(() => parseClaim("hola")).toThrow(/tres partes/);
    expect(() => parseClaim("a.b.c")).toThrow(/no se puede leer su contenido/);
    expect(() => parseClaim(jws({ type: "Something", receipt: { hash: RECEIPT } }))).toThrow(/no es un reclamo de AgentResolve/);
    expect(() => parseClaim(jws({ type: "AgentResolveClaim", claimId: "x", receipt: { hash: "nope" } }))).toThrow(/no es un reclamo de AgentResolve/);
    expect(() => parseClaim("a".repeat(30_000))).toThrow(/demasiado largo/);
  });

  it("throws typed errors", () => {
    try {
      parseClaim("hola");
      expect.unreachable();
    } catch (error) {
      expect((error as { code?: string }).code).toBe("InvalidArguments");
    }
  });
});

describe("parseResponseFile", () => {
  const file = (receiptHash: string): string =>
    JSON.stringify({ response: { type: "AgentResolveResponse", receiptHash, position: "accept_full" }, signature: { value: "x" } });

  it("accepts a response for this purchase, untouched", () => {
    expect(parseResponseFile(file(RECEIPT), RECEIPT)).toBe(file(RECEIPT));
  });

  it("refuses another purchase's response, a claim and plain text", () => {
    expect(() => parseResponseFile(file("0".repeat(64)), RECEIPT)).toThrow(/de otra compra/);
    expect(() => parseResponseFile(claim, RECEIPT)).toThrow(/no es JSON/);
    expect(() => parseResponseFile(JSON.stringify({ hello: 1 }), RECEIPT)).toThrow(/no es una respuesta de agentpey/);
    expect(() => parseResponseFile("x".repeat(50_000), RECEIPT)).toThrow(/demasiado grande/);
  });
});

describe("newestResponseName", () => {
  it("picks the newest downloaded response and nothing else", () => {
    const names = [
      { name: "agentresolve-response-aaaa.json", mtimeMs: 10 },
      { name: "agentresolve-response-bbbb (1).json", mtimeMs: 30 },
      { name: "notes.json", mtimeMs: 99 },
      { name: "agentresolve-response-cccc.json", mtimeMs: 20 },
    ];
    expect(newestResponseName(names)).toBe("agentresolve-response-bbbb (1).json");
    expect(newestResponseName([{ name: "notes.json", mtimeMs: 1 }])).toBeNull();
    expect(newestResponseName([])).toBeNull();
  });
});

const OPEN_OUTPUT = `$ tsx --tsconfig tsconfig.scripts.json scripts/resolve.ts open -- --claim x.jws

AgentResolve · abrir un reclamo · testnet

[comprador] reclamo ya firmado
  recibo         ${RECEIPT}
  pide           0.5157895 USDC

[árbitro] verifica y abre la disputa en el contrato
  ✅ recibo       firma del comercio, anclado en receipt-registry, pago confirmado en Horizon
  ✅ firmante     controla al pagador CB4WVTJ4
  tx             https://stellar.expert/explorer/testnet/tx/b4685a625b05d2863de084491609a1067368b0b323bf05d3eb3ee37640e67f7f
  disputa        Open, 0.5157895 USDC bloqueados en la garantía de GAPCCUMM
`;

describe("parseCliOutput", () => {
  it("drops the command echo, keeps the title and groups rows under their headings", () => {
    const { title, sections } = parseCliOutput(OPEN_OUTPUT);
    expect(title).toBe("AgentResolve · abrir un reclamo · testnet");
    expect(sections.map((section) => section.heading)).toEqual(["[comprador] reclamo ya firmado", "[árbitro] verifica y abre la disputa en el contrato"]);
    expect(sections[0]?.rows[1]).toEqual({ tone: "plain", label: "pide", value: "0.5157895 USDC" });
    expect(sections[1]?.rows[0]).toMatchObject({ tone: "ok", label: "recibo" });
    expect(sections[1]?.rows[2]).toMatchObject({ tone: "plain", label: "tx" });
  });

  it("marks a failed check as bad and strips colour codes", () => {
    const { sections } = parseCliOutput("Título\n[árbitro] x\n  \u001b[31m❌ plazo\u001b[0m       venció\n");
    expect(sections[0]?.rows[0]).toEqual({ tone: "bad", label: "plazo", value: "venció" });
  });
});

describe("explorer link and verdict hash", () => {
  it("finds the first explorer link", () => {
    expect(firstExplorerUrl(OPEN_OUTPUT)).toBe("https://stellar.expert/explorer/testnet/tx/b4685a625b05d2863de084491609a1067368b0b323bf05d3eb3ee37640e67f7f");
    expect(firstExplorerUrl("nothing")).toBeNull();
  });

  it("isHash accepts 64 lowercase hex characters only", () => {
    expect(isHash(VERDICT)).toBe(true);
    expect(isHash(VERDICT.toUpperCase())).toBe(false);
    expect(isHash(VERDICT.slice(1))).toBe(false);
    expect(isHash(undefined)).toBe(false);
  });
});

const DECIDE_OUTPUT = `AgentResolve · veredicto · testnet
  ✅ respuesta    accept_full, firmada por GD2MCESI
  árbitro        claude-opus-5-5 (esfuerzo high)
  veredicto n.º  1
  resultado      refund_full
  reembolso      0.5157895 USDC de 0.5157895 USDC en disputa

Razonamiento
  El reclamo dice que el imán no se entregó porque la tienda no tenía stock.
  El producto y el monto coinciden con el recibo verificado.

  El comercio respondió con su firma y aceptó devolver el monto completo.

Hechos
  - El recibo registra 1 unidad por 0,5157895 USDC.

Hash del veredicto
  sha256         ${VERDICT}

Nada se pagó. Para confirmar y pagar (E-18), una persona corre:
  pnpm run resolve:execute -- --receipt x --confirm ${VERDICT}
`;

describe("summarizeVerdict", () => {
  it("reads the outcome, the refund, the reasoning in paragraphs and the hash to confirm", () => {
    const verdict = summarizeVerdict(DECIDE_OUTPUT);
    expect(verdict).not.toBeNull();
    expect(verdict?.outcome).toBe("refund_full");
    expect(verdict?.refund).toBe("0.5157895 USDC de 0.5157895 USDC en disputa");
    expect(verdict?.hash).toBe(VERDICT);
    expect(verdict?.reasoning.split("\n\n")).toEqual([
      "El reclamo dice que el imán no se entregó porque la tienda no tenía stock. El producto y el monto coinciden con el recibo verificado.",
      "El comercio respondió con su firma y aceptó devolver el monto completo.",
    ]);
  });

  it("is null when the output is not a verdict", () => {
    expect(summarizeVerdict(OPEN_OUTPUT)).toBeNull();
    expect(verdictHashOf("Hash del veredicto\n  sha256         abc")).toBeNull();
  });

  it("keeps the confirmation line out of the hash", () => {
    expect(verdictHashOf(DECIDE_OUTPUT)).toBe(VERDICT);
  });
});

describe("checkAccess", () => {
  const base = { host: "127.0.0.1:4747", origin: undefined, key: "secret-key", expectedKey: "secret-key", port: 4747 } as const;

  it("lets the page we served through, with or without an Origin", () => {
    expect(() => checkAccess(base)).not.toThrow();
    expect(() => checkAccess({ ...base, host: "localhost:4747", origin: "http://localhost:4747" })).not.toThrow();
  });

  it("refuses another Host (DNS rebinding), another Origin and a missing or wrong key", () => {
    expect(() => checkAccess({ ...base, host: "evil.example:4747" })).toThrow(/solo en este computador/);
    expect(() => checkAccess({ ...base, host: undefined })).toThrow(/solo en este computador/);
    expect(() => checkAccess({ ...base, host: "127.0.0.1:9999" })).toThrow(/solo en este computador/);
    expect(() => checkAccess({ ...base, origin: "https://evil.example" })).toThrow(/otros sitios/);
    expect(() => checkAccess({ ...base, key: undefined })).toThrow(/clave/);
    expect(() => checkAccess({ ...base, key: "secret-kez" })).toThrow(/clave/);
    expect(() => checkAccess({ ...base, key: "secret" })).toThrow(/clave/);
  });
});

describe("outcomeLabel and failureOf", () => {
  it("names the three outcomes and passes an unknown one through", () => {
    expect(outcomeLabel("refund_full")).toBe("Reembolso completo");
    expect(outcomeLabel("refund_partial")).toBe("Reembolso parcial");
    expect(outcomeLabel("rejected")).toBe("Reclamo rechazado");
    expect(outcomeLabel("something_new")).toBe("something_new");
  });

  it("reads a typed failure from stderr, with its details", () => {
    const stderr = '\nResolveClaimWindowClosed: the receipt\'s refund window has closed\n{\n  "refundWindowEndsAt": "2026-10-01"\n}\n';
    const failure = failureOf(stderr);
    expect(failure.message).toBe("ResolveClaimWindowClosed: the receipt's refund window has closed");
    expect(failure.detail).toContain("refundWindowEndsAt");
    expect(failureOf("").message).toBe("el comando falló sin decir por qué");
  });
});
