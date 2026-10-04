#!/usr/bin/env node
/**
 * `pnpm run ucp:conformance [-- --only checkout_lifecycle_test.py,...]`
 *
 * Runs the official UCP conformance suite (T131) against the local
 * conformance store (`store.ts`, R-3), the way the suite's own CI does: one
 * test file per process. The suite and the Python SDK it imports are cloned at
 * pinned commits into `.ucp-conformance/` (git-ignored) and installed with `uv`.
 * Raw output of each file goes to `.ucp-conformance/out/<file>.log`; the
 * summary, test by test, to `.ucp-conformance/out/summary.md`.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { parseAbslOutput, type Outcome, type TestResult } from "./parse.js";
import { startConformanceStore } from "./store.js";

export const SUITE = { repo: "https://github.com/Universal-Commerce-Protocol/conformance", commit: "016ecbc22240affdec4429a60d539bedd04ab51b" };
/** The SDK tag the suite's CI checks out (.github/workflows/conformance-tests.yml). */
export const SDK = { repo: "https://github.com/Universal-Commerce-Protocol/python-sdk", tag: "v2026-04-08-6" };

const ROOT = join(import.meta.dirname, "../../..");
const WORK = join(ROOT, ".ucp-conformance");
const SUITE_DIR = join(WORK, "conformance");
const SDK_DIR = join(WORK, "python-sdk");
const OUT = join(WORK, "out");
const DATA = join(import.meta.dirname, "data");

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function prepare(): void {
  mkdirSync(WORK, { recursive: true });
  if (!existsSync(SUITE_DIR)) git(["clone", "--quiet", SUITE.repo, SUITE_DIR]);
  if (git(["rev-parse", "HEAD"], SUITE_DIR) !== SUITE.commit) {
    git(["fetch", "--quiet", "origin"], SUITE_DIR);
    git(["checkout", "--quiet", SUITE.commit], SUITE_DIR);
  }
  if (!existsSync(SDK_DIR)) git(["clone", "--quiet", "--depth", "1", "--branch", SDK.tag, SDK.repo, SDK_DIR]);
  const sync = spawnSync("uv", ["sync", "--quiet"], { cwd: SUITE_DIR, encoding: "utf8" });
  if (sync.status !== 0) throw new Error(`uv sync failed (is uv installed? brew install uv): ${sync.stderr}`);
}

const { values } = parseArgs({ args: process.argv.slice(2).filter((a) => a !== "--"), options: { only: { type: "string" } } });

prepare();
mkdirSync(OUT, { recursive: true });
const secret = randomBytes(24).toString("hex");
const store = await startConformanceStore({ simulationSecret: secret });
const files = (values.only?.split(",") ?? readdirSync(SUITE_DIR).filter((f) => f.endsWith("_test.py"))).sort();
const results: TestResult[] = [];
try {
  for (const file of files) {
    // Async on purpose: the store answers from this same process, and a sync spawn would freeze it.
    const output = await runFile(file);
    writeFileSync(join(OUT, `${file}.log`), output.replaceAll(secret, "<simulation-secret>"));
    const parsed = parseAbslOutput(file, output);
    results.push(...parsed);
    const count = (o: Outcome) => parsed.filter((r) => r.outcome === o).length;
    process.stdout.write(`${file.padEnd(36)} ok ${count("ok")}  failed ${count("failed")}  skipped ${count("skipped")}\n`);
  }
} finally {
  await store.close();
}
const total = (o: Outcome) => results.filter((r) => r.outcome === o).length;
const lines = [
  `Suite ${SUITE.repo} @ ${SUITE.commit}; SDK ${SDK.repo} @ ${SDK.tag}`,
  "",
  `ok ${total("ok")} · failed ${total("failed")} · skipped ${total("skipped")} · total ${results.length}`,
  "",
  "| Archivo | Test | Resultado | Nota |",
  "|---|---|---|---|",
  ...results.map((r) => `| ${r.file} | ${r.test.split(".").at(-1)} | ${r.outcome} | ${r.note.replaceAll("|", "\\|")} |`),
];
writeFileSync(join(OUT, "summary.md"), `${lines.join("\n")}\n`);
process.stdout.write(`\n${lines.slice(0, 3).join("\n")}\nraw output and summary in ${OUT}\n`);
process.exitCode = total("failed") === 0 ? 0 : 1;

/** One suite file, as the suite's CI runs it; stdout and stderr together. */
function runFile(file: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(
      "uv",
      [
        "run",
        file,
        `--server_url=${store.url}`,
        `--simulation_secret=${secret}`,
        `--conformance_input=${join(DATA, "conformance_input.json")}`,
        `--fixture_config=${join(DATA, "test_fixtures.json")}`,
        `--test_data_dir=${DATA}`,
      ],
      { cwd: SUITE_DIR },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    const timer = setTimeout(() => child.kill("SIGKILL"), 300_000);
    child.on("close", () => {
      clearTimeout(timer);
      resolve(output);
    });
  });
}
