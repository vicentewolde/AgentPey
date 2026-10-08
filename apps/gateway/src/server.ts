/**
 * The gateway's entrypoint (T86): one Render service, one process listening
 * on the one port Render assigns, forwarding to genuinely separate child
 * processes (three from T86, four since Vitrinee joined in T102) chosen by
 * the request's own `Host` header.
 *
 * Read `hosts.ts` first — it is the map this file wires up — then
 * `env-filter.ts` for how a child ends up with only its own secrets, and
 * `proxy.ts` for why the original `Host` header survives the hop. This file
 * is the wiring between the three, plus the two policies that only make
 * sense at the process-supervision level:
 *
 * - **The gateway owns the public port from its first second, and routes to
 *   a child only once that child is confirmed listening.** Until then its host
 *   answers `503` "starting", never a hang or a `502`. The order matters on
 *   Render: while nothing listens on `PORT`, Render scans for any open port,
 *   and on 2026-10-08 it found RealOps on 4102 before the gateway opened
 *   10000 and sent every host straight to RealOps, past the gateway. Listening
 *   first leaves nothing to find (`PORT` is also set in `render.yaml`).
 * - **Any child exiting unexpectedly — or the gateway's own listener failing
 *   to start — brings this whole process down**, taking every other child
 *   with it rather than orphaning them. Not a respawn loop: Render already
 *   restarts a crashed service, and restarting through the same startup path
 *   above is simpler and easier to reason about than a second, bespoke retry
 *   policy living only here. The one exception is an app marked
 *   `critical: false` (Vitrinee, `C-136`): a merchant the pilot can run
 *   without stops being routed to, and the rest keeps serving.
 *
 * Not unit-tested itself, for the same reason `apps/web/src/server.ts` and
 * its siblings are not: every one of the decisions above is either already
 * covered where it is pure (`hosts.ts`, `env-filter.ts`, `proxy.ts`,
 * `supervisor.ts`), or is a real child process actually running, which the
 * package README documents verifying by running the gateway itself.
 */
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { APP_TARGETS, buildHostMap, missingEnv, resolveTarget, type AppName } from "./hosts.js";
import { proxyRequest } from "./proxy.js";
import { spawnApp, waitForPort } from "./supervisor.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TSX_BIN = resolve(REPO_ROOT, "node_modules/.bin/tsx");
/** A first purchase deploys and funds a rail and waits for testnet settlement — 20-40s measured in T84. Comfortably inside this. */
const READY_TIMEOUT_MS = 45_000;
const PORT = Number(process.env.PORT ?? 8080);

const vitrineeHost = process.env.GATEWAY_VITRINEE_HOST ?? "vitrinee.agentpey.com";
const hostMap = buildHostMap({
  agentpeyHost: process.env.GATEWAY_AGENTPEY_HOST ?? "agentpey.com",
  realopsHost: process.env.GATEWAY_REALOPS_HOST ?? "realops.agentpey.com",
  signaldeskHost: process.env.GATEWAY_SIGNALDESK_HOST ?? "signaldesk.agentpey.com",
  vitrineeHost,
  mcpHost: process.env.GATEWAY_MCP_HOST ?? "mcp.agentpey.com",
});

/**
 * An app whose required secrets are not set is not started (T102, `C-136`).
 * Only Vitrinee declares any: until its secrets are loaded in Render, its host
 * answers `503` and the other three run exactly as before, instead of the
 * whole service crash-looping on a child that could never start.
 */
const toStart = APP_TARGETS.filter((target) => {
  const missing = missingEnv(target, process.env);
  if (missing.length > 0) {
    process.stdout.write(`gateway: not starting ${target.name}, missing ${missing.join(", ")}\n`);
  }
  return missing.length === 0;
});
const spawned = toStart.map((target) => spawnApp(target, REPO_ROOT, TSX_BIN, process.env));
/** The apps that are up and may be routed to. A non-critical app that exits leaves this set. */
const running = new Set<AppName>();

// Assigned once the server below is actually listening. `shutdown` has to
// tolerate it still being `undefined` — a signal can arrive at any time,
// including the gap while the three children are still starting up.
let server: Server | undefined;
let shuttingDown = false;

/**
 * Kills every child, closes the gateway's own listener, and exits.
 *
 * **Found running this locally, not by reading:** an earlier version killed
 * the children on `SIGTERM` and never called `process.exit()` itself — Node
 * has nothing else keeping the event loop alive once the last child is gone
 * and the server is closed, so the process should exit on its own, but it did
 * not, and sat there as a zombie until something sent `SIGKILL`. Calling
 * `process.exit()` with no argument here, rather than a hardcoded status,
 * exits with whatever `process.exitCode` already is — `0` for a plain signal,
 * or the `1` the child-exit handler below sets before calling this.
 */
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`gateway: ${signal} received, stopping the apps\n`);
  for (const { child } of spawned) child.kill();
  server?.close();
  process.exit();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

for (const { target, child } of spawned) {
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    if (!target.critical) {
      // A merchant the pilot can run without (T102, `C-136`): it stops being
      // routed to, and the rest of the pilot keeps serving.
      running.delete(target.name);
      process.stderr.write(
        `gateway: ${target.name} exited (code ${String(code)}, signal ${String(signal)}); its host answers 503 until the next deploy\n`,
      );
      return;
    }
    // Crash together, on purpose — see this file's own docstring.
    process.stderr.write(
      `gateway: ${target.name} exited unexpectedly (code ${String(code)}, signal ${String(signal)}) — exiting so the whole service restarts\n`,
    );
    process.exitCode = 1;
    shutdown("a child's own exit");
  });
}

/** Apps spawned and not yet confirmed listening: their hosts answer `503` "starting", not "not running". */
const starting = new Set<AppName>(toStart.map((target) => target.name));

server = createServer((req, res) => {
  const target = resolveTarget(hostMap, req.headers.host, vitrineeHost);
  if (target === undefined) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(`no app is configured for host "${req.headers.host ?? ""}"\n`);
    return;
  }
  if (!running.has(target.name)) {
    const isStarting = starting.has(target.name);
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8", "retry-after": isStarting ? "10" : "300" });
    res.end(isStarting ? `${target.name} is starting; try again in a few seconds\n` : `${target.name} is not running on this deployment\n`);
    return;
  }
  proxyRequest(req, res, { host: "127.0.0.1", port: target.port });
});

/**
 * Also found running this locally: with no handler here, a bind failure
 * (`EADDRINUSE`, most likely) crashed only this process — the three children,
 * already spawned and already listening on their own ports, were left
 * running with nothing left to route to them. `shutdown()` is the same path
 * a child's own unexpected exit already takes, so a failure here kills them
 * too instead of orphaning them.
 */
server.on("error", (error) => {
  process.stderr.write(`gateway: could not listen on :${PORT}: ${error.message}\n`);
  process.exitCode = 1;
  shutdown("failed to start listening");
});

server.listen(PORT, () => {
  process.stdout.write(`gateway: listening on :${PORT}\n`);
  for (const [host, target] of hostMap) process.stdout.write(`  ${host} -> ${target.name} (:${target.port})\n`);
});

process.stdout.write(`gateway: waiting for ${toStart.map((target) => `${target.name}:${target.port}`).join(", ")}...\n`);
try {
  await Promise.all(
    toStart.map(async (target) => {
      try {
        await waitForPort(target.port, READY_TIMEOUT_MS);
        running.add(target.name);
      } catch (error) {
        // A critical app that never came up is the old failure, unchanged: the whole service goes down.
        if (target.critical) throw error;
        process.stderr.write(`gateway: ${target.name} did not come up; its host answers 503\n`);
      } finally {
        starting.delete(target.name);
      }
    }),
  );
} catch (error) {
  process.stderr.write(`gateway: a critical app did not come up: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
  shutdown("a critical app did not come up");
}
process.stdout.write(`gateway: up: ${[...running].join(", ")}\n`);
