/**
 * `waitForPort` only — real TCP, no real spawn. `spawnApp` launches an actual
 * child process running `tsx` against a full app's `server.ts`, which needs a
 * real Postgres and real Stellar keys to come up cleanly; that is exercised
 * by running the gateway itself (see the package README), not by a unit test
 * here, the same boundary `apps/web/src/server.ts` and its siblings already
 * draw around their own entrypoints.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { waitForPort } from "./supervisor.js";

describe("waitForPort", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it("resolves once something is actually listening", async () => {
    server = createServer();
    const port = await new Promise<number>((resolve) => {
      server!.listen(0, "127.0.0.1", () => resolve((server!.address() as AddressInfo).port));
    });

    await expect(waitForPort(port, 1000)).resolves.toBeUndefined();
  });

  it("throws once the timeout passes, for a port nothing is listening on", async () => {
    await expect(waitForPort(1, 300)).rejects.toThrow(/nothing answered/);
  });
});
