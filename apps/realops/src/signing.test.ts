import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";

import type { AgentPeyClient, ConsentSessionResource } from "./agentpey.js";
import { createMemoryStore, type RealOpsStore } from "./accounts.js";
import { createRealOpsServer } from "./app.js";
import type { PilotTargets, ProposedGrant } from "./permissions.js";

const TARGETS: PilotTargets = {
  venueId: "signaldesk:GB4D4PLLFEIKZK6MDW42MZRQ5XMPC6QRJN4FFRODO6D3PRB3MDGGYOOF",
  assetId: "USDC:CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  payTo: "GB4D4PLLFEIKZK6MDW42MZRQ5XMPC6QRJN4FFRODO6D3PRB3MDGGYOOF",
  products: {
    market_brief: ["signaldesk:market-brief-xlm-usdc"],
    ai_credits: ["signaldesk:ai-credits-1000"],
  },
};

/** A fake `/v1` that records what it was asked, so the test can inspect the request. */
function fakeAgentPey() {
  const calls: { tenants: string[]; grants: ProposedGrant[]; returnUrls: string[]; idempotencyKeys: string[] } = {
    tenants: [],
    grants: [],
    returnUrls: [],
    idempotencyKeys: [],
  };
  let session: ConsentSessionResource = {
    id: "cns_01J7QW8VQEJPAXEPAYREALOPS01",
    status: "pending",
    consent_url: "https://agentpey.example/consent/cns_01J7QW8VQEJPAXEPAYREALOPS01",
    return_url: null,
    mandate_id: null,
    expires_at: "2026-09-13T00:00:00.000Z",
  };

  const client: AgentPeyClient = {
    async ensureTenant(externalRef) {
      calls.tenants.push(externalRef);
      return { id: "ptn_x:tenant1", external_ref: externalRef };
    },
    async createConsentSession(input) {
      calls.grants.push(input.grant);
      calls.returnUrls.push(input.returnUrl);
      calls.idempotencyKeys.push(input.idempotencyKey);
      return session;
    },
    async readConsentSession() {
      return session;
    },
    async listMandates() {
      return [];
    },
    async purchase() {
      throw new Error("signing.test.ts does not buy — see purchasing.test.ts");
    },
    async readActivity(tenantId) {
      return { tenant_id: tenantId, mandate: null, per_day: null, rail: null, purchases: [], refusals: [] };
    },
  };

  return {
    client,
    calls,
    complete(mandateId: string) {
      session = { ...session, status: "completed", consent_url: null, mandate_id: mandateId };
    },
  };
}

const store: RealOpsStore = createMemoryStore();
const agentpey = fakeAgentPey();
const sent: { email: string; link: string }[] = [];

const server = createRealOpsServer({
  store,
  agentpey: agentpey.client,
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

function form(fields: Record<string, string> = {}, cookie?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  };
}

async function signIn(email: string): Promise<string> {
  const before = sent.length;
  await fetch(`${baseUrl}/entrar`, form({ email, alias: "Tester" }));
  const link = sent[before]!.link.replace("http://127.0.0.1/", `${baseUrl}/`);
  const cookie = (await fetch(link, { redirect: "manual" })).headers.get("set-cookie")!;
  return cookie.split(";")[0]!;
}

async function configureAgent(cookie: string): Promise<string> {
  const created = await fetch(
    `${baseUrl}/agentes`,
    form({ kind: "market_brief", label: "Mi agente", perTx: "0.30", perDay: "0.60", validForDays: "30" }, cookie),
  );
  return created.headers.get("location")!.slice("/agentes/".length);
}

describe("starting a signature", () => {
  it("sends the person to AgentPey's consent page, not to one of ours", async () => {
    const cookie = await signIn("firma@ejemplo.cl");
    const agentId = await configureAgent(cookie);

    const response = await fetch(`${baseUrl}/agentes/${agentId}/firmar`, form({}, cookie));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://agentpey.example/consent/cns_01J7QW8VQEJPAXEPAYREALOPS01",
    );
  });

  it("identifies the person to AgentPey by the random reference, never by their email", async () => {
    expect(agentpey.calls.tenants.every((ref) => ref.startsWith("rop_"))).toBe(true);
    expect(agentpey.calls.tenants.join(" ")).not.toContain("@");
  });

  /**
   * The review screen and the request have to say the same thing. They do
   * because one function builds the grant and both use what it built.
   */
  it("proposes exactly the grant the review screen showed", async () => {
    const cookie = await signIn("mismo@ejemplo.cl");
    const agentId = await configureAgent(cookie);
    const shown = await (await fetch(`${baseUrl}/agentes/${agentId}`, { headers: { cookie } })).text();

    const before = agentpey.calls.grants.length;
    await fetch(`${baseUrl}/agentes/${agentId}/firmar`, form({}, cookie));
    const sentGrant = agentpey.calls.grants[before]!;

    expect(sentGrant.products).toEqual(["signaldesk:market-brief-xlm-usdc"]);
    expect(sentGrant.limits).toEqual({ perTx: "0.30", perDay: "0.60", currency: "USDC" });
    for (const value of [...sentGrant.venues, ...sentGrant.assets, ...sentGrant.products, ...sentGrant.payTo]) {
      expect(shown).toContain(value);
    }
  });

  it("asks to come back to its own origin, and keys the invitation to the agent", async () => {
    const cookie = await signIn("volver@ejemplo.cl");
    const agentId = await configureAgent(cookie);

    const before = agentpey.calls.returnUrls.length;
    await fetch(`${baseUrl}/agentes/${agentId}/firmar`, form({}, cookie));

    expect(agentpey.calls.returnUrls[before]).toBe(`http://127.0.0.1/agentes/${agentId}/volver`);
    // Same key for the same agent: a double click reuses the invitation
    // instead of minting a second one for the same permission.
    expect(agentpey.calls.idempotencyKeys[before]).toBe(`consent-${agentId}`);
  });

  it("refuses to start a signature for someone else's agent", async () => {
    const mine = await signIn("mio2@ejemplo.cl");
    const theirs = await signIn("suyo2@ejemplo.cl");
    const agentId = await configureAgent(theirs);

    const response = await fetch(`${baseUrl}/agentes/${agentId}/firmar`, form({}, mine));

    expect(response.status).toBe(404);
  });
});

describe("coming back from signing", () => {
  it("believes AgentPey about what happened, not the browser", async () => {
    const cookie = await signIn("retorno@ejemplo.cl");
    const agentId = await configureAgent(cookie);
    await fetch(`${baseUrl}/agentes/${agentId}/firmar`, form({}, cookie));

    // Coming back while the session is still pending records nothing.
    await fetch(`${baseUrl}/agentes/${agentId}/volver`, { headers: { cookie }, redirect: "manual" });
    expect((await store.findAgent(await accountIdFor(cookie, agentId), agentId))?.mandateId).toBeNull();

    // Once AgentPey says it completed, and only then, the mandate is recorded.
    agentpey.complete("mnd_01J7QW8VQEJPAXEPAYREALOPS09");
    const back = await fetch(`${baseUrl}/agentes/${agentId}/volver`, { headers: { cookie }, redirect: "manual" });

    expect(back.status).toBe(302);
    const review = await (await fetch(`${baseUrl}/agentes/${agentId}`, { headers: { cookie } })).text();
    expect(review).toContain("mnd_01J7QW8VQEJPAXEPAYREALOPS09");
    expect(review).toContain("Firmado");
  });

  /**
   * Signing is what unlocks asking for something. Before it, "Mis servicios"
   * says so instead of showing a form that could only fail.
   */
  it("unlocks the instruction form on Mis servicios once a permission is signed", async () => {
    const cookie = await signIn("servicios@ejemplo.cl");
    const agentId = await configureAgent(cookie);

    const before = await (await fetch(`${baseUrl}/servicios`, { headers: { cookie } })).text();
    expect(before).toContain("Todavía no tienes ningún agente con permiso firmado");
    expect(before).not.toContain('name="instruction"');

    await fetch(`${baseUrl}/agentes/${agentId}/firmar`, form({}, cookie));
    await fetch(`${baseUrl}/agentes/${agentId}/volver`, { headers: { cookie }, redirect: "manual" });

    const after = await (await fetch(`${baseUrl}/servicios`, { headers: { cookie } })).text();
    expect(after).toContain('name="instruction"');
  });

  /**
   * RealOps cannot revoke, by design (`mandates:revoke` is not a scope). What
   * it can do is send the person to the page where they revoke it themselves,
   * with their own wallet, and say so.
   */
  it("links to AgentPey's revocation page, and is honest that it cannot revoke", async () => {
    const cookie = await signIn("revocar@ejemplo.cl");
    const agentId = await configureAgent(cookie);
    await fetch(`${baseUrl}/agentes/${agentId}/firmar`, form({}, cookie));
    await fetch(`${baseUrl}/agentes/${agentId}/volver`, { headers: { cookie }, redirect: "manual" });

    const html = await (await fetch(`${baseUrl}/agentes/${agentId}`, { headers: { cookie } })).text();

    expect(html).toContain("https://agentpey.example/revocar/mnd_01J7QW8VQEJPAXEPAYREALOPS09");
    expect(html).toContain("RealOps no puede revocar por ti");
    expect(html).toContain("RealOps cannot revoke for you");
  });

  it("404s a return for an agent that never started signing", async () => {
    const cookie = await signIn("nunca@ejemplo.cl");
    const agentId = await configureAgent(cookie);

    const response = await fetch(`${baseUrl}/agentes/${agentId}/volver`, { headers: { cookie }, redirect: "manual" });

    expect(response.status).toBe(404);
  });
});

describe("with no AgentPey configured", () => {
  it("says so instead of crashing", async () => {
    const soloStore = createMemoryStore();
    const soloSent: { email: string; link: string }[] = [];
    const solo = createRealOpsServer({
      store: soloStore,
      targets: TARGETS,
      signalDeskUrl: "https://signaldesk.example",
      agentpeyBaseUrl: "https://agentpey.example",
      baseUrl: "http://127.0.0.1",
      delivery: { mode: "email", send: async (email, link) => void soloSent.push({ email, link }) },
      secureCookies: false,
    });
    await new Promise<void>((resolve) => solo.listen(0, "127.0.0.1", resolve));
    const soloUrl = `http://127.0.0.1:${(solo.address() as AddressInfo).port}`;

    try {
      await fetch(`${soloUrl}/entrar`, form({ email: "solo@ejemplo.cl", alias: "Solo" }));
      const link = soloSent[0]!.link.replace("http://127.0.0.1/", `${soloUrl}/`);
      const cookie = (await fetch(link, { redirect: "manual" })).headers.get("set-cookie")!.split(";")[0]!;
      const created = await fetch(
        `${soloUrl}/agentes`,
        form({ kind: "ai_credits", label: "Solo", perTx: "0.10", perDay: "0.20", validForDays: "7" }, cookie),
      );
      const agentId = created.headers.get("location")!.slice("/agentes/".length);

      const response = await fetch(`${soloUrl}/agentes/${agentId}/firmar`, form({}, cookie));

      expect(response.status).toBe(503);
      expect(await response.text()).toContain("no está conectada a AgentPey");
    } finally {
      await new Promise<void>((resolve, reject) => solo.close((error) => (error === undefined ? resolve() : reject(error))));
    }
  });
});

/** The account behind a cookie — tests reach into the store, the app never does. */
async function accountIdFor(cookie: string, agentId: string): Promise<string> {
  const sessionId = decodeURIComponent(cookie.split("=").slice(1).join("="));
  const session = await store.findSession(sessionId);
  if (session === undefined) throw new Error(`no session for agent ${agentId}`);
  return session.accountId;
}
