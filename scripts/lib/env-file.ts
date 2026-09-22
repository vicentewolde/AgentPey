/**
 * `.env.local` handling for the repo scripts. The file is the merchant's and
 * the agent's local secret store: mode 600, gitignored, never printed.
 * Updates are surgical — existing lines (including comments and keys these
 * scripts know nothing about) are preserved verbatim.
 */
import { open, readFile, rename } from "node:fs/promises";

const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

function unquote(raw: string): string {
  if (raw.length >= 2 && raw[0] === '"' && raw[raw.length - 1] === '"') {
    // Double quotes may carry JSON escapes (see `quote`); fall back to a plain slice.
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "string") return parsed;
    } catch {
      // not JSON-escaped
    }
    return raw.slice(1, -1);
  }
  if (raw.length >= 2 && raw[0] === "'" && raw[raw.length - 1] === "'") return raw.slice(1, -1);
  return raw;
}

/** Parses KEY=VALUE lines. Comments and blank lines are ignored; later keys win. */
export function parseEnv(content: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const match = LINE_RE.exec(line);
    if (match?.[1] !== undefined) values.set(match[1], unquote(match[2] ?? ""));
  }
  return values;
}

export async function readEnvFile(path: string): Promise<{ content: string; values: Map<string, string> }> {
  let content = "";
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { content, values: parseEnv(content) };
}

export interface EnvUpdate {
  key: string;
  value: string;
  /** Written as a `# ...` line above the key when the key is appended. */
  comment?: string;
}

function quote(value: string): string {
  if (/[\s"'#$\\]/.test(value)) return JSON.stringify(value);
  return `"${value}"`;
}

/**
 * Replaces the value of every key that already exists (first occurrence,
 * keeping its position) and appends the rest under `header`. Idempotent:
 * applying the same updates twice yields the same content.
 */
export function upsertEnv(content: string, updates: readonly EnvUpdate[], header?: string): string {
  const lines = content === "" ? [] : content.replace(/\r?\n$/, "").split(/\r?\n/);
  const pending = new Map(updates.map((u) => [u.key, u] as const));

  const rewritten = lines.map((line) => {
    const match = LINE_RE.exec(line);
    const key = match?.[1];
    if (key === undefined || line.trim().startsWith("#")) return line;
    const update = pending.get(key);
    if (update === undefined) return line;
    pending.delete(key);
    return `${key}=${quote(update.value)}`;
  });

  if (pending.size > 0) {
    if (rewritten.length > 0 && rewritten[rewritten.length - 1] !== "") rewritten.push("");
    if (header !== undefined) rewritten.push(`# ---- ${header} ${"-".repeat(Math.max(0, 70 - header.length))}`);
    for (const update of pending.values()) {
      if (update.comment !== undefined) rewritten.push(`# ${update.comment}`);
      rewritten.push(`${update.key}=${quote(update.value)}`);
    }
  }
  return rewritten.join("\n") + "\n";
}

/** Atomic write with mode 600: a crash mid-write never leaves a world-readable file. */
export async function writeEnvFile(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  const handle = await open(tmp, "w", 0o600);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
}
