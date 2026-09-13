import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";

import type { AgentPeyClient, PurchaseResource, TenantActivity } from "./agentpey.js";
import { createMemoryStore, type RealOpsStore } from "./accounts.js";
import { createRealOpsServer } from "./app.js";
import type { PilotTargets } from "./permissions.js";

const VENUE = "signaldesk:GB4D4PLLFEIKZK6MDW42MZRQ5XMPC6QRJN4FFRODO6D3PRB3MDGGYOOF";

const TARGETS: PilotTargets = {
  venueId: VENUE,
  assetId: "USDC:CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  payTo: "GB4D4PLLFEIKZK6MDW42MZRQ5XMPC6QRJN4FFRODO6D3PRB3MDGGYOOF",
  products: {
    market_brief: ["signaldesk:market-brief-xlm-usdc"],
    ai_credits: ["signaldesk:ai-credits-1000"],
  },
};

interface PurchaseCall {
  readonly tenantId: string;
  readonly venue: string;
  readonly productId: string;
  readonly quantity: number;
  readonly routeParams?: Readonly<Record<string, string | number>>;
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
      return {
        id: "cns_01J7QW8VQEJPAXEPAYBUY0001",
        status: "pending",
        consent_url: "https://agentpey.example/consent/cns_01J7QW8VQEJPAXEPAYBUY0001",
        return_url: null,
        mandate_id: null,
        expires_at: "2026-09-13T00:00:00.000Z",
      };
    },
    async readConsentSession() {
      return {
        id: "cns_01J7QW8VQEJPAXEPAYBUY0001",
        status: "completed",
        consent_url: null,
        return_url: null,
        mandate_id: "mnd_01J7QW8VQEJPAXEPAYBUY0009",
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

/** Signs in, configures an agent of `kind`, and takes it all the way to signed. */
async function readyAgent(email: string, kind: "market_brief" | "ai_credits" = "market_brief"): Promise<string> {
  const before = sent.length;
  await fetch(`${baseUrl}/entrar`, form({ email, alias: "Tester" }));
  const link = sent[before]!.link.replace("http://127.0.0.1/", `${baseUrl}/`);
  const cookie = (await fetch(link, { redirect: "manual" })).headers.get("set-cookie")!.split(";")[0]!;

  const created = await fetch(
    `${baseUrl}/agentes`,
    form({ kind, label: "Mi agente", perTx: "0.30", perDay: "0.60", validForDays: "30" }, cookie),
  );
  const agentId = created.headers.get("location")!.slice("/agentes/".length);
  await fetch(`${baseUrl}/agentes/${agentId}/firmar`, form({}, cookie));
  await fetch(`${baseUrl}/agentes/${agentId}/volver`, { headers: { cookie }, redirect: "manual" });
  return cookie;
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
