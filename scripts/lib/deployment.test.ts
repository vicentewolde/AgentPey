import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hasErrorCode } from "@agentpass/core";
import { describe, expect, it } from "vitest";

import type { Deployment } from "./deployment.js";
import { EMPTY_DEPLOYMENT, readDeployment, writeDeployment } from "./deployment.js";

const VALID: Deployment = {
  ...EMPTY_DEPLOYMENT,
  protocolVersion: 28,
  agentRegistry: {
    contractId: "CARC2SIQ3GTL34LVHSTGFRKDNNBYUXCSMGAUGKWGMT6Z2SDY6FXPP2DT",
    wasmHash: "b2ff9231f27555c1cfd94e6d480529a5cf316736c969410aad3c57a8953cf151",
    admin: "GARBTKFQEX325HDOWL3KQT7PDCENLOYMXF7D6B6SB54LDKCHCRYFUY2K",
    schemaVersion: 1,
    deployedAt: "2026-09-02T03:15:48.276Z",
    protocolVersion: 28,
  },
};

async function tempFile(contents?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agentpass-deployment-"));
  const path = join(dir, "testnet.json");
  if (contents !== undefined) await writeFile(path, contents, "utf8");
  return path;
}

describe("readDeployment", () => {
  it("treats a missing file as an empty deployment, not a failure", async () => {
    await expect(readDeployment(await tempFile())).resolves.toEqual(EMPTY_DEPLOYMENT);
  });

  it("round-trips a written record", async () => {
    const path = await tempFile();
    await writeDeployment(path, VALID);

    await expect(readDeployment(path)).resolves.toEqual(VALID);
  });

  it("rejects invalid JSON with ConfigError", async () => {
    const path = await tempFile("{ not json");

    await expect(readDeployment(path)).rejects.toSatisfy((error: unknown) =>
      hasErrorCode(error, "ConfigError"),
    );
  });

  it("rejects a record whose contract id is not a contract id", async () => {
    const path = await tempFile(
      JSON.stringify({
        ...VALID,
        agentRegistry: { ...VALID.agentRegistry, contractId: VALID.agentRegistry?.admin },
      }),
    );

    await expect(readDeployment(path)).rejects.toSatisfy((error: unknown) =>
      hasErrorCode(error, "ConfigError"),
    );
  });

  it("rejects a wasm hash that is not 64 hex characters", async () => {
    const path = await tempFile(
      JSON.stringify({ ...VALID, agentRegistry: { ...VALID.agentRegistry, wasmHash: "abc" } }),
    );

    await expect(readDeployment(path)).rejects.toSatisfy((error: unknown) =>
      hasErrorCode(error, "ConfigError"),
    );
  });

  it("reads a rail recorded before T57 added `principal`, as a null principal", async () => {
    // The shared pilot rail predates the constructor that takes a principal,
    // and this hito deliberately does not redeploy it. Reading its record has
    // to keep working, or every script that touches deployments/testnet.json
    // breaks on a rail none of them were changing.
    const path = await tempFile(
      JSON.stringify({
        ...VALID,
        policyRail: {
          contractId: "CCGAGRLVERK2A6PVQNU6YY62ANWNSFO32DM6OMFLRNLVHYJBLLON4G3I",
          wasmHash: "854b19f7bc472cb5ed8ada127ab12afde7857b7810a11e19a0490978cc7d7b88",
          owner: "GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K",
          asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          perTx: "0.0020000",
          perDay: "0.0100000",
          validUntil: "2027-09-04T18:20:23.000Z",
          deployedAt: "2026-09-04T18:20:28.292Z",
          protocolVersion: 28,
        },
      }),
    );

    const read = await readDeployment(path);

    expect(read.policyRail?.principal).toBeNull();
  });

  it("rejects a principal that is not a Stellar public key", async () => {
    const path = await tempFile(
      JSON.stringify({
        ...VALID,
        policyRail: {
          contractId: "CCGAGRLVERK2A6PVQNU6YY62ANWNSFO32DM6OMFLRNLVHYJBLLON4G3I",
          wasmHash: "854b19f7bc472cb5ed8ada127ab12afde7857b7810a11e19a0490978cc7d7b88",
          owner: "GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K",
          principal: "not-a-wallet",
          asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          perTx: "0.0020000",
          perDay: "0.0100000",
          validUntil: "2027-09-04T18:20:23.000Z",
          deployedAt: "2026-09-04T18:20:28.292Z",
          protocolVersion: 28,
        },
      }),
    );

    await expect(readDeployment(path)).rejects.toSatisfy((error: unknown) =>
      hasErrorCode(error, "ConfigError"),
    );
  });

  it("rejects a rail limit that is not a decimal amount, since ucp:buy reads it as one (T148 review, R-19)", async () => {
    const rail = {
      contractId: "CCGAGRLVERK2A6PVQNU6YY62ANWNSFO32DM6OMFLRNLVHYJBLLON4G3I",
      wasmHash: "854b19f7bc472cb5ed8ada127ab12afde7857b7810a11e19a0490978cc7d7b88",
      owner: "GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K",
      principal: "GD2MCESI2DMMOU4F2SI6ZHDZDDCN5LA7PMKUVZSKTKVGU5RLTCNIK5GN",
      asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      perTx: "5.0000000",
      perDay: "10.0000000",
      validUntil: "2027-10-05T14:19:20.000Z",
      deployedAt: "2026-10-05T14:19:25.000Z",
      protocolVersion: 29,
    };
    await expect(readDeployment(await tempFile(JSON.stringify({ ...VALID, policyRailUcp: rail })))).resolves.toMatchObject({ policyRailUcp: { perTx: "5.0000000" } });
    for (const perTx of ["lots", "-1", "5.00000001", "1e3"]) {
      await expect(readDeployment(await tempFile(JSON.stringify({ ...VALID, policyRailUcp: { ...rail, perTx } })))).rejects.toSatisfy((error: unknown) => hasErrorCode(error, "ConfigError"));
    }
  });

  it("rejects unknown fields, so a typo cannot silently survive a round trip", async () => {
    const path = await tempFile(JSON.stringify({ ...VALID, contractID: "typo" }));

    await expect(readDeployment(path)).rejects.toSatisfy((error: unknown) =>
      hasErrorCode(error, "ConfigError"),
    );
  });
});

describe("writeDeployment", () => {
  it("refuses to write a malformed record rather than corrupting the shared artefact", async () => {
    const path = await tempFile();
    const broken = { ...VALID, agentRegistry: { ...VALID.agentRegistry, schemaVersion: -1 } };

    await expect(writeDeployment(path, broken as Deployment)).rejects.toSatisfy((error: unknown) =>
      hasErrorCode(error, "ConfigError"),
    );
  });
});
