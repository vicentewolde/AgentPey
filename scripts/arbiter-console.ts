/**
 * `pnpm run arbiter:console` (T155, `R-34`): the arbiter's three steps on a
 * page in the browser, so the live demo shows a product and not a terminal.
 *
 *   1. open the dispute      -> `resolve:open -- --claim <file>`
 *   2. the store's answer    -> `resolve:check-response`
 *   3. ask for the verdict   -> `resolve:decide`
 *   4. confirm and pay       -> `resolve:execute -- --confirm <hash>` (E-18)
 *
 * It runs the existing commands as they are, from this checkout, so the keys
 * stay in this machine's `.env.local` and nothing is deployed. It listens on
 * 127.0.0.1 only, answers only the page it served (Host, Origin and a key
 * printed at startup), and runs one command at a time. A person still decides:
 * the payment needs the verdict's hash typed on the page.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { AgentPassError, isAgentPassError } from "@agentpass/core";
import { z } from "zod";

import {
  checkAccess,
  failureOf,
  firstExplorerUrl,
  isHash,
  newestResponseName,
  outcomeLabel,
  parseClaim,
  parseCliOutput,
  parseResponseFile,
  summarizeVerdict,
} from "./lib/arbiter-console.js";
import { renderConsolePage } from "./lib/arbiter-console-page.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const STATE_DIR = resolve(REPO_ROOT, ".vitrinee/arbiter-console");
const DOWNLOADS = join(homedir(), "Downloads");
const MAX_BODY_BYTES = 100_000;

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: { port: { type: "string", default: "4747" }, "no-open": { type: "boolean", default: false } },
});
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new AgentPassError("InvalidArguments", "--port must be a number between 1024 and 65535", { details: { port: values.port } });
}
const consoleKey = randomBytes(24).toString("hex");

/** What the page has done so far: the dispute it is working on, and the verdict it is waiting to be confirmed. */
const session: { receiptHash: string | null; responseFile: string | null } = { receiptHash: null, responseFile: null };
let busy = false;

interface CommandResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

function runScript(script: string, args: readonly string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((done) => {
    execFile("pnpm", ["-s", "run", script, "--", ...args], { cwd: REPO_ROOT, timeout: timeoutMs, maxBuffer: 4_000_000 }, (error, stdout, stderr) => {
      done({ ok: error === null, stdout, stderr });
    });
  });
}

function requireDispute(): string {
  if (session.receiptHash === null) throw new AgentPassError("InvalidArguments", "primero abre el reclamo (paso 1)", { details: {} });
  return session.receiptHash;
}

function failed(result: CommandResult): { ok: false; message: string; detail: string; sections?: unknown } {
  const why = failureOf(result.stderr === "" ? result.stdout : result.stderr);
  const parsed = result.stdout === "" ? null : parseCliOutput(result.stdout);
  return { ok: false, message: why.message, detail: why.detail, ...(parsed === null ? {} : { sections: parsed.sections }) };
}

const bodySchemas = {
  open: z.object({ claim: z.string() }),
  response: z.union([z.object({ useLatest: z.literal(true) }), z.object({ text: z.string() })]),
  execute: z.object({ hash: z.string() }),
};

async function handleApi(path: string, body: unknown): Promise<unknown> {
  switch (path) {
    case "/api/open": {
      const { claim } = bodySchemas.open.parse(body);
      const parsed = parseClaim(claim);
      const dir = join(STATE_DIR, parsed.receiptHash);
      await mkdir(dir, { recursive: true });
      const file = join(dir, "claim.jws");
      await writeFile(file, `${parsed.jws}\n`, { mode: 0o600 });
      const result = await runScript("resolve:open", ["--claim", file], 180_000);
      if (!result.ok) return failed(result);
      session.receiptHash = parsed.receiptHash;
      session.responseFile = null;
      return { ok: true, ...parseCliOutput(result.stdout), explorerUrl: firstExplorerUrl(result.stdout) };
    }
    case "/api/response": {
      const receiptHash = requireDispute();
      const payload = bodySchemas.response.parse(body);
      let text: string;
      if ("useLatest" in payload) {
        const names = await readdir(DOWNLOADS).catch(() => [] as string[]);
        const stats = await Promise.all(names.map(async (name) => ({ name, mtimeMs: (await stat(join(DOWNLOADS, name)).catch(() => null))?.mtimeMs ?? 0 })));
        const newest = newestResponseName(stats);
        if (newest === null) throw new AgentPassError("InvalidArguments", "no encuentro ningún archivo agentresolve-response-….json en Descargas", { details: {} });
        text = await readFile(join(DOWNLOADS, newest), "utf8");
      } else {
        text = payload.text;
      }
      const checked = parseResponseFile(text, receiptHash);
      const file = join(STATE_DIR, receiptHash, "response.json");
      await writeFile(file, checked, { mode: 0o600 });
      const result = await runScript("resolve:check-response", ["--receipt", receiptHash, "--response", file], 120_000);
      if (!result.ok) return failed(result);
      session.responseFile = file;
      return { ok: true, ...parseCliOutput(result.stdout) };
    }
    case "/api/decide": {
      const receiptHash = requireDispute();
      if (session.responseFile === null) throw new AgentPassError("InvalidArguments", "primero carga la respuesta de la tienda (paso 2)", { details: {} });
      const result = await runScript("resolve:decide", ["--receipt", receiptHash, "--response", session.responseFile], 300_000);
      if (!result.ok) return failed(result);
      const verdict = summarizeVerdict(result.stdout);
      if (verdict === null) return { ok: false, message: "el árbitro respondió, pero no pude leer su veredicto", detail: result.stdout.slice(-1500) };
      return { ok: true, verdict: { ...verdict, label: outcomeLabel(verdict.outcome) } };
    }
    case "/api/execute": {
      const receiptHash = requireDispute();
      const { hash } = bodySchemas.execute.parse(body);
      if (!isHash(hash)) throw new AgentPassError("InvalidArguments", "el hash del veredicto son 64 caracteres, en minúsculas", { details: {} });
      const result = await runScript("resolve:execute", ["--receipt", receiptHash, "--confirm", hash], 240_000);
      if (!result.ok) return failed(result);
      const verified = await runScript("resolve:verify", ["--receipt", receiptHash], 120_000);
      return {
        ok: true,
        ...parseCliOutput(result.stdout),
        explorerUrl: firstExplorerUrl(result.stdout),
        ...(verified.ok ? { verified: parseCliOutput(verified.stdout).sections } : {}),
      };
    }
    default:
      throw new AgentPassError("InvalidArguments", "ruta desconocida", { details: { path } });
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new AgentPassError("InvalidArguments", "el pedido es demasiado grande", { details: { bytes: size } });
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? {} : (JSON.parse(text) as unknown);
}

function send(res: ServerResponse, status: number, body: string, type: string): void {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
  });
  res.end(body);
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    try {
      if (req.method === "GET" && url.pathname === "/") {
        checkAccess({ host: req.headers.host, origin: undefined, key: url.searchParams.get("k") ?? undefined, expectedKey: consoleKey, port });
        send(res, 200, renderConsolePage(consoleKey), "text/html; charset=utf-8");
        return;
      }
      if (req.method !== "POST" && !(req.method === "GET" && url.pathname.startsWith("/api/"))) {
        send(res, 404, JSON.stringify({ ok: false, message: "no encontrado" }), "application/json");
        return;
      }
      const key = req.headers["x-console-key"];
      checkAccess({ host: req.headers.host, origin: req.headers.origin, key: typeof key === "string" ? key : undefined, expectedKey: consoleKey, port });
      if (busy) {
        send(res, 409, JSON.stringify({ ok: false, message: "espera: hay otro paso en marcha" }), "application/json");
        return;
      }
      busy = true;
      try {
        const result = await handleApi(url.pathname, req.method === "POST" ? await readBody(req) : {});
        send(res, 200, JSON.stringify(result), "application/json");
      } finally {
        busy = false;
      }
    } catch (error) {
      const typed = isAgentPassError(error);
      const status = typed && error.code === "ConfigError" ? 403 : 400;
      const message = typed ? error.message : error instanceof z.ZodError ? "la solicitud no tiene la forma esperada" : "falló algo inesperado";
      if (!typed && !(error instanceof z.ZodError)) process.stderr.write(`${String(error)}\n`);
      send(res, status, JSON.stringify({ ok: false, ...(typed ? { code: error.code } : {}), message }), "application/json");
    }
    process.stdout.write(`${req.method ?? "?"} ${url.pathname} ${res.statusCode}\n`);
  })();
});

server.listen(port, "127.0.0.1", () => {
  const address = `http://127.0.0.1:${port}/?k=${consoleKey}`;
  process.stdout.write(`\nPantalla del árbitro lista, solo en este computador:\n  ${address}\n\nCtrl+C para cerrarla.\n`);
  if (!values["no-open"]) execFile("open", [address], () => undefined);
});
