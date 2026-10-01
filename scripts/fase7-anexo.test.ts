/**
 * The SEP annex (T125) quotes ids, names and codes from the code and from
 * `deployments/`. This keeps it honest: if a contract is redeployed, a handler
 * renamed or an error code renumbered, this fails until the annex says so.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AGENTPAY_MANDATE_TYP } from "../packages/mandate/src/sign.js";
import { RECEIPT_TYPE } from "../packages/vitrinee-core/src/receipt.js";
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
} from "../packages/vitrinee-core/src/ucp.js";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const annex = read("../docs/fase-7-estandar-comercio-agentico/ANEXO-SEP.md");

interface Deployed {
  contractId: string;
  wasmHash: string;
  perTx?: string;
  perDay?: string;
}
const agentpey = JSON.parse(read("../deployments/testnet.json")) as Record<string, Deployed>;
const vitrinee = JSON.parse(read("../deployments/vitrinee-testnet.json")) as {
  usdc: { issuer: string; contractId: string };
  facilitator: { url: string };
  receiptRegistry: Deployed;
};

describe("the SEP annex agrees with the code and the deployments (T125)", () => {
  it("names every deployed contract with its id and wasm hash", () => {
    for (const key of ["agentRegistry", "policyRail", "policyRailUcp"]) {
      const deployed = agentpey[key];
      expect(deployed, key).toBeDefined();
      expect(annex).toContain(deployed?.contractId);
      expect(annex).toContain(deployed?.wasmHash);
    }
    expect(annex).toContain(vitrinee.receiptRegistry.contractId);
    expect(annex).toContain(vitrinee.receiptRegistry.wasmHash);
    expect(annex).toContain(vitrinee.usdc.contractId);
    expect(annex).toContain(vitrinee.usdc.issuer);
    expect(annex).toContain(vitrinee.facilitator.url);
  });

  it("states each rail's limits as deployed", () => {
    expect(annex).toContain(`${agentpey["policyRail"]?.perTx} por compra, ${agentpey["policyRail"]?.perDay} por día`);
    expect(annex).toContain(`${agentpey["policyRailUcp"]?.perTx} por compra, ${agentpey["policyRailUcp"]?.perDay} por día`);
  });

  it("uses the handler's and the receipt extension's real names, versions and URLs", () => {
    for (const value of [
      UCP_VERSION,
      STELLAR_X402_HANDLER,
      STELLAR_X402_HANDLER_ID,
      STELLAR_X402_HANDLER_VERSION,
      STELLAR_X402_INSTRUMENT_TYPE,
      STELLAR_X402_SPEC_URL,
      STELLAR_X402_SCHEMA_URL,
      RECEIPT_EXTENSION,
      RECEIPT_EXTENSION_SCHEMA_URL,
    ]) {
      expect(annex).toContain(value);
    }
  });

  it("quotes the receipt and mandate types the code signs", () => {
    expect(annex).toContain(`"${RECEIPT_TYPE}"`);
    expect(annex).toContain(`typ: "${AGENTPAY_MANDATE_TYP}"`);
  });

  it("numbers the policy_rail errors as the contract does", () => {
    const source = read("../contracts/policy-rail/src/lib.rs");
    const codes = [...source.matchAll(/^\s+([A-Z][A-Za-z]+) = (\d+),/gm)].map(([, name, code]) => `\`${name}\` = ${code}`);
    expect(codes.length).toBeGreaterThanOrEqual(9);
    for (const code of codes) expect(annex).toContain(code);
  });
});
