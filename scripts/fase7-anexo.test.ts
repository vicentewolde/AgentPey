/**
 * The SEP annex (T125) quotes formats, ids, names and codes from the code and
 * from `deployments/`. This keeps it honest: if a contract is redeployed, a
 * schema changes, a function moves or a code is renumbered, this fails until
 * the annex says so.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AGENTPAY_MANDATE_TYP } from "../packages/mandate/src/sign.js";
import { RECEIPT_TYPE, receiptClaimsSchema } from "../packages/vitrinee-core/src/receipt.js";
import {
  RECEIPT_EXTENSION,
  RECEIPT_EXTENSION_SCHEMA_URL,
  STELLAR_X402_HANDLER,
  STELLAR_X402_HANDLER_ID,
  STELLAR_X402_HANDLER_VERSION,
  STELLAR_X402_INSTRUMENT_TYPE,
  STELLAR_X402_SCHEMA_URL,
  STELLAR_X402_SPEC_URL,
  UCP_VERSION,
  stellarX402BusinessConfigSchema,
} from "../packages/vitrinee-core/src/ucp.js";
import { stellarX402CredentialSchema } from "../packages/vitrinee-gateway/src/ucp/checkout.js";
import { storedRequirementsSchema } from "../packages/vitrinee-gateway/src/ucp/sessions.js";
import { deploymentSchema } from "./lib/deployment.js";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const annex = read("../docs/fase-7-estandar-comercio-agentico/ANEXO-SEP.md");

const agentpey = deploymentSchema.parse(JSON.parse(read("../deployments/testnet.json")));
const vitrinee = z
  .object({
    usdc: z.object({ issuer: z.string(), contractId: z.string() }),
    facilitator: z.object({ url: z.string() }),
    receiptRegistry: z.object({ contractId: z.string(), wasmHash: z.string() }),
  })
  .parse(JSON.parse(read("../deployments/vitrinee-testnet.json")));

const A_PAYEE = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

/** The first ```json block after `heading`, parsed. */
function jsonAfter(heading: string): unknown {
  const at = annex.indexOf(heading);
  expect(at, heading).toBeGreaterThan(-1);
  const block = /```json\n([\s\S]*?)\n```/.exec(annex.slice(at));
  if (block?.[1] === undefined) throw new TypeError(`no JSON block after ${heading}`);
  return JSON.parse(block[1].replaceAll('"G…"', `"${A_PAYEE}"`));
}

/** The table row that starts with `label`. */
function row(label: string): string {
  const line = annex.split("\n").find((candidate) => candidate.startsWith(`| ${label} |`));
  if (line === undefined) throw new TypeError(`no table row for ${label}`);
  return line;
}

/** The members of a string-literal union type, read from its source file. */
function unionMembers(path: string, typeName: string): string[] {
  const source = read(path);
  const body = new RegExp(`export type ${typeName} =([\\s\\S]*?);`).exec(source)?.[1];
  if (body === undefined) throw new TypeError(`${typeName} not found in ${path}`);
  return [...body.matchAll(/"([A-Za-z]+)"/g)].map(([, name]) => name ?? "");
}

describe("the SEP annex agrees with the code and the deployments (T125)", () => {
  it("puts each deployed contract, its wasm and its limits in its own row", () => {
    const shared = agentpey.policyRail;
    const ucp = agentpey.policyRailUcp;
    if (agentpey.agentRegistry === null || shared === null || ucp === null) throw new TypeError("a deployment is missing");
    expect(row("`agent-registry`")).toContain(agentpey.agentRegistry.contractId);
    expect(row("`agent-registry`")).toContain(agentpey.agentRegistry.wasmHash);
    for (const [label, rail] of [["`policy_rail` compartido", shared], ["`policy_rail` UCP", ucp]] as const) {
      expect(row(label)).toContain(rail.contractId);
      expect(row(label)).toContain(rail.wasmHash);
      expect(row(label)).toContain(`${rail.perTx} por compra, ${rail.perDay} por día`);
    }
    expect(row("`receipt-registry`")).toContain(vitrinee.receiptRegistry.contractId);
    expect(row("`receipt-registry`")).toContain(vitrinee.receiptRegistry.wasmHash);
    expect(row("USDC (SAC)")).toContain(vitrinee.usdc.contractId);
    expect(row("USDC (SAC)")).toContain(vitrinee.usdc.issuer);
    expect(annex).toContain(vitrinee.facilitator.url);
  });

  it("gives the handler's real name, id, version, instrument and URLs, each in its row", () => {
    expect(row("Nombre")).toContain(`\`${STELLAR_X402_HANDLER}\``);
    expect(row("Id en el perfil")).toContain(`\`${STELLAR_X402_HANDLER_ID}\``);
    expect(row("Versión")).toContain(`\`${STELLAR_X402_HANDLER_VERSION}\``);
    expect(row("Tipo de instrumento")).toContain(`\`${STELLAR_X402_INSTRUMENT_TYPE}\``);
    expect(row("Spec")).toContain(STELLAR_X402_SPEC_URL);
    expect(row("Esquema")).toContain(STELLAR_X402_SCHEMA_URL);
    for (const value of [UCP_VERSION, RECEIPT_EXTENSION, RECEIPT_EXTENSION_SCHEMA_URL]) expect(annex).toContain(value);
  });

  it("shows a business config, payment requirements and a credential that the code's own schemas accept", () => {
    const declared = jsonAfter("### 2.1") as { config: unknown; id: string };
    expect(stellarX402BusinessConfigSchema.safeParse(declared.config).success).toBe(true);
    expect(declared.id).toBe(STELLAR_X402_HANDLER_ID);

    const resolved = jsonAfter("### 2.2") as { payment_requirements: unknown };
    const requirements = storedRequirementsSchema.parse(resolved.payment_requirements);

    const complete = jsonAfter("### 2.3") as { payment: { instruments: Array<{ credential: Record<string, unknown> }> } };
    const credential = complete.payment.instruments[0]?.credential;
    // The annex shows `accepted` as a placeholder ("the session's requirements, as they are").
    expect(stellarX402CredentialSchema.safeParse({ ...credential, accepted: requirements }).success).toBe(true);
  });

  it("lists exactly the receipt's fields", () => {
    const start = annex.indexOf("Cuerpo (`typ` fijo");
    const end = annex.indexOf("**Hash anclado:**");
    const table = annex.slice(start, end);
    const fields = [...table.matchAll(/^\| (`[^|]+`) \|/gm)].flatMap(([, cell]) =>
      [...(cell ?? "").matchAll(/`([A-Za-z]+)(?:\[\])?`/g)].map(([, name]) => name ?? ""),
    );
    expect(fields.sort()).toEqual(Object.keys(receiptClaimsSchema.shape).sort());
    expect(annex).toContain(`"${RECEIPT_TYPE}"`);
    expect(annex).toContain(`typ: "${AGENTPAY_MANDATE_TYP}"`);
  });

  it("cites only functions and schemas that exist where it says", () => {
    const cited: Array<[symbol: string, path: string]> = [
      ["receiptClaimsSchema", "packages/vitrinee-core/src/receipt.ts"],
      ["signReceipt", "packages/vitrinee-core/src/receipt.ts"],
      ["receiptHash", "packages/vitrinee-core/src/receipt.ts"],
      ["signJws", "packages/vitrinee-core/src/jws.ts"],
      ["verifyReceipt", "packages/vitrinee-anchor/src/verify.ts"],
      ["stellarX402BusinessConfigSchema", "packages/vitrinee-core/src/ucp.ts"],
      ["stellarX402CredentialSchema", "packages/vitrinee-gateway/src/ucp/checkout.ts"],
      ["handlerFor", "packages/vitrinee-gateway/src/ucp/checkout.ts"],
      ["complete", "packages/vitrinee-gateway/src/ucp/checkout.ts"],
      ["executeUcpPayment", "apps/agent/src/payment/ucp.ts"],
      ["originMatchesNamespace", "apps/agent/src/payment/ucp.ts"],
      ["toPaymentTerms", "apps/agent/src/payment/x402.ts"],
      ["agentPayMandateSchema", "packages/mandate/src/mandate.ts"],
      ["verifyMandate", "packages/mandate/src/sign.ts"],
      ["verifyMandateOnChain", "packages/mandate/src/anchor.ts"],
      ["verifyWalletSignedMandateOnChain", "packages/mandate/src/anchor.ts"],
      ["checkMandate", "apps/agent/src/mandate/check-mandate.ts"],
      ["reconcileTerms", "apps/agent/src/policy/terms.ts"],
      ["checkScope", "apps/agent/src/scope/scope.ts"],
      ["authorise", "apps/agent/src/policy/policy-rail.ts"],
      ["__check_auth", "contracts/policy-rail/src/lib.rs"],
      ["anchor", "contracts/receipt-registry/src/lib.rs"],
    ];
    for (const [symbol, path] of cited) {
      expect(annex, symbol).toContain(`\`${symbol}`);
      expect(annex, path).toContain(path);
      const definition = new RegExp(`(function|const|class|interface|type|fn)\\s+${symbol}\\b|async\\s+${symbol}\\(`);
      expect(read(`../${path}`), `${symbol} in ${path}`).toMatch(definition);
    }
  });

  it("names every rejection code the agent's checks can return", () => {
    const codes = [
      ...unionMembers("../apps/agent/src/policy/terms.ts", "TermsRejectionCode"),
      ...unionMembers("../apps/agent/src/scope/scope.ts", "ScopeRejectionCode"),
      ...unionMembers("../apps/agent/src/mandate/check-mandate.ts", "MandateRejectionCode"),
      "ScopeDailyLimitExceeded",
      "MandateDailyLimitExceeded",
    ];
    expect(codes.length).toBeGreaterThan(15);
    for (const code of codes) expect(annex, code).toContain(`\`${code}\``);
  });

  it("numbers the policy_rail errors as the contract does", () => {
    const source = read("../contracts/policy-rail/src/lib.rs");
    const codes = [...source.matchAll(/^\s+([A-Z][A-Za-z]+) = (\d+),/gm)].map(([, name, code]) => `\`${name}\` = ${code}`);
    expect(codes.length).toBeGreaterThanOrEqual(9);
    for (const code of codes) expect(annex).toContain(code);
  });
});
