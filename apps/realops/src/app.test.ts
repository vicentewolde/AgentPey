import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";

import { createMemoryStore, type RealOpsStore } from "./accounts.js";
import { SESSION_COOKIE, createRealOpsServer } from "./app.js";
import type { PilotTargets } from "./permissions.js";

const TARGETS: PilotTargets = {
  venueId: "signaldesk:GB4D4PLLFEIKZK6MDW42MZRQ5XMPC6QRJN4FFRODO6D3PRB3MDGGYOOF",
  assetId: "USDC:CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  payTo: "GB4D4PLLFEIKZK6MDW42MZRQ5XMPC6QRJN4FFRODO6D3PRB3MDGGYOOF",
  products: {
    market_brief: ["signaldesk:market-brief-xlm-usdc"],
    ai_credits: ["signaldesk:ai-credits-1000"],
  },
};

const store: RealOpsStore = createMemoryStore();
const sent: { email: string; link: string }[] = [];

const server = createRealOpsServer({
  store,
  targets: TARGETS,
  signalDeskUrl: "https://signaldesk.example",
  agentpeyBaseUrl: "https://agentpey.example",
  baseUrl: "http://127.0.0.1",
  delivery: { mode: "email", send: async (email, link) => void sent.push({ email, link }) },
  secureCookies: false,
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;
const baseUrl = `http://127.0.0.1:${port}`;

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))));
});

function form(fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  };
}

/** Signs in end to end and returns the session cookie. */
async function signIn(email: string, alias: string): Promise<string> {
  const before = sent.length;
  await fetch(`${baseUrl}/entrar`, form({ email, alias }));
  const link = sent[before]!.link.replace("http://127.0.0.1/", `${baseUrl}/`);
  const response = await fetch(link, { redirect: "manual" });
  const cookie = response.headers.get("set-cookie");
  if (cookie === null) throw new Error("no session cookie was issued");
  return cookie.split(";")[0]!;
}

describe("the public pages", () => {
  it("carries the live testnet badge, both languages and the switch on every page, by construction", async () => {
    for (const path of ["/", "/entrar"]) {
      const html = await (await fetch(`${baseUrl}${path}`)).text();
      expect(html).toContain("Stellar Testnet · live");
      expect(html).toContain("Stellar Testnet · en vivo");
      expect(html).toContain('data-set-lang="es"');
      expect(html).toContain('<html lang="en"');
    }
  });

  it("links to SignalDesk, so a visitor can check both services exist", async () => {
    expect(await (await fetch(baseUrl)).text()).toContain("https://signaldesk.example");
  });

  it("says the signature happens on AgentPey's domain, not here", async () => {
    const html = await (await fetch(baseUrl)).text();

    expect(html).toContain("No autoriza pagos");
    expect(html).toContain("dominio de AgentPey");
  });
});

describe("signing in", () => {
  it("sends a link and does not reveal whether the account already existed", async () => {
    const before = sent.length;
    const first = await fetch(`${baseUrl}/entrar`, form({ email: "nuevo@ejemplo.cl", alias: "Nuevo" }));
    const firstBody = await first.text();
    const second = await fetch(`${baseUrl}/entrar`, form({ email: "nuevo@ejemplo.cl", alias: "Nuevo" }));

    expect(sent.length).toBe(before + 2);
    expect(await second.text()).toBe(firstBody);
  });

  it("puts only a link in the email — nothing worth intercepting", async () => {
    await fetch(`${baseUrl}/entrar`, form({ email: "solo-link@ejemplo.cl", alias: "Link" }));
    const last = sent.at(-1)!;

    expect(last.link).toContain("/entrar/");
    expect(last.email).toBe("solo-link@ejemplo.cl");
  });

  it("issues an HttpOnly, SameSite=Lax session cookie", async () => {
    const before = sent.length;
    await fetch(`${baseUrl}/entrar`, form({ email: "cookie@ejemplo.cl", alias: "Cookie" }));
    const link = sent[before]!.link.replace("http://127.0.0.1/", `${baseUrl}/`);
    const header = (await fetch(link, { redirect: "manual" })).headers.get("set-cookie") ?? "";

    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain(SESSION_COOKIE);
  });

  /** One use. A link that worked twice is a link an interception can replay. */
  it("refuses a link that was already used, and says so", async () => {
    const before = sent.length;
    await fetch(`${baseUrl}/entrar`, form({ email: "unavez@ejemplo.cl", alias: "Una" }));
    const link = sent[before]!.link.replace("http://127.0.0.1/", `${baseUrl}/`);

    const first = await fetch(link, { redirect: "manual" });
    const second = await fetch(link, { redirect: "manual" });

    expect(first.status).toBe(302);
    expect(second.status).toBe(400);
    expect(await second.text()).toContain("una sola vez");
  });

  it("refuses a token that never existed", async () => {
    const response = await fetch(`${baseUrl}/entrar/no-existe`, { redirect: "manual" });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("no existe");
  });

  it("refuses a malformed email or alias without creating an account", async () => {
    const before = sent.length;
    const response = await fetch(`${baseUrl}/entrar`, form({ email: "no-es-un-correo", alias: "X" }));

    expect(response.status).toBe(400);
    expect(sent.length).toBe(before);
  });
});

describe("what needs a session", () => {
  it("sends a visitor with no session to the sign-in page", async () => {
    for (const path of ["/agentes", "/servicios"]) {
      const response = await fetch(`${baseUrl}${path}`, { redirect: "manual" });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/entrar");
    }
  });

  it("does not accept an invented session cookie", async () => {
    const response = await fetch(`${baseUrl}/agentes`, {
      headers: { cookie: `${SESSION_COOKIE}=inventada` },
      redirect: "manual",
    });

    expect(response.status).toBe(302);
  });
});

describe("agents", () => {
  it("configures one and shows the literal grant on the review screen", async () => {
    const cookie = await signIn("agente@ejemplo.cl", "Agente");
    const created = await fetch(`${baseUrl}/agentes`, {
      ...form({ kind: "market_brief", label: "Mi agente", perTx: "0.30", perDay: "0.60", validForDays: "30" }),
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    });

    expect(created.status).toBe(302);
    const review = await fetch(`${baseUrl}${created.headers.get("location")}`, { headers: { cookie } });
    const html = await review.text();

    // The grant itself, not a paraphrase of it.
    expect(html).toContain("signaldesk:market-brief-xlm-usdc");
    expect(html).toContain(TARGETS.venueId);
    expect(html).toContain("&quot;perTx&quot;: &quot;0.30&quot;");
    // And the honesty marks.
    expect(html).toContain("firmado");
    expect(html).toContain("on-chain");
  });

  it("refuses limits that are not amounts", async () => {
    const cookie = await signIn("malos@ejemplo.cl", "Malos");
    const response = await fetch(`${baseUrl}/agentes`, {
      ...form({ kind: "market_brief", label: "X", perTx: "muchísimo", perDay: "0.60", validForDays: "30" }),
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    });

    expect(response.status).toBe(400);
  });

  /**
   * `PILOTO-F9.md` § 3.4: the browser never names whose data to show. Another
   * account's agent is a 404, not a 403 — the same posture `/v1` takes, so an
   * id cannot be probed for existence.
   */
  it("answers 404 for another account's agent, never 403", async () => {
    const mine = await signIn("mio@ejemplo.cl", "Mio");
    const theirs = await signIn("suyo@ejemplo.cl", "Suyo");

    const created = await fetch(`${baseUrl}/agentes`, {
      ...form({ kind: "ai_credits", label: "Suyo", perTx: "0.30", perDay: "0.60", validForDays: "30" }),
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: theirs },
    });
    const path = created.headers.get("location")!;

    expect((await fetch(`${baseUrl}${path}`, { headers: { cookie: theirs } })).status).toBe(200);
    expect((await fetch(`${baseUrl}${path}`, { headers: { cookie: mine } })).status).toBe(404);
  });
});

describe("instructions", () => {
  it("shows what it read and offers both products when it does not understand", async () => {
    const cookie = await signIn("instru@ejemplo.cl", "Instru");
    const response = await fetch(`${baseUrl}/instruccion`, {
      ...form({ instruction: "hola que tal" }),
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("No adivinamos");
    expect(html).toContain("hola que tal");
    expect(html).toContain("informe de mercado");
    expect(html).toContain("créditos de IA");
  });

  it("escapes what the person typed rather than rendering it", async () => {
    const cookie = await signIn("xss@ejemplo.cl", "XSS");
    const response = await fetch(`${baseUrl}/instruccion`, {
      ...form({ instruction: "<img src=x onerror=alert(1)>" }),
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    });
    const html = await response.text();

    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });
});

describe("deleting an account", () => {
  it("erases the email, drops the sessions, and says what it does not erase", async () => {
    const cookie = await signIn("borrar@ejemplo.cl", "Borrar");

    const services = await (await fetch(`${baseUrl}/servicios`, { headers: { cookie } })).text();
    expect(services).toContain("No borra tu Mandato");

    const response = await fetch(`${baseUrl}/cuenta/borrar`, {
      ...form({}),
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    });

    expect(response.status).toBe(302);
    expect(await store.findAccountByEmail("borrar@ejemplo.cl")).toBeUndefined();
    // The session is gone too: the same cookie no longer reaches a page.
    expect((await fetch(`${baseUrl}/agentes`, { headers: { cookie }, redirect: "manual" })).headers.get("location")).toBe(
      "/entrar",
    );
  });
});
