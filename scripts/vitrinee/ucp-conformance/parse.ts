/** Reads the official UCP conformance suite's absltest output (T131). */
export type Outcome = "ok" | "failed" | "skipped";
export interface TestResult {
  file: string;
  test: string;
  outcome: Outcome;
  /** The skip reason, or the first assertion line of a failure. */
  note: string;
}

/** Reads absltest's `[       OK ]` / `[  FAILED  ]` / `[  SKIPPED ]` lines, and each failure's assertion. */
export function parseAbslOutput(file: string, output: string): TestResult[] {
  const results: TestResult[] = [];
  for (const line of output.split("\n")) {
    const m = /^\[\s*(OK|FAILED|SKIPPED)\s*\] (\S+)(?: - (.*))?$/.exec(line);
    if (m === null) continue;
    const outcome: Outcome = m[1] === "OK" ? "ok" : m[1] === "FAILED" ? "failed" : "skipped";
    results.push({ file, test: m[2]!, outcome, note: m[3] ?? "" });
  }
  for (const result of results.filter((r) => r.outcome === "failed")) {
    const name = result.test.split(".").at(-1)!;
    const block = output.split(/^={20,}$/m).find((b) => new RegExp(`^(FAIL|ERROR): ${name} `, "m").test(b));
    const assertion = block?.split("\n").find((l) => /^\w*(Error|Exception)\b/.test(l));
    if (assertion !== undefined) result.note = assertion.length > 300 ? `${assertion.slice(0, 300)}…` : assertion;
  }
  return results;
}
