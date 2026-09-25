import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";

import type { AgentPeyClient, PurchaseResource, TenantActivity } from "./agentpey.js";
import { createMemoryStore, type RealOpsStore } from "./accounts.js";
import { createRealOpsServer } from "./app.js";
import { SIGNALDESK_VENUE_ID, TEST_TARGETS } from "./testing.js";

const VENUE = SIGNALDESK_VENUE_ID;

const TARGETS = TEST_TARGETS;

interface PurchaseCall {
  readonly tenantId: string;
  readonly venue: string;
  readonly productId: string;
  readonly quantity: number;
  readonly routeParams?: Readonly<Record<string, string | number>>;
  readonly mandateId?: string;
  readonly idempotencyKey: string;
}

function settled(overrides: Partial<PurchaseResource> = {}): PurchaseResource {
  return {
    id: "pur_01J7QW8VQEJPAXEPAYBUY0001",
    outcome: "settled",
    code: null,
    reason: null,
    product_id: "signaldesk:market-brief-xlm-usdc",
    total: "0.2500000",
    asset: "USDC:CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    transaction_hash: "aaf0ea0d08a3103086964a7238884eaf1c9ef23064b151081ada3939f99fed4d",
    explorer_url: "https://stellar.expert/explorer/testnet/tx/aaf0ea0d08a3103086964a7238884eaf1c9ef23064b151081ada3939f99fed4d",
    delivery: {
      delivery_id: "01M2BQBTSJG9B3M6R53AZ681T4",
      artifact_url: "https://signaldesk.example/deliveries/01M2BQBTSJG9B3M6R53AZ681T4",
      receipt_hash: "a".repeat(64),
    },
    created_at: "2026-09-12T21:11:22.000Z",
    ...overrides,
  };
}

function fakeAgentPey() {
  const purchases: PurchaseCall[] = [];
  // One consent session per signature, and one Mandate per session, so two
  // agents of the same account end up with two different Mandates (T90).
  let consentSeq = 0;
  let activity: TenantActivity = {
    tenant_id: "ptn_x:tenant1",
    mandate: null,
    per_day: null,
    rail: null,
    purchases: [],
    refusals: [],
  };
  let next: PurchaseResource | Error = settled();

  const client: AgentPeyClient = {
    async ensureTenant(externalRef) {
      return { id: "ptn_x:tenant1", external_ref: externalRef };
    },
    async createConsentSession() {
      consentSeq += 1;
      const id = `cns_${String(consentSeq).padStart(26, "0")}`;
      return {
        id,
        status: "pending",
        consent_url: `https://agentpey.example/consent/${id}`,
        return_url: null,
        mandate_id: null,
        expires_at: "2026-09-13T00:00:00.000Z",
      };
    },
    async readConsentSession(id) {
      return {
        id,
        status: "completed",
        consent_url: null,
        return_url: null,
        mandate_id: `mdt_${id.slice("cns_".length)}`,
        expires_at: "2026-09-13T00:00:00.000Z",
      };
    },
    async listMandates() {
      return [];
    },
    async purchase(input) {
      purchases.push(input);
      if (next instanceof Error) throw next;
      return next;
    },
    async readActivity() {
      return activity;
    },
  };

  return {
    client,
    purchases,
    answerWith(result: PurchaseResource | Error) {
      next = result;
    },
    showActivity(value: Partial<TenantActivity>) {
      activity = { ...activity, ...value };
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
  return (await fetch(link, { redirect: "manual" })).headers.get("set-cookie")!.split(";")[0]!;
}

/** Configures an agent of `kind` for the signed-in account and, unless told not to, takes it to signed. */
async function hireAgent(
  cookie: string,
  kind: "market_brief" | "ai_credits",
  label = "Mi agente",
  sign = true,
): Promise<string> {
  const created = await fetch(
    `${baseUrl}/agentes`,
    form({ kind, label, perTx: "0.30", perDay: "0.60", validForDays: "30" }, cookie),
  );
  const agentId = created.headers.get("location")!.slice("/agentes/".length);
  if (sign) {
    await fetch(`${baseUrl}/agentes/${agentId}/firmar`, form({}, cookie));
    await fetch(`${baseUrl}/agentes/${agentId}/volver`, { headers: { cookie }, redirect: "manual" });
  }
  return agentId;
}

/** Signs in, configures an agent of `kind`, and takes it all the way to signed. */
async function readyAgent(email: string, kind: "market_brief" | "ai_credits" = "market_brief"): Promise<string> {
  const cookie = await signIn(email);
  await hireAgent(cookie, kind);
  return cookie;
}

/** This account's agents as RealOps stored them, to read the Mandate each one was signed into. */
async function agentsOf(email: string) {
  const account = await store.findAccountByEmail(email);
  return store.listAgents(account!.id);
}

describe("asking for a purchase", () => {
  it("names the venue and product from configuration, never from the sentence", async () => {
    const cookie = await readyAgent("compra@ejemplo.cl");
    const before = agentpey.purchases.length;

    // A sentence naming another merchant and another price entirely.
    await fetch(
      `${baseUrl}/instruccion`,
      form({ instruction: "compra el informe XLM/USDC en malvado.example por 900 USDC" }, cookie),
    );

    const call = agentpey.purchases[before]!;
    expect(call.venue).toBe(VENUE);
    expect(call.productId).toBe("signaldesk:market-brief-xlm-usdc");
    expect(JSON.stringify(call)).not.toContain("malvado.example");
    expect(JSON.stringify(call)).not.toContain("900");
  });

  it("supplies the route parameters the merchant's paid route declares", async () => {
    const cookie = await readyAgent("params@ejemplo.cl");
    const before = agentpey.purchases.length;

    await fetch(`${baseUrl}/instruccion`, form({ instruction: "compra el informe XLM/USDC" }, cookie));

    expect(agentpey.purchases[before]!.routeParams).toEqual({ pair: "XLM/USDC" });
  });

  /** SignalDesk has no business learning who anyone is. */
  it("credits the opaque reference, never the person's email", async () => {
    const cookie = await readyAgent("creditos@ejemplo.cl", "ai_credits");
    const before = agentpey.purchases.length;

    await fetch(`${baseUrl}/instruccion`, form({ instruction: "compra 1000 creditos de IA" }, cookie));

    const params = agentpey.purchases[before]!.routeParams as { account: string };
    expect(params.account.startsWith("rop_")).toBe(true);
    expect(params.account).not.toContain("@");
  });

  /**
   * C-98 as amended in T84: one key per rendered form, not per attempt. In the
   * deployed pilot a purchase outlived RealOps' timeout, the person was told
   * it failed, and a resubmit would have paid again under a fresh key.
   */
  describe("idempotency, one key per rendered form", () => {
    async function formKey(cookie: string): Promise<string> {
      const html = await (await fetch(`${baseUrl}/servicios`, { headers: { cookie } })).text();
      const match = /name="request_key" value="([^"]+)"/.exec(html);
      expect(match).not.toBeNull();
      return match![1]!;
    }

    it("sending the same form twice asks with the same key, so AgentPey replays instead of paying again", async () => {
      const cookie = await readyAgent("reenvio@ejemplo.cl");
      const key = await formKey(cookie);
      const before = agentpey.purchases.length;

      const fields = { instruction: "compra el informe XLM/USDC", request_key: key };
      await fetch(`${baseUrl}/instruccion`, form(fields, cookie));
      await fetch(`${baseUrl}/instruccion`, form(fields, cookie));

      const [first, second] = agentpey.purchases.slice(before);
      expect(first!.idempotencyKey).toBe(second!.idempotencyKey);
      expect(first!.idempotencyKey).toContain(key);
    });

    it("asking again from a fresh page is a new purchase", async () => {
      const cookie = await readyAgent("dos@ejemplo.cl");
      const before = agentpey.purchases.length;

      await fetch(`${baseUrl}/instruccion`, form({ instruction: "compra el informe XLM/USDC", request_key: await formKey(cookie) }, cookie));
      await fetch(`${baseUrl}/instruccion`, form({ instruction: "compra el informe XLM/USDC", request_key: await formKey(cookie) }, cookie));

      const [first, second] = agentpey.purchases.slice(before);
      expect(first!.idempotencyKey).not.toBe(second!.idempotencyKey);
    });

    it("still buys from a form that predates the key, and ignores a key that is not a uuid", async () => {
      const cookie = await readyAgent("viejo@ejemplo.cl");
      const before = agentpey.purchases.length;

      await fetch(`${baseUrl}/instruccion`, form({ instruction: "compra el informe XLM/USDC" }, cookie));
      await fetch(`${baseUrl}/instruccion`, form({ instruction: "compra el informe XLM/USDC", request_key: "x\r\ninjected" }, cookie));

      const [first, second] = agentpey.purchases.slice(before);
      expect(first).toBeDefined();
      expect(second!.idempotencyKey).not.toContain("injected");
    });

    it("the fallback buttons carry a key too", async () => {
      const cookie = await readyAgent("botones@ejemplo.cl");

      const html = await (await fetch(`${baseUrl}/instruccion`, form({ instruction: "hola" }, cookie))).text();

      expect(html).toMatch(/name="request_key" value="[0-9a-f-]{36}"/);
    });
  });

  it("on a timeout, says the purchase may have completed instead of saying it failed", async () => {
    const cookie = await readyAgent("lento@ejemplo.cl");
    const { AgentPassError } = await import("@agentpass/core");
    agentpey.answerWith(
      new AgentPassError("NetworkError", "AgentPey no respondió a tiempo", { details: { path: "/v1/purchases", timedOut: true } }),
    );

    const response = await fetch(`${baseUrl}/instruccion`, form({ instruction: "compra el informe XLM/USDC" }, cookie));

    expect(response.status).toBe(504);
    const html = await response.text();
    expect(html).toContain("puede haberse completado");
    expect(html).not.toContain("no se pudo hablar");
    agentpey.answerWith(settled());
  });

  it("on a rate limit, says nothing was bought and when to try again (T95)", async () => {
    // AgentPey counts a request before doing anything else, so unlike a
    // timeout this one is certain: the purchase was never attempted.
    const cookie = await readyAgent("apurado@ejemplo.cl");
    const { AgentPassError } = await import("@agentpass/core");
    agentpey.answerWith(
      new AgentPassError("CommandFailed", "this api key made more than 10 costly requests in a minute", {
        details: { path: "/v1/purchases", status: 429, code: "RateLimited" },
      }),
    );

    const response = await fetch(`${baseUrl}/instruccion`, form({ instruction: "compra el informe XLM/USDC" }, cookie));

    expect(response.status).toBe(429);
    const html = await response.text();
    expect(html).toContain("no se compró nada");
    expect(html).toContain("Espera un minuto");
    // Not the "may have completed" of a timeout, and not "could not reach".
    expect(html).not.toContain("puede haberse completado");
    expect(html).not.toContain("no se pudo hablar");
    agentpey.answerWith(settled());
  });

  it("refuses to buy for a kind the person has no signed permission for", async () => {
    const cookie = await readyAgent("solobrief@ejemplo.cl", "market_brief");
    const before = agentpey.purchases.length;

    const response = await fetch(`${baseUrl}/instruccion`, form({ instruction: "compra 1000 creditos de IA" }, cookie));

    expect(response.status).toBe(409);
    expect(await response.text()).toContain("permiso firmado");
    expect(agentpey.purchases.length).toBe(before);
  });

  it("does not ask for anything when the sentence was not understood", async () => {
    const cookie = await readyAgent("nada@ejemplo.cl");
    const before = agentpey.purchases.length;

    const response = await fetch(`${baseUrl}/instruccion`, form({ instruction: "hola" }, cookie));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("No adivinamos");
    expect(agentpey.purchases.length).toBe(before);
  });

  it("says the request failed, without pretending the purchase was refused", async () => {
    const cookie = await readyAgent("caido@ejemplo.cl");
    agentpey.answerWith(new Error("connection reset"));

    const response = await fetch(`${baseUrl}/instruccion`, form({ instruction: "compra el informe XLM/USDC" }, cookie));

    expect(response.status).toBe(502);
    agentpey.answerWith(settled());
  });
});

/**
 * T90, decided by the user: when more than one signed agent could buy what was
 * asked, the person chooses, and AgentPey is told exactly which Mandate to go
 * through. RealOps still authorises nothing: it names a Mandate, and AgentPey
 * checks it is this tenant's and decides with it.
 */
describe("which agent buys", () => {
  const BRIEF = "compra el informe XLM/USDC";

  function choiceKey(html: string): string {
    const match = /name="request_key" value="([^"]+)"/.exec(html);
    expect(match).not.toBeNull();
    return match![1]!;
  }

  it("with one signed agent, buys straight away, through that agent's own Mandate", async () => {
    const email = "uno-solo@ejemplo.cl";
    const cookie = await readyAgent(email);
    const [agent] = await agentsOf(email);
    const before = agentpey.purchases.length;

    const response = await fetch(`${baseUrl}/instruccion`, form({ instruction: BRIEF }, cookie));

    expect(response.status).toBe(302);
    expect(agentpey.purchases[before]!.mandateId).toBe(agent!.mandateId);
  });

  it("an unsigned agent of the same kind does not make anyone choose", async () => {
    const email = "sin-firmar@ejemplo.cl";
    const cookie = await readyAgent(email);
    await hireAgent(cookie, "market_brief", "Borrador", false);
    const before = agentpey.purchases.length;

    const response = await fetch(`${baseUrl}/instruccion`, form({ instruction: BRIEF }, cookie));

    expect(response.status).toBe(302);
    expect(agentpey.purchases.length).toBe(before + 1);
  });

  it("with two signed agents of the kind, asks which one, and asks AgentPey for nothing yet", async () => {
    const cookie = await signIn("dos-agentes@ejemplo.cl");
    const first = await hireAgent(cookie, "market_brief", "Informes A");
    const second = await hireAgent(cookie, "market_brief", "Informes B");
    await hireAgent(cookie, "ai_credits", "Créditos");
    const key = "6f1c2f9e-7d0a-4c5b-9a55-0e7f0b7f3a11";
    const before = agentpey.purchases.length;

    const response = await fetch(`${baseUrl}/instruccion`, form({ instruction: BRIEF, request_key: key }, cookie));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("¿Qué agente lo compra?");
    expect(html).toContain(`name="agent_id" value="${first}"`);
    expect(html).toContain(`name="agent_id" value="${second}"`);
    // Only agents that can buy this: the credits agent is not offered for a report.
    expect(html.match(/name="agent_id"/g)).toHaveLength(2);
    // The same form's key and sentence ride along with every choice.
    expect(choiceKey(html)).toBe(key);
    expect(html).toContain(`name="instruction" value="${BRIEF}"`);
    expect(html).toContain("El gasto del día se suma entre tus agentes");
    expect(agentpey.purchases.length).toBe(before);
  });

  it("buys through the chosen agent's Mandate, keyed by the form rather than the agent", async () => {
    const email = "elige@ejemplo.cl";
    const cookie = await signIn(email);
    await hireAgent(cookie, "market_brief", "Informes A");
    const second = await hireAgent(cookie, "market_brief", "Informes B");
    const chosen = (await agentsOf(email)).find((agent) => agent.id === second)!;
    const key = "0b5f8a8e-3c1d-4e2f-8a9b-1c2d3e4f5a6b";
    const before = agentpey.purchases.length;

    const response = await fetch(
      `${baseUrl}/instruccion`,
      form({ instruction: BRIEF, request_key: key, agent_id: second }, cookie),
    );

    expect(response.status).toBe(302);
    const call = agentpey.purchases[before]!;
    expect(call.mandateId).toBe(chosen.mandateId);
    expect(call.idempotencyKey).toBe(`buy-${key}`);
  });

  it("choosing another agent from the same form sends the same key, and says so when AgentPey refuses it", async () => {
    const email = "cambia@ejemplo.cl";
    const cookie = await signIn(email);
    const first = await hireAgent(cookie, "market_brief", "Informes A");
    const second = await hireAgent(cookie, "market_brief", "Informes B");
    const key = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
    const before = agentpey.purchases.length;

    await fetch(`${baseUrl}/instruccion`, form({ instruction: BRIEF, request_key: key, agent_id: first }, cookie));
    const { AgentPassError } = await import("@agentpass/core");
    agentpey.answerWith(
      new AgentPassError("CommandFailed", "this Idempotency-Key was already used with a different request body", {
        details: { path: "/v1/purchases", status: 409, code: "IdempotencyKeyConflict" },
      }),
    );
    const again = await fetch(`${baseUrl}/instruccion`, form({ instruction: BRIEF, request_key: key, agent_id: second }, cookie));
    agentpey.answerWith(settled());

    const [one, two] = agentpey.purchases.slice(before);
    expect(one!.idempotencyKey).toBe(two!.idempotencyKey);
    expect(one!.mandateId).not.toBe(two!.mandateId);
    expect(again.status).toBe(409);
    expect(await again.text()).toContain("Ya pediste esto con otro agente");
  });

  it("refuses an agent of another account, or of another kind, without asking AgentPey", async () => {
    const strangerCookie = await signIn("ajeno@ejemplo.cl");
    const strangers = await hireAgent(strangerCookie, "market_brief", "Ajeno");
    const cookie = await signIn("propio@ejemplo.cl");
    await hireAgent(cookie, "market_brief", "Informes A");
    await hireAgent(cookie, "market_brief", "Informes B");
    const credits = await hireAgent(cookie, "ai_credits", "Créditos");
    const before = agentpey.purchases.length;

    const foreign = await fetch(`${baseUrl}/instruccion`, form({ instruction: BRIEF, agent_id: strangers }, cookie));
    const wrongKind = await fetch(`${baseUrl}/instruccion`, form({ instruction: BRIEF, agent_id: credits }, cookie));

    expect(foreign.status).toBe(400);
    expect(wrongKind.status).toBe(400);
    expect(await wrongKind.text()).toContain("Ese agente no puede comprar esto");
    expect(agentpey.purchases.length).toBe(before);
  });

  it("the product buttons carry the product through the choice, not a sentence", async () => {
    const cookie = await signIn("botones-dos@ejemplo.cl");
    await hireAgent(cookie, "market_brief", "Informes A");
    await hireAgent(cookie, "market_brief", "Informes B");

    const html = await (await fetch(`${baseUrl}/instruccion`, form({ kind: "market_brief" }, cookie))).text();

    expect(html).toContain('name="kind" value="market_brief"');
    expect(html).not.toContain('name="instruction"');
  });

  it("shows on each delivery which agent bought it", async () => {
    const email = "quien-compro@ejemplo.cl";
    const cookie = await signIn(email);
    await hireAgent(cookie, "market_brief", "informes de la mañana");
    const [agent] = await agentsOf(email);
    agentpey.showActivity({ purchases: [settled({ mandate_id: agent!.mandateId })] });

    const html = await (await fetch(`${baseUrl}/servicios`, { headers: { cookie } })).text();
    agentpey.showActivity({ purchases: [] });

    expect(html).toContain("Agente: Informes de la mañana");
  });
});

describe("Mis servicios", () => {
  it("shows a delivery with its receipt and a link to the payment on Stellar", async () => {
    const cookie = await readyAgent("entrega@ejemplo.cl");
    agentpey.showActivity({ purchases: [settled()] });

    const html = await (await fetch(`${baseUrl}/servicios`, { headers: { cookie } })).text();

    expect(html).toContain("entregado");
    expect(html).toContain("https://signaldesk.example/deliveries/01M2BQBTSJG9B3M6R53AZ681T4");
    expect(html).toContain("stellar.expert/explorer/testnet/tx/aaf0ea0d");
    expect(html).toContain("01M2BQBTSJG9B3M6R53AZ681T4");
  });

  /**
   * The person reads the sentence; the code is there for whoever has to debug
   * it. Both, and not one instead of the other.
   */
  it("shows a refusal as a sentence a person can act on, with its code alongside", async () => {
    const cookie = await readyAgent("rechazo@ejemplo.cl");
    agentpey.showActivity({
      purchases: [
        settled({
          id: "pur_01J7QW8VQEJPAXEPAYBUY0002",
          outcome: "refused",
          code: "MandateDailyLimitExceeded",
          reason: "perDay exceeded",
          total: null,
          transaction_hash: null,
          explorer_url: null,
          delivery: null,
        }),
      ],
    });

    const html = await (await fetch(`${baseUrl}/servicios`, { headers: { cookie } })).text();

    expect(html).toContain("rechazado");
    expect(html).toContain("tope diario que firmaste");
    expect(html).toContain("se reinicia mañana");
    expect(html).toContain("MandateDailyLimitExceeded");
  });

  describe("T107: what was bought, and what just happened", () => {
    const refusal = (overrides: Partial<PurchaseResource> = {}): PurchaseResource =>
      settled({
        id: "pur_01J7QW8VQEJPAXEPAYREFUSE1",
        outcome: "refused",
        code: "MandateAmountExceeded",
        reason: "amount above perTx",
        total: null,
        transaction_hash: null,
        explorer_url: null,
        delivery: null,
        ...overrides,
      });

    it("names the product on a delivery and on a refusal, with the id underneath", async () => {
      const cookie = await readyAgent("nombre@ejemplo.cl");
      agentpey.showActivity({ purchases: [settled(), refusal()] });
      const html = await (await fetch(`${baseUrl}/servicios`, { headers: { cookie } })).text();
      expect(html).toContain("Informe de mercado XLM/USDC");
      expect(html).toContain("<code>signaldesk:market-brief-xlm-usdc</code>");
    });

    it("keeps showing the id when the catalogue no longer lists the product", async () => {
      const cookie = await readyAgent("retirado@ejemplo.cl");
      agentpey.showActivity({ purchases: [settled({ product_id: "producto-retirado" })] });
      const html = await (await fetch(`${baseUrl}/servicios`, { headers: { cookie } })).text();
      expect(html).toContain("<h3>producto-retirado</h3>");
    });

    it("after a refused purchase, lands on a page that says it was refused and why", async () => {
      const cookie = await readyAgent("aviso-rechazo@ejemplo.cl");
      agentpey.answerWith(refusal());
      agentpey.showActivity({ purchases: [refusal()] });
      const asked = await fetch(`${baseUrl}/instruccion`, form({ instruction: "compra el informe XLM/USDC" }, cookie));
      expect(asked.headers.get("location")).toBe("/servicios?compra=pur_01J7QW8VQEJPAXEPAYREFUSE1");
      const html = await (await fetch(`${baseUrl}${asked.headers.get("location")!}`, { headers: { cookie } })).text();
      expect(html).toContain('role="alert"');
      expect(html).toContain("Rechazado: Informe de mercado XLM/USDC");
      expect(html).toContain("supera el máximo por compra que firmaste");
      expect(html).toContain("No se pagó nada");
      agentpey.answerWith(settled());
    });

    it("a refusal for lack of funds shows the balance and does not promise a top-up", async () => {
      const cookie = await readyAgent("sin-saldo@ejemplo.cl");
      const broke = refusal({ id: "pur_NOFUNDS", code: "RailInsufficientFunds", reason: "rail balance below the total" });
      agentpey.answerWith(broke);
      agentpey.showActivity({ purchases: [broke], rail: { contract_id: "CARSN", balance: "1.9578947", asset: "USDC", sponsored: true } });
      const asked = await fetch(`${baseUrl}/instruccion`, form({ instruction: "compra el informe XLM/USDC" }, cookie));
      const html = await (await fetch(`${baseUrl}${asked.headers.get("location")!}`, { headers: { cookie } })).text();
      expect(html).toContain("Saldo del contrato que paga: <strong>1.958 USDC</strong>");
      expect(html).toContain("nadie lo recarga solo");
      expect(html).not.toContain("El piloto recarga esas cuentas");
      agentpey.answerWith(settled());
      agentpey.showActivity({ rail: null });
    });

    it("after a settled purchase, says it was bought, with the payment", async () => {
      const cookie = await readyAgent("aviso-compra@ejemplo.cl");
      agentpey.answerWith(settled());
      agentpey.showActivity({ purchases: [settled()] });
      const asked = await fetch(`${baseUrl}/instruccion`, form({ instruction: "compra el informe XLM/USDC" }, cookie));
      const html = await (await fetch(`${baseUrl}${asked.headers.get("location")!}`, { headers: { cookie } })).text();
      expect(html).toContain('role="status"');
      expect(html).toContain("Comprado: Informe de mercado XLM/USDC");
      expect(html).not.toContain('role="alert"');
    });

    it("says the request was sent when AgentPey does not list the purchase yet", async () => {
      const cookie = await readyAgent("aun-no@ejemplo.cl");
      agentpey.showActivity({ purchases: [] });
      const html = await (await fetch(`${baseUrl}/servicios?compra=pur_NOTYET`, { headers: { cookie } })).text();
      expect(html).toContain("Tu pedido se envió");
    });

    it("ignores a notice parameter that is not an id", async () => {
      const cookie = await readyAgent("parametro@ejemplo.cl");
      const html = await (await fetch(`${baseUrl}/servicios?compra=%3Cscript%3E`, { headers: { cookie } })).text();
      expect(html).not.toContain("Tu pedido se envió");
      expect(html).not.toContain('class="card notice"');
    });

    it("lists the newest first and folds everything past six", async () => {
      const cookie = await readyAgent("muchas@ejemplo.cl");
      const many = Array.from({ length: 8 }, (_, index) =>
        settled({ id: `pur_MANY${String(index)}`, product_id: `p-${String(index)}`, created_at: `2026-09-2${String(index)}T10:00:00.000Z` }),
      );
      agentpey.showActivity({ purchases: many });
      const html = await (await fetch(`${baseUrl}/servicios`, { headers: { cookie } })).text();
      expect(html.indexOf("<h3>p-7</h3>")).toBeLessThan(html.indexOf("<h3>p-0</h3>"));
      expect(html).toContain("Ver 2 más");
      expect(html.indexOf("Ver 2 más")).toBeLessThan(html.indexOf("<h3>p-1</h3>"));
    });

    it("shows the account by its email, with the random code only under details", async () => {
      const cookie = await readyAgent("mi-correo@ejemplo.cl");
      const html = await (await fetch(`${baseUrl}/servicios`, { headers: { cookie } })).text();
      expect(html).toContain("Entraste como <strong>mi-correo@ejemplo.cl</strong>");
      expect(html).not.toContain("te identificamos como");
      expect(html).toContain("Qué sabe AgentPey de ti");
    });
  });

  it("shows what is left of today's limit, and warns when it is nearly gone", async () => {
    const cookie = await readyAgent("limite@ejemplo.cl");
    agentpey.showActivity({
      purchases: [],
      per_day: { limit: "0.60", spent_today: "0.50", remaining: "0.10", currency: "USDC", near_limit: true },
      rail: { contract_id: "C".repeat(56), balance: "0.5000000", asset: "USDC", sponsored: true },
    });

    const html = await (await fetch(`${baseUrl}/servicios`, { headers: { cookie } })).text();

    expect(html).toContain("0.50");
    expect(html).toContain("Estás cerca del tope");
    // The sponsored credit has to be named as what it is.
    expect(html).toContain("crédito de prueba");
  });

  it("says so when it could not read the activity, instead of showing an empty page", async () => {
    const cookie = await readyAgent("roto@ejemplo.cl");
    const broken = createRealOpsServer({
      store,
      agentpey: {
        ...agentpey.client,
        readActivity: async () => {
          throw new Error("boom");
        },
      },
      targets: TARGETS,
      signalDeskUrl: "https://signaldesk.example",
      agentpeyBaseUrl: "https://agentpey.example",
      baseUrl: "http://127.0.0.1",
      delivery: { mode: "email", send: async () => undefined },
      secureCookies: false,
    });
    await new Promise<void>((resolve) => broken.listen(0, "127.0.0.1", resolve));
    const brokenUrl = `http://127.0.0.1:${(broken.address() as AddressInfo).port}`;

    try {
      const html = await (await fetch(`${brokenUrl}/servicios`, { headers: { cookie } })).text();
      expect(html).toContain("No pudimos hablar con AgentPey");
    } finally {
      await new Promise<void>((resolve, reject) => broken.close((error) => (error === undefined ? resolve() : reject(error))));
    }
  });
});
