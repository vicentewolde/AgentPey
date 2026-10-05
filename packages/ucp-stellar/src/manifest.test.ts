/**
 * T136's second criterion: the published package drags in nothing private from the monorepo. Read from the
 * manifest npm publishes, so a `workspace:` range or an internal scope cannot slip in.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

const manifest = z
  .looseObject({
    name: z.string(),
    private: z.boolean().optional(),
    dependencies: z.record(z.string(), z.string()).default({}),
    peerDependencies: z.record(z.string(), z.string()).default({}),
    optionalDependencies: z.record(z.string(), z.string()).default({}),
    publishConfig: z.looseObject({ access: z.string() }),
    files: z.array(z.string()),
  })
  .parse(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")));

const shipped = { ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies };

describe("the published manifest", () => {
  it("is public, under @agentpey", () => {
    expect(manifest.name).toBe("@agentpey/ucp-stellar");
    expect(manifest.private).not.toBe(true);
    expect(manifest.publishConfig.access).toBe("public");
  });

  it("depends on nothing from the monorepo", () => {
    for (const [name, range] of Object.entries(shipped)) {
      expect(name, name).not.toMatch(/^@(agentpass|agentpey|vitrinee)\//);
      expect(range, name).not.toMatch(/^(workspace|file|link|portal):/);
    }
  });

  it("depends on exactly what it imports", () => {
    expect(Object.keys(shipped).sort()).toEqual(["@stellar/stellar-sdk", "@x402/core", "@x402/stellar", "zod"]);
  });

  it("ships the build, not the tests", () => {
    expect(manifest.files).toEqual(expect.arrayContaining(["dist", "!dist/**/*.test.*"]));
  });
});
