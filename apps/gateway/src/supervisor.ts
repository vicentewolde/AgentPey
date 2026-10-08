/**
 * Spawning each app as its own OS process, and knowing when it is ready.
 *
 * **Why a real child process, not an imported function.** `apps/web`,
 * `apps/realops` and `apps/signaldesk`'s own `server.ts` files are
 * self-executing scripts — top-level `await`, a `.listen()` call as a side
 * effect of being loaded — not an exported "start the server" function
 * another module could call safely more than once or alongside two others in
 * the same process. Spawning each with `tsx`, exactly as `pnpm --filter <app>
 * run start` already does today, needs no change to any of the three and
 * gives each its own OS-level process, its own crash domain, and — paired
 * with `env-filter.ts` — its own slice of the container's secrets.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { connect } from "node:net";

import { filterEnv } from "./env-filter.js";
import type { AppTarget } from "./hosts.js";

export interface SpawnedApp {
  readonly target: AppTarget;
  readonly child: ChildProcess;
}

/** Forwards a child's output line by line, tagged with which app it came from — the one thing T84's debugging kept needing and a shared stdout would erase. */
function forwardTagged(stream: NodeJS.ReadableStream | null, tag: string, out: NodeJS.WritableStream): void {
  if (stream === null) return;
  let buffer = "";
  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) out.write(`[${tag}] ${line}\n`);
  });
}

/**
 * Spawns `target` with only its own environment (`env-filter.ts`) and its
 * assigned internal port, and tags its logs.
 *
 * Not itself responsible for what happens when the child exits — that is a
 * policy decision (`server.ts` treats any child dying as reason to bring the
 * whole gateway down, so Render restarts everything together), and keeping
 * it out of this function is what keeps this function testable without ever
 * actually spawning a process that could exit.
 */
export function spawnApp(target: AppTarget, repoRoot: string, tsxBin: string, sourceEnv: NodeJS.ProcessEnv): SpawnedApp {
  const env = filterEnv(sourceEnv, target.envKeys, { PORT: String(target.port) }, target.envAliases);
  const child = spawn(tsxBin, [target.entry], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  forwardTagged(child.stdout, target.name, process.stdout);
  forwardTagged(child.stderr, target.name, process.stderr);
  return { target, child };
}

/**
 * Resolves once something is listening on `127.0.0.1:port`, so the gateway
 * never accepts a public request before the app behind it can answer one.
 *
 * @throws Error if nothing answers within `timeoutMs`.
 */
export async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await answers(port)) return;
    if (Date.now() >= deadline) {
      throw new Error(`nothing answered on 127.0.0.1:${port} within ${timeoutMs}ms`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
}

/** Whether something accepts a TCP connection on `127.0.0.1:port` right now. */
function answers(port: number): Promise<boolean> {
  return new Promise<boolean>((resolvePromise) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.end();
      resolvePromise(true);
    });
    socket.on("error", () => resolvePromise(false));
  });
}

/**
 * For a non-critical app that missed the startup window (`R-32`): keeps
 * checking its port after the gateway is already serving the others, so an
 * app that comes up a few seconds late joins then instead of answering `503`
 * until the next deploy.
 *
 * Resolves `true` once the port answers, `false` if `isAlive()` turns false
 * first (the child exited: nothing will ever answer) or `timeoutMs` passes.
 * Never throws: the caller only decides whether to route to the app.
 */
export async function waitForLateApp(port: number, options: { readonly timeoutMs: number; readonly isAlive: () => boolean; readonly intervalMs?: number }): Promise<boolean> {
  const deadline = Date.now() + options.timeoutMs;
  while (options.isAlive()) {
    if (await answers(port)) return options.isAlive();
    if (Date.now() >= deadline) return false;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, options.intervalMs ?? 1000));
  }
  return false;
}
