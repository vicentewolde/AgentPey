/**
 * The catalogue, end to end over HTTP.
 *
 * What these tests are really pinning down is the boundary: a page that shows a
 * whole shop must not become a way to buy outside what was signed, and a form
 * that carries merchant parameters must not become a way to change the venue,
 * the product, the payee or the amount. Every assertion below is one of those
 * two sentences.
 */
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";

import type { AgentPeyClient, PurchaseResource } from "./agentpey.js";
import { createMemoryStore, type RealOpsStore } from "./accounts.js";
import { createRealOpsServer } from "./app.js";
import type { BazaarCatalog, CheckedResource } from "./bazaar-catalog.js";
import { BAZAAR_VENUE_ID, SIGNALDESK_VENUE_ID, TEST_TARGETS, VITRINEE_PAY_TO, VITRINEE_VENUE_ID } from "./testing.js";

const ROWS: readonly CheckedResource[] = [
  {
    id: "swap-risk-quote",
    name: "Swap Risk Quote (Sandbox)",
    description: "Deterministic read-only swap risk quote.",
    declaredAmount: "0.001",
    declaredAsset: "USDC",
    declaredPayTo: "GDVR2KDK5DSMNYZJKNISUIOBDC6FZK3XZOIQWSS7KL4BRMD5BMW6RMCQ",
    routeTemplate: "/api/x402/swap-risk?pair={pair}&amount={amount}&side={side}",
    inputs: [
      { name: "pair", type: "string", required: true },
      { name: "amount", type: "number", required: true },
      { name: "side", type: "string", required: true },
    ],
    availability: "sellable",
  },
  {
    id: "ai-video-scriptwriter",
    name: "AI Video Scriptwriter",
    description: "Writes a script for a video.",
    declaredAmount: "0.02",
    declaredAsset: "USDC",
    declaredPayTo: "GBYXQUSY7WA3DUXZSANGQ3HMER2EBMOK5IYPUJV4YY2UH7QS736J62LB",
    routeTemplate: "/api/script?topic={topic}",
    inputs: [{ name: "topic", type: "string", required: true }],
    availability: "unavailable",
  },
];

interface PurchaseCall {
  readonly venue: string;
  readonly productId: string;
  readonly quantity: number;
  readonly routeParams?: Readonly<Record<string, string | number>>;
}

/** The real store's cheapest product, as its ServiceCard feed answered on 2026-09-23 (T100). */
const STORE_ROWS: readonly CheckedResource[] = [
  {
    id: "37283001",
    name: "Pack de stickers Cordillera",
    description: "Seis stickers de vinilo.",
    declaredAmount: "1.0421053",
    declaredAsset: "USDC",
    declaredPayTo: VITRINEE_PAY_TO,
    routeTemplate: "/checkout/37283001?quantity={quantity}&name={name}&address={address}&city={city}&region={region}",
    inputs: [
      { name: "quantity", type: "number", required: true },
      { name: "name", type: "string", required: true },
      { name: "address", type: "string", required: true },
      { name: "city", type: "string", required: true },
      { name: "region", type: "string", required: true },
    ],
    availability: "sellable",
  },
];
let storeFails = false;
const vitrineeCatalog: BazaarCatalog = {
  async list() {
    if (storeFails) throw new Error("the store is down");
    return STORE_ROWS;
  },
};

const purchases: PurchaseCall[] = [];
let consentSeq = 0;
let bazaarFails = false;

const bazaarCatalog: BazaarCatalog = {
  async list() {
    if (bazaarFails) throw new Error("the bazaar is down");
    return ROWS;
  },
};

function settled(): PurchaseResource {
  return {
    id: "pur_01J7QW8VQEJPAXEPAYBUY0001",
    outcome: "settled",
    code: null,
    reason: null,
    product_id: "swap-risk-quote",
    total: "0.0010000",
    asset: "USDC:CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    transaction_hash: "b".repeat(64),
    explorer_url: `https://stellar.expert/explorer/testnet/tx/${"b".repeat(64)}`,
    delivery: null,
    created_at: "2026-09-22T12:00:00.000Z",
  };
}

const agentpey: AgentPeyClient = {
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
      expires_at: "2026-09-23T00:00:00.000Z",
    };
  },
  async readConsentSession(id) {
    return {
      id,
      status: "completed",
      consent_url: null,
      return_url: null,
      mandate_id: `mdt_${id.slice("cns_".length)}`,
      expires_at: "2026-09-23T00:00:00.000Z",
    };
  },
  async listMandates() {
    return [];
  },
  async purchase(input) {
    purchases.push(input);
    return settled();
  },
  async readActivity() {
    return { tenant_id: "ptn_x:tenant1", mandate: null, per_day: null, rail: null, purchases: [], refusals: [] };
  },
};

const store: RealOpsStore = createMemoryStore();
const sent: { email: string; link: string }[] = [];

const server = createRealOpsServer({
  store,
  agentpey,
  targets: TEST_TARGETS,
  bazaarCatalog,
  vitrineeCatalog,
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

/** Takes an agent of `kind` all the way to signed, through the same routes a person would. */
async function signAgent(cookie: string, kind: string): Promise<string> {
  const created = await fetch(
    `${baseUrl}/agentes`,
    form({ kind, label: "Mi agente", perTx: "0.30", perDay: "0.60", validForDays: "30" }, cookie),
  );
  const agentId = created.headers.get("location")!.slice("/agentes/".length);
  await fetch(`${baseUrl}/agentes/${agentId}/firmar`, form({}, cookie));
  await fetch(`${baseUrl}/agentes/${agentId}/volver`, { headers: { cookie }, redirect: "manual" });
  return agentId;
}

async function catalogue(cookie: string): Promise<string> {
  return (await fetch(`${baseUrl}/catalogo`, { headers: { cookie } })).text();
}

describe("the catalogue screen", () => {
  it("shows the whole shop, both merchants, to an account with nothing signed", async () => {
    const cookie = await signIn("mira@ejemplo.cl");
    const html = await catalogue(cookie);

    expect(html).toContain("signaldesk:market-brief-xlm-usdc");
    expect(html).toContain("swap-risk-quote");
    expect(html).toContain("ai-video-scriptwriter");
    // The third merchant (T100): the real store's own product id.
    expect(html).toContain("37283001");
    // Everything is outside the grant, and says so in both languages.
    expect(html).toContain("outside the grant");
    expect(html).toContain("fuera del permiso");
  });

  /**
   * The demonstration the wall was hiding: a signed SignalDesk agent leaves the
   * bazaar outside the grant, and the card links to the exact permission that
   * would change that.
   */
  it("marks the bazaar outside the grant for an account that signed only SignalDesk", async () => {
    const cookie = await signIn("solo-sd@ejemplo.cl");
    await signAgent(cookie, "market_brief");
    const html = await catalogue(cookie);

    expect(html).toContain("in the grant");
    expect(html).toContain("/catalogo/permiso?producto=swap-risk-quote");
  });

  it("says the merchant is not selling something it lists", async () => {
    const cookie = await signIn("no-vende@ejemplo.cl");
    const html = await catalogue(cookie);
    expect(html).toContain("is not charging for it right now");
  });

  /** A merchant that is down is a message beside a working half, not a broken page. */
  it("still draws SignalDesk when the bazaar could not be read", async () => {
    const cookie = await signIn("caido@ejemplo.cl");
    bazaarFails = true;
    try {
      const html = await catalogue(cookie);
      expect(html).toContain("signaldesk:market-brief-xlm-usdc");
      expect(html).not.toContain("swap-risk-quote");
    } finally {
      bazaarFails = false;
    }
  });
});

describe("the permission an out-of-grant item needs", () => {
  it("shows the literal grant, with the bazaar's venue, products and both payout accounts", async () => {
    const cookie = await signIn("permiso@ejemplo.cl");
    const html = await (await fetch(`${baseUrl}/catalogo/permiso?producto=swap-risk-quote`, { headers: { cookie } })).text();

    expect(html).toContain(BAZAAR_VENUE_ID);
    expect(html).toContain("swap-risk-quote");
    expect(html).toContain("ai-video-scriptwriter");
    expect(html).toContain("GDVR2KDK5DSMNYZJKNISUIOBDC6FZK3XZOIQWSS7KL4BRMD5BMW6RMCQ");
    expect(html).toContain("GBYXQUSY7WA3DUXZSANGQ3HMER2EBMOK5IYPUJV4YY2UH7QS736J62LB");
    // And it names nothing of the other merchant.
    expect(html).not.toContain(SIGNALDESK_VENUE_ID);
    // The honesty marks travel with it.
    expect(html).toContain("on-chain");
  });

  it("is a 404 for a product the catalogue does not have", async () => {
    const cookie = await signIn("inventado@ejemplo.cl");
    const response = await fetch(`${baseUrl}/catalogo/permiso?producto=no-existe`, { headers: { cookie } });
    expect(response.status).toBe(404);
  });

  it("sets up a separate agent, and signs nothing", async () => {
    const cookie = await signIn("nuevo@ejemplo.cl");
    const created = await fetch(`${baseUrl}/catalogo/permiso`, form({ product_id: "swap-risk-quote" }, cookie));

    expect(created.status).toBe(302);
    const agentId = created.headers.get("location")!.slice("/agentes/".length);
    const account = await store.findAccountByEmail("nuevo@ejemplo.cl");
    const agent = await store.findAgent(account!.id, agentId);
    expect(agent!.kind).toBe("bazaar_shopper");
    // Created, not authorised: nothing is signed until the person signs it.
    expect(agent!.mandateId).toBeNull();
  });

  /** A second post of the same form must not mint a second agent with the same power. */
  it("sends an account that already has that agent to the one it has", async () => {
    const cookie = await signIn("otra-vez@ejemplo.cl");
    const agentId = await signAgent(cookie, "bazaar_shopper");
    const again = await fetch(`${baseUrl}/catalogo/permiso`, form({ product_id: "swap-risk-quote" }, cookie));
    expect(again.headers.get("location")).toBe(`/agentes/${agentId}`);
  });
});

describe("buying from the catalogue", () => {
  it("sends the bazaar's venue, its product id, and the person's parameters", async () => {
    const cookie = await signIn("compra-bazaar@ejemplo.cl");
    await signAgent(cookie, "bazaar_shopper");
    const before = purchases.length;

    await fetch(
      `${baseUrl}/instruccion`,
      form(
        {
          product_id: "swap-risk-quote",
          param_pair: "XLM/USDC",
          param_amount: "100",
          param_side: "buy",
        },
        cookie,
      ),
    );

    const call = purchases[before]!;
    expect(call.venue).toBe(BAZAAR_VENUE_ID);
    expect(call.productId).toBe("swap-risk-quote");
    expect(call.routeParams).toEqual({ pair: "XLM/USDC", amount: "100", side: "buy" });
  });

  /**
   * The parameter named `amount` is not the amount paid, and this is the test
   * that says so out loud. It travels to the merchant's route and nowhere near
   * a decision: AgentPey fetches the merchant's own 402 and `reconcileTerms`
   * compares that against the signed Mandate. Verified against the live bazaar
   * on 2026-09-22, where the same resource quotes 0.001 USDC whether its
   * `amount` says 100 or 999999.
   */
  it("does not let a route parameter move any money", async () => {
    const cookie = await signIn("monto@ejemplo.cl");
    await signAgent(cookie, "bazaar_shopper");
    const before = purchases.length;

    await fetch(
      `${baseUrl}/instruccion`,
      form(
        { product_id: "swap-risk-quote", param_pair: "XLM/USDC", param_amount: "999999", param_side: "sell" },
        cookie,
      ),
    );

    const call = purchases[before]!;
    // The claim reaches the merchant's route and nothing else: no price, no
    // asset, no payee, no limit is named by this request at all.
    expect(call.routeParams).toMatchObject({ amount: "999999" });
    expect(Object.keys(call)).not.toContain("total");
    expect(Object.keys(call)).not.toContain("payTo");
    expect(Object.keys(call)).not.toContain("asset");
  });

  /**
   * A form is not a tunnel to the merchant's URL. A parameter the merchant
   * never declared is dropped rather than forwarded.
   */
  it("drops a parameter the merchant did not ask for", async () => {
    const cookie = await signIn("extra@ejemplo.cl");
    await signAgent(cookie, "bazaar_shopper");
    const before = purchases.length;

    await fetch(
      `${baseUrl}/instruccion`,
      form(
        {
          product_id: "swap-risk-quote",
          param_pair: "XLM/USDC",
          param_amount: "1",
          param_side: "buy",
          param_callback: "https://malvado.example/x",
        },
        cookie,
      ),
    );

    expect(JSON.stringify(purchases[before]!)).not.toContain("malvado.example");
  });

  /**
   * The credits route credits an address, and that address is the tenant's
   * opaque reference. A form posting its own would be a way to credit somebody
   * else, so RealOps' own value is written last and wins.
   */
  it("does not let a form override a parameter RealOps owns", async () => {
    const cookie = await signIn("cuenta-ajena@ejemplo.cl");
    await signAgent(cookie, "ai_credits");
    const before = purchases.length;

    await fetch(
      `${baseUrl}/instruccion`,
      form({ product_id: "signaldesk:ai-credits-1000", param_account: "rop_de-otra-persona" }, cookie),
    );

    expect(purchases[before]!.routeParams).not.toMatchObject({ account: "rop_de-otra-persona" });
  });

  it("refuses to buy, and buys nothing, when a required parameter is missing", async () => {
    const cookie = await signIn("incompleto@ejemplo.cl");
    await signAgent(cookie, "bazaar_shopper");
    const before = purchases.length;

    const response = await fetch(
      `${baseUrl}/instruccion`,
      form({ product_id: "swap-risk-quote", param_pair: "XLM/USDC" }, cookie),
    );

    expect(response.status).toBe(400);
    expect(purchases).toHaveLength(before);
  });

  /**
   * The wall, still standing. The catalogue makes it visible; it does not make
   * it passable. An account with no signed bazaar agent cannot buy there by
   * posting the product id, and RealOps never even asks AgentPey.
   */
  it("does not ask for a purchase an account has no signed permission for", async () => {
    const cookie = await signIn("sin-permiso@ejemplo.cl");
    await signAgent(cookie, "market_brief");
    const before = purchases.length;

    const response = await fetch(
      `${baseUrl}/instruccion`,
      form({ product_id: "swap-risk-quote", param_pair: "XLM/USDC", param_amount: "1", param_side: "buy" }, cookie),
    );

    expect(response.status).toBe(409);
    expect(purchases).toHaveLength(before);
  });

  it("is a 404 for a product id that is in no target", async () => {
    const cookie = await signIn("id-falso@ejemplo.cl");
    await signAgent(cookie, "bazaar_shopper");
    const before = purchases.length;

    const response = await fetch(`${baseUrl}/instruccion`, form({ product_id: "otra-cosa" }, cookie));

    expect(response.status).toBe(404);
    expect(purchases).toHaveLength(before);
  });
});

describe("buying from the Vitrinee store (T100)", () => {
  const SHIPPING = { param_name: "Ana Pérez", param_address: "Av. Irarrázaval 1234", param_city: "Ñuñoa", param_region: "Metropolitana" };

  it("sends the store's venue, its product id, the shipping details, and the quantity once, as the purchase's", async () => {
    const cookie = await signIn("compra-tienda@ejemplo.cl");
    await signAgent(cookie, "vitrinee_shopper");
    const before = purchases.length;

    await fetch(`${baseUrl}/instruccion`, form({ product_id: "37283001", param_quantity: "2", ...SHIPPING }, cookie));

    const call = purchases[before]!;
    expect(call.venue).toBe(VITRINEE_VENUE_ID);
    expect(call.productId).toBe("37283001");
    // C-132: the quantity is the purchase's own, the one that gets signed. It
    // is never also a route parameter, so it cannot travel twice and disagree.
    expect(call.quantity).toBe(2);
    expect(call.routeParams).toEqual({ name: "Ana Pérez", address: "Av. Irarrázaval 1234", city: "Ñuñoa", region: "Metropolitana" });
  });

  it("buys one unit when the quantity field is left empty", async () => {
    const cookie = await signIn("una-unidad@ejemplo.cl");
    await signAgent(cookie, "vitrinee_shopper");
    const before = purchases.length;
    await fetch(`${baseUrl}/instruccion`, form({ product_id: "37283001", param_quantity: "", ...SHIPPING }, cookie));
    expect(purchases[before]!.quantity).toBe(1);
  });

  it("refuses a quantity that is not a small whole number, and buys nothing", async () => {
    const cookie = await signIn("cantidad-rara@ejemplo.cl");
    await signAgent(cookie, "vitrinee_shopper");
    const before = purchases.length;
    for (const bad of ["0", "1.5", "999", "-1", "dos"]) {
      const response = await fetch(`${baseUrl}/instruccion`, form({ product_id: "37283001", param_quantity: bad, ...SHIPPING }, cookie));
      expect(response.status, bad).toBe(400);
    }
    expect(purchases).toHaveLength(before);
  });

  it("refuses an order with the shipping details missing, and buys nothing", async () => {
    const cookie = await signIn("sin-direccion@ejemplo.cl");
    await signAgent(cookie, "vitrinee_shopper");
    const before = purchases.length;
    const response = await fetch(`${baseUrl}/instruccion`, form({ product_id: "37283001", param_quantity: "1", param_name: "Ana" }, cookie));
    expect(response.status).toBe(400);
    expect(purchases).toHaveLength(before);
  });

  /**
   * A typed sentence names the product and the quantity but not the address,
   * so it opens the card with the quantity filled in, and buys nothing yet.
   */
  it("takes a typed sentence to the store's card, with the quantity it named, and buys nothing", async () => {
    const cookie = await signIn("frase-tienda@ejemplo.cl");
    await signAgent(cookie, "vitrinee_shopper");
    const before = purchases.length;

    const typed = await fetch(`${baseUrl}/instruccion`, form({ instruction: "compra dos packs de stickers" }, cookie));
    expect(typed.status).toBe(302);
    const location = typed.headers.get("location")!;
    expect(location).toBe("/catalogo?producto=37283001&cantidad=2#37283001");
    expect(purchases).toHaveLength(before);

    const html = await (await fetch(`${baseUrl}${location.split("#")[0]}`, { headers: { cookie } })).text();
    expect(html).toContain('id="37283001"');
    expect(html).toMatch(/name="param_quantity" type="number" min="1" max="20" step="1" value="2"/);
  });

  it("ignores a prefill it cannot trust, and still draws the catalogue", async () => {
    const cookie = await signIn("prefill-raro@ejemplo.cl");
    await signAgent(cookie, "vitrinee_shopper");
    const html = await (await fetch(`${baseUrl}/catalogo?producto=37283001&cantidad=999`, { headers: { cookie } })).text();
    expect(html).toContain('id="37283001"');
    expect(html).not.toContain('value="999"');
  });

  /** A signed bazaar agent is another venue's permission: the store stays outside it. */
  it("does not let a bazaar agent buy at the store", async () => {
    const cookie = await signIn("bazaar-en-tienda@ejemplo.cl");
    await signAgent(cookie, "bazaar_shopper");
    const before = purchases.length;
    const response = await fetch(`${baseUrl}/instruccion`, form({ product_id: "37283001", param_quantity: "1", ...SHIPPING }, cookie));
    expect(response.status).toBe(409);
    expect(purchases).toHaveLength(before);
  });

  it("proposes the store's own defaults, 3.00 per purchase and per day, for the permission it needs", async () => {
    const cookie = await signIn("permiso-tienda@ejemplo.cl");
    const html = await (await fetch(`${baseUrl}/catalogo/permiso?producto=37283001`, { headers: { cookie } })).text();
    expect(html).toContain(VITRINEE_VENUE_ID);
    expect(html).toContain("3.00 USDC");
    expect(html).not.toContain("0.30 USDC");
  });

  it("says so, and keeps the other two merchants, when the store cannot be read", async () => {
    const cookie = await signIn("tienda-caida@ejemplo.cl");
    storeFails = true;
    try {
      const html = await catalogue(cookie);
      expect(html).toContain("swap-risk-quote");
      expect(html).toContain("signaldesk:market-brief-xlm-usdc");
      expect(html).not.toContain("37283001");
      // The section is drawn with a reason, in both languages, not left blank.
      expect(html).toContain("Bazar Cordillera");
    } finally {
      storeFails = false;
    }
  });
});
