/**
 * One way to ask Claude for structured output or a web-searched answer, with
 * two backends:
 *
 * - "cuenta" (default): the Claude Code CLI in print mode, signed in with the
 *   claude.ai subscription. No API spend; it counts against the plan's usage
 *   limits. For building and demoing the product, not for serving customers.
 * - "api": the Anthropic API with ANTHROPIC_API_KEY (billed per token).
 *
 * COMERCIOS_LLM=api|cuenta picks one.
 */
import { spawn } from "node:child_process";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

export interface Llm {
  readonly name: string;
  structured<T extends z.ZodType>(schema: T, system: string, user: string): Promise<z.infer<T> | undefined>;
  /** A shopping-assistant answer with web search on; the text and the URLs it used. */
  searchAnswer(system: string, question: string): Promise<{ text: string; urls: string[] }>;
}

const API_MODEL = process.env.COMERCIOS_MODEL ?? "claude-opus-5-5";
const CLI_MODEL = process.env.COMERCIOS_CLI_MODEL ?? "sonnet";

export function createLlm(kind = process.env.COMERCIOS_LLM ?? "cuenta"): Llm {
  return kind === "api" ? apiLlm(new Anthropic()) : cliLlm();
}

function apiLlm(client: Anthropic): Llm {
  return {
    name: `api:${API_MODEL}`,
    async structured(schema, system, user) {
      const response = await client.messages.parse({
        model: API_MODEL,
        max_tokens: 16000,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: user }],
        output_config: { effort: "low", format: zodOutputFormat(schema) },
      });
      if (response.stop_reason !== "end_turn") return undefined;
      return response.parsed_output ?? undefined;
    },
    async searchAnswer(system, question) {
      const messages: Anthropic.MessageParam[] = [{ role: "user", content: question }];
      let response: Anthropic.Message | undefined;
      for (let turn = 0; turn < 3; turn++) {
        response = await client.messages.create({
          model: API_MODEL,
          max_tokens: 8000,
          system,
          tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5, user_location: { type: "approximate", country: "CL" } }],
          messages,
          output_config: { effort: "low" },
        });
        if (response.stop_reason !== "pause_turn") break;
        messages.push({ role: "assistant", content: response.content });
      }
      const urls = new Set<string>();
      let text = "";
      for (const block of response?.content ?? []) {
        if (block.type === "text") {
          text += block.text;
          for (const c of block.citations ?? []) if ("url" in c && typeof c.url === "string") urls.add(c.url);
        } else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
          for (const r of block.content) if (r.type === "web_search_result") urls.add(r.url);
        }
      }
      return { text, urls: [...urls] };
    },
  };
}

/**
 * The plan's usage limit was reached (claude -p or Codex). Callers stop the
 * run and keep what is saved instead of retrying in a loop.
 */
export class UsageLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageLimitError";
  }
}

export const LIMIT_TEXT = /usage limit|hit your limit|limit reached|rate limit|limit will reset|resets? (at|in)|quota|out of (extra )?usage|límite de uso/i;

/** The error to raise for a failed `claude -p` run: the CLI's own message, and a UsageLimitError when it is the plan's limit. */
export function cliError(r: { subtype?: string; result?: string }): Error {
  const message = `claude -p: ${(r.result ?? "").trim().slice(0, 300) || r.subtype || "error"}`;
  return LIMIT_TEXT.test(r.result ?? "") ? new UsageLimitError(message) : new Error(message);
}

interface CliResult {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  structured_output?: unknown;
}

/** Run `claude -p` with the prompt on stdin. The API key is removed from the child's env so it uses the subscription. */
function runCli(args: string[], prompt: string, timeoutMs = 300_000): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    // No MCP servers, skills or dynamic sections: without these flags every call carried the whole local setup
    // (hundreds of thousands of tokens of tool definitions) and used up the plan many times faster.
    const child = spawn("claude", ["-p", "--output-format", "json", "--no-session-persistence", "--model", CLI_MODEL, "--strict-mcp-config", "--disable-slash-commands", "--exclude-dynamic-system-prompt-sections", ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out) as CliResult);
      } catch {
        const detail = err.slice(0, 300) || out.slice(0, 300);
        reject(LIMIT_TEXT.test(detail) ? new UsageLimitError(`claude -p: ${detail}`) : new Error(`claude -p terminó con ${code}: ${detail}`));
      }
    });
    child.stdin.end(prompt);
  });
}

function cliLlm(): Llm {
  return {
    name: `cuenta:${CLI_MODEL}`,
    async structured(schema, system, user) {
      const { $schema: _drop, ...plain } = z.toJSONSchema(schema) as Record<string, unknown>;
      const jsonSchema = JSON.stringify(plain);
      const r = await runCli(["--tools", "", "--system-prompt", system, "--json-schema", jsonSchema], user);
      // A failed run (the plan's limit, most often) used to come back as "no answer", which hid the reason.
      if (r.is_error === true) throw cliError(r);
      if (r.structured_output === undefined) return undefined;
      const parsed = schema.safeParse(r.structured_output);
      return parsed.success ? parsed.data : undefined;
    },
    async searchAnswer(system, question) {
      const r = await runCli(["--tools", "WebSearch", "--allowedTools", "WebSearch", "--system-prompt", system], question);
      if (r.is_error === true) throw cliError(r);
      const text = r.result ?? "";
      // The CLI returns the final text only; the URLs are the links written in it.
      const urls = [...new Set([...text.matchAll(/https?:\/\/[^\s)\]>"']+/g)].map((m) => m[0].replace(/[.,;]+$/, "")))];
      return { text, urls };
    },
  };
}
