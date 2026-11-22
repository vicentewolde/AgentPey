import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

import { openDb } from "./db.js";
import { migrate, pgStore, sqliteStore, type Queryable } from "./store.js";
import { countedPath, requestIp, VisitCounter, visitor, visitsReport } from "./visitas.js";

describe("who is counted", () => {
  it("names the assistants' crawlers and fetchers by their user agent", () => {
    expect(visitor("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot", undefined, null)).toEqual({ agent: "ChatGPT-User (OpenAI)", kind: "lee para una persona" });
    expect(visitor("Mozilla/5.0; compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot", undefined, null)?.kind).toBe("indexa");
    expect(visitor("Mozilla/5.0 (compatible; GPTBot/1.1)", undefined, null)?.kind).toBe("entrena");
    expect(visitor("Claude-User/1.0 (+Claude-User@anthropic.com)", undefined, null)?.agent).toBe("Claude-User (Anthropic)");
    expect(visitor("Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", undefined, null)?.kind).toBe("entrena");
    expect(visitor("Mozilla/5.0 (compatible; Perplexity-User/1.0)", undefined, null)?.kind).toBe("lee para una persona");
    expect(visitor("Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)", undefined, null)?.kind).toBe("indexa");
    expect(visitor("Mozilla/5.0 (Linux; Android 6.0.1) Chrome/130 Mobile Safari/537.36 (compatible; Googlebot/2.1)", undefined, null)?.kind).toBe("indexa");
  });

  it("counts a person who arrives from an assistant's answer, by referrer or ChatGPT's utm_source", () => {
    const chrome = "Mozilla/5.0 (Macintosh) Chrome/131.0 Safari/537.36";
    expect(visitor(chrome, "https://chatgpt.com/", null)).toEqual({ agent: "desde ChatGPT", kind: "persona desde una IA" });
    expect(visitor(chrome, undefined, "chatgpt.com")?.agent).toBe("desde ChatGPT");
    expect(visitor(chrome, "https://www.perplexity.ai/search/abc", null)?.agent).toBe("desde Perplexity");
    expect(visitor(chrome, "https://gemini.google.com/app", null)?.agent).toBe("desde Gemini");
  });

  it("leaves everyone else out, and an odd referrer does not throw", () => {
    const chrome = "Mozilla/5.0 (Macintosh) Chrome/131.0 Safari/537.36";
    expect(visitor(chrome, "https://www.google.com/", null)).toBeUndefined();
    expect(visitor(chrome, "https://chatgpt.com.evil.example/", null)).toBeUndefined();
    expect(visitor(chrome, "no es una url", null)).toBeUndefined();
    expect(visitor(undefined, undefined, null)).toBeUndefined();
  });

  it("only the public pages, without the query", () => {
    for (const p of ["/chile", "/chile/", "/chile/salud-y-belleza", "/chile/marcas/lattafa", "/chile/buscar", "/chile/mcp", "/chile/sitemap.xml", "/robots.txt", "/llms.txt"]) {
      expect(countedPath(p), p).toBe(p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p);
    }
    for (const p of ["/", "/api/x", "/chilex", "/chile/a/b/c", "/chile/%2e%2e", "/chile/Marcas", "/ir/abc", `/chile/${"a".repeat(81)}`]) expect(countedPath(p), p).toBeUndefined();
  });
});

describe("the address the limits use", () => {
  it("is Cloudflare's, else the last forwarded entry, never a value the client put first", () => {
    expect(requestIp({ "cf-connecting-ip": "200.1.1.1", "x-forwarded-for": "10.0.0.1, 200.1.1.9" }, "127.0.0.1", true)).toBe("200.1.1.1");
    expect(requestIp({ "cf-connecting-ip": "10.9.9.9", "x-forwarded-for": "10.0.0.1, 200.1.1.9" }, "127.0.0.1", false)).toBe("200.1.1.9");
    expect(requestIp({ "x-forwarded-for": "10.0.0.1, 200.1.1.1" }, "127.0.0.1", true)).toBe("200.1.1.1");
    expect(requestIp({}, "127.0.0.1", true)).toBe("127.0.0.1");
    expect(requestIp({ "x-forwarded-for": "" }, undefined, false)).toBe("?");
  });
});

describe("the counts", () => {
  const bot = { agent: "OAI-SearchBot (OpenAI)", kind: "indexa" as const };
  const user = { agent: "ChatGPT-User (OpenAI)", kind: "lee para una persona" as const };

  it("add up per day, agent and page, are emptied when drained, and stop growing past their cap", () => {
    const c = new VisitCounter(3);
    const day = new Date("2026-11-22T12:00:00Z");
    c.hit(bot, "/chile", day);
    c.hit(bot, "/chile", day);
    c.hit(user, "/chile/marcas/lattafa", day);
    c.hit(bot, "/chile", new Date("2026-11-23T01:00:00Z"));
    c.hit(bot, "/chile/buscar", day);
    expect(c.drain()).toEqual([
      { day: "2026-11-22", agent: bot.agent, kind: "indexa", path: "/chile", n: 2 },
      { day: "2026-11-22", agent: user.agent, kind: "lee para una persona", path: "/chile/marcas/lattafa", n: 1 },
      { day: "2026-11-23", agent: bot.agent, kind: "indexa", path: "/chile", n: 1 },
    ]);
    expect(c.drain()).toEqual([]);
  });

  it("are stored by adding, the same in SQLite and Postgres, and reported per kind and agent", async () => {
    const rows = [
      { day: "2026-11-22", agent: bot.agent, kind: "indexa" as const, path: "/chile", n: 2 },
      { day: "2026-11-22", agent: user.agent, kind: "lee para una persona" as const, path: "/chile/marcas/lattafa", n: 1 },
    ];
    const local = sqliteStore(openDb(":memory:"));
    await local.addVisits(rows);
    await local.addVisits([rows[0]!]);
    const pglite = new PGlite();
    const q = pglite as unknown as Queryable;
    await migrate(q);
    const pg = pgStore(q);
    await pg.addVisits(rows);
    await pg.addVisits([rows[0]!]);
    for (const store of [local, pg]) {
      const got = await store.visits("2026-11-01");
      expect(got.find((r) => r.path === "/chile")!.n).toBe(4);
      expect(await store.visits("2026-11-23")).toEqual([]);
      const report = visitsReport(got);
      expect(report).toContain("Del 2026-11-22 al 2026-11-22 (días en UTC): 5 visitas contadas.");
      expect(report).toContain("lee para una persona: 1");
      expect(report).toContain("ChatGPT-User (OpenAI): 1 en 1 páginas. /chile/marcas/lattafa 1");
    }
    await pglite.close();
  }, 30_000);
});
