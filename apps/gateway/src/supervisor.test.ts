/**
 * `waitForPort` and `waitForLateApp` only — real TCP, no real spawn. `spawnApp` launches an actual
 * child process running `tsx` against a full app's `server.ts`, which needs a
 * real Postgres and real Stellar keys to come up cleanly; that is exercised
 * by running the gateway itself (see the package README), not by a unit test
 * here, the same boundary `apps/web/src/server.ts` and its siblings already
 * draw around their own entrypoints.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { waitForLateApp, waitForPort } from "./supervisor.js";

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

describe("waitForLateApp (R-32)", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  /** A free port, closed again so nothing answers on it until a test opens it. */
  async function freePort(): Promise<number> {
    const probe = createServer();
    const port = await new Promise<number>((resolve) => probe.listen(0, "127.0.0.1", () => resolve((probe.address() as AddressInfo).port)));
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
  }

  it("resolves true when an app that missed the window starts answering later", async () => {
    const port = await freePort();
    setTimeout(() => {
      server = createServer();
      server.on("error", () => undefined);
      server.listen(port, "127.0.0.1");
    }, 150);
    await expect(waitForLateApp(port, { timeoutMs: 5000, isAlive: () => true, intervalMs: 50 })).resolves.toBe(true);
  });

  it("stops at once with false when the app's process has exited", async () => {
    const port = await freePort();
    let alive = true;
    setTimeout(() => (alive = false), 100);
    const started = Date.now();
    await expect(waitForLateApp(port, { timeoutMs: 5000, isAlive: () => alive, intervalMs: 50 })).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("gives up with false once its own timeout passes, not before", async () => {
    const port = await freePort();
    const started = Date.now();
    await expect(waitForLateApp(port, { timeoutMs: 200, isAlive: () => true, intervalMs: 50 })).resolves.toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
  });

  it("answers false if the process exited while its port was answering, so it is never routed to", async () => {
    server = createServer();
    const port = await new Promise<number>((resolve) => server!.listen(0, "127.0.0.1", () => resolve((server!.address() as AddressInfo).port)));
    let checks = 0;
    // Alive for the loop's own check, dead by the time the port has answered.
    await expect(waitForLateApp(port, { timeoutMs: 5000, isAlive: () => checks++ === 0, intervalMs: 50 })).resolves.toBe(false);
  });
});
