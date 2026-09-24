/**
 * RealOps' HTTP surface.
 *
 * **RealOps asks; AgentPey decides.** Nothing in this file authorises a
 * payment, and nothing in it can: it holds no Stellar key, it never sees a
 * mandate, and the only thing it will ever be able to do (from T81) is call
 * `/v1` with an API key and be told yes or no. A compromised RealOps can
 * produce refusals and nothing else. That is the property the whole pilot
 * rests on, and it is worth restating in the file where a shortcut would be
 * most tempting.
 *
 * **The browser never sends a tenant id.** The session cookie resolves to an
 * account, the account resolves to its own agents, and an id in a query string
 * is never trusted to name whose data to show. `PILOTO-F9.md` § 3.4 requires
 * that; here it is structural, because no handler reads a tenant from input.
 *
 * **Magic links are redeemed by a write, not by a read.** `redeemMagicLink` is
 * the conditional update that marks the token used and reports whether *this*
 * caller was the one that marked it. Reading "is it used?" and then writing
 * "now it is" leaves a window where two requests both pass — the same class of
 * bug `C-82` closed on the funding path.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { AgentPassError, isAgentPassError } from "@agentpass/core";
import { z } from "zod";

import {
  agentKindSchema,
  type AgentConfig,
  agentPermissionsSchema,
  type AgentKind,
  aliasSchema,
  checkMagicLink,
  emailSchema,
  hashToken,
  issueMagicLink,
  newAgent,
  newSession,
  sessionIsLive,
  type Account,
  type RealOpsStore,
} from "./accounts.js";
import type { AgentPeyClient } from "./agentpey.js";
import { bilingual, type Bilingual } from "./copy.js";
import { INSTRUCTION_PROBLEMS, SUPPORTED_PAIR, interpretInstruction, type InstructionProblem } from "./instruction.js";
import {
  agentsPage,
  catalogPage,
  chooseAgentPage,
  errorPage,
  grantDiffPage,
  homePage,
  linkSentPage,
  notRecognisedPage,
  reviewPage,
  servicesPage,
  signInPage,
} from "./pages.js";
import { defaultPermissionsFor, translatePermissions, type PilotTargets } from "./permissions.js";
import { buildCatalog, findCard, QUANTITY_INPUT, storeTarget, type CatalogCard, type StoreRows } from "./catalog.js";
import type { Storefront, StorefrontDirectory } from "./storefronts.js";
import type { BazaarCatalog, CheckedResource } from "./bazaar-catalog.js";

export const SESSION_COOKIE = "realops_session";

/**
 * The per-form purchase key a page embeds (`pages.ts`). Validated because it
 * comes from the browser and ends up inside an `Idempotency-Key` header; a
 * form that lacks one (a page cached from before T84) falls back to a fresh
 * key, which is the old behaviour rather than a refusal.
 */
const requestKeySchema = z.uuid();

/** How the magic link reaches the person. */
export interface MagicLinkDelivery {
  /**
   * `"email"` sends a one-time link; `"onscreen"` signs the person straight in.
   *
   * `"onscreen"` is the pilot's mode before an email provider exists. It used
   * to show the link to the browser that asked; since T88 (C-119, decided by
   * the user) it skips that page. Neither version verifies that the address
   * belongs to whoever typed it, and the sign-in page says so. Configuring an
   * email provider brings the link back.
   */
  readonly mode: "email" | "onscreen";
  readonly send?: (email: string, link: string) => Promise<void>;
}

export interface RealOpsConfig {
  readonly store: RealOpsStore;
  /**
   * AgentPey's `/v1`, or `undefined` to run the UI with no platform behind it.
   *
   * Optional on purpose: the screens, the sign-in flow and the review page are
   * worth being able to open without a database, an API key or a network — and
   * a missing client produces a clear message, not a crash.
   */
  readonly agentpey?: AgentPeyClient;
  /**
   * Where AgentPey is, for the links RealOps sends a person to — signing and
   * revoking both happen there, never here.
   */
  readonly agentpeyBaseUrl: string;
  readonly targets: PilotTargets;
  /**
   * The bazaar's live catalogue, or `undefined` to run without it.
   *
   * Optional for the same reason `agentpey` is: the catalogue screen has to
   * open when a third-party merchant is down, showing SignalDesk and saying
   * plainly that the other half could not be read. A missing merchant is a
   * message, not a crash.
   */
  readonly bazaarCatalog?: BazaarCatalog;
  /**
   * The Vitrinee platform's directory of stores (T104, `C-141`), or
   * `undefined` to run without it. Same posture as the bazaar's: a directory
   * that cannot be read is a message on the catalogue, not a broken page.
   */
  readonly storefronts?: StorefrontDirectory;
  readonly signalDeskUrl: string;
  /** This service's own origin, for building magic links. */
  readonly baseUrl: string;
  readonly delivery: MagicLinkDelivery;
  /** `Secure` on the cookie. Off only for a local http run. */
  readonly secureCookies?: boolean;
  readonly now?: () => Date;
}

function sendHtml(response: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
  response.end(body);
}

function redirect(response: ServerResponse, location: string, headers: Record<string, string> = {}): void {
  response.writeHead(302, { location, ...headers });
  response.end();
}

function readCookie(request: IncomingMessage, name: string): string | undefined {
  const header = request.headers.cookie;
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function cookieFor(value: string, maxAgeSeconds: number, secure: boolean): string {
  const flags = ["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];
  if (secure) flags.push("Secure");
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; ${flags.join("; ")}`;
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    // A sign-in form is a few hundred bytes. Anything larger is not a form.
    if (size > 16_384) throw new AgentPassError("InvalidArguments", "the form is too large");
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

/** A message a person can read, from whatever went wrong talking to AgentPey. */
function messageFor(error: unknown): Bilingual {
  if (isAgentPassError(error)) {
    const code = typeof error.details.code === "string" ? error.details.code : error.code;
    return bilingual(
      `AgentPey did not accept the request (${code}): ${error.message}`,
      `AgentPey no aceptó la petición (${code}): ${error.message}`,
    );
  }
  return bilingual(
    "We could not reach AgentPey. Try again in a moment.",
    "No pudimos hablar con AgentPey. Inténtalo de nuevo en un momento.",
  );
}

const NOT_CONNECTED = bilingual(
  "This instance is not connected to AgentPey yet.",
  "Esta instancia todavía no está conectada a AgentPey.",
);
const NO_SUCH_AGENT = bilingual("That agent does not exist.", "Ese agente no existe.");
const NO_SUCH_PRODUCT = bilingual(
  "That product is not in the catalogue. It may have been withdrawn by the merchant.",
  "Ese producto no está en el catálogo. Puede que el comercio lo haya retirado.",
);
const BAZAAR_UNAVAILABLE = bilingual(
  "This instance is not reading the bazaar's catalogue.",
  "Esta instancia no está leyendo el catálogo del bazaar.",
);
const VITRINEE_UNAVAILABLE = bilingual(
  "This instance is not reading the Vitrinee stores.",
  "Esta instancia no está leyendo las tiendas de Vitrinee.",
);
const STORE_UNAVAILABLE = bilingual(
  "This agent's store cannot be reached right now, so its permission cannot be shown or signed. Try again in a moment.",
  "No se puede contactar la tienda de este agente en este momento, así que su permiso no se puede mostrar ni firmar. Vuelve a intentarlo en un momento.",
);
const HIRE_STORE_FROM_CATALOGUE = bilingual(
  "A store shopper buys at one store: hire it from a product card of that store in the catalogue.",
  "Un comprador de tienda compra en una sola tienda: contrátalo desde la tarjeta de un producto de esa tienda en el catálogo.",
);
const BAD_QUANTITY = bilingual(
  "The quantity has to be a whole number between 1 and 20. Nothing was bought.",
  "La cantidad tiene que ser un número entero entre 1 y 20. No se compró nada.",
);
const MISSING_PARAMS = bilingual(
  "The merchant needs every field filled in to serve that. Nothing was bought.",
  "El comercio necesita todos los campos completos para entregar eso. No se compró nada.",
);

/**
 * The name a new agent gets when it is set up from the catalogue.
 *
 * English, because a stored label is a stored string and the pages render both
 * languages from `copy.ts` rather than from data. The person can see it on the
 * review screen before signing anything.
 */
const AGENT_KIND_NAMES: Readonly<Record<AgentKind, Bilingual>> = {
  market_brief: bilingual("Market report agent", "Agente de informes de mercado"),
  ai_credits: bilingual("AI credits agent", "Agente de créditos de IA"),
  bazaar_shopper: bilingual("Bazaar Shopper", "Comprador del Bazaar"),
  vitrinee_shopper: bilingual("Store Shopper", "Comprador de la tienda"),
};
const CANNOT_BUY_THAT = bilingual(
  "That agent cannot buy this. Choose again from My services.",
  "Ese agente no puede comprar esto. Vuelve a elegir desde Mis servicios.",
);
const ALREADY_ASKED = bilingual(
  "You already asked for this with another agent. Check My services before asking for it again.",
  "Ya pediste esto con otro agente. Revisa Mis servicios antes de volver a pedirlo.",
);
const LINK_ALREADY_USED = bilingual(
  "That link was already used. Links work only once.",
  "Ese enlace ya se usó. Los enlaces sirven una sola vez.",
);

function problemOf(details: Readonly<Record<string, unknown>>): InstructionProblem {
  const problem = details.problem;
  return INSTRUCTION_PROBLEMS.find((known) => known === problem) ?? "no_product";
}

/**
 * The values the merchant's paid route declares as required.
 *
 * These fill a URL the merchant itself published; they are not a way in for
 * anything that decides. The price that comes back is still reconciled against
 * the signed Mandate like any other.
 */
/**
 * The parameters RealOps supplies itself for a product, never the browser.
 *
 * The credits route credits an address: it is the *tenant's* opaque reference
 * and never the person's email — SignalDesk has no business learning who
 * anyone is — and never a value a form could carry, or a person could credit
 * somebody else. The report's pair is the one pair the pilot knows.
 *
 * The bazaar's products get nothing here: every parameter they take belongs to
 * the person, and comes from the form (T96).
 */
function serverParamsFor(
  productId: string,
  pair: string | undefined,
  account: string,
): Readonly<Record<string, string | number>> {
  if (productId === "signaldesk:market-brief-xlm-usdc") return { pair: pair ?? SUPPORTED_PAIR };
  if (productId === "signaldesk:ai-credits-1000") return { account };
  return {};
}

/** Every parameter a form may carry, capped so a form cannot be used as a sink. */
const MAX_PARAM_LENGTH = 200;
/** The most units one purchase may ask for from a form. The same cap `interpretInstruction` reads from a sentence. */
const MAX_FORM_QUANTITY = 20;

/**
 * The route parameters a person filled in, read against what the merchant said
 * it wants.
 *
 * A name the merchant did not declare is dropped rather than forwarded: the
 * form is not a tunnel to the merchant's URL. A missing required one is
 * reported, not defaulted, because a default here would be the same guess
 * `interpretInstruction` refuses to make.
 *
 * None of this is a security boundary and it must not be mistaken for one. A
 * parameter chooses *what is delivered*, never what is paid: the amount comes
 * from the merchant's own 402 and is re-checked against the signed Mandate by
 * `reconcileTerms`, which was verified against the live bazaar — the same
 * resource quotes 0.001 USDC whether its `amount` parameter says 100 or
 * 999999. The worst a wrong parameter can do is buy the wrong thing, within
 * limits somebody signed.
 */
function readRouteParams(
  card: CatalogCard,
  form: URLSearchParams,
): {
  readonly params: Record<string, string>;
  readonly missing: readonly string[];
  /** The purchase's quantity when the merchant declares one (`C-132`); `undefined` when it does not. */
  readonly quantity: number | undefined;
  readonly badQuantity: boolean;
} {
  const params: Record<string, string> = {};
  const missing: string[] = [];
  let quantity: number | undefined;
  let badQuantity = false;
  for (const input of card.inputs) {
    if (card.serverFilled.includes(input.name)) continue;
    const value = form.get(`param_${input.name}`)?.trim() ?? "";
    // The quantity is the purchase's, never a route parameter: AgentPey fills
    // the merchant's `quantity` from the signed intent and refuses one that
    // disagrees (`C-132`). Read here, sent once, in the place that gets signed.
    if (input.name === QUANTITY_INPUT) {
      if (value === "") {
        quantity = 1;
      } else if (/^\d{1,2}$/.test(value) && Number(value) >= 1 && Number(value) <= MAX_FORM_QUANTITY) {
        quantity = Number(value);
      } else {
        badQuantity = true;
      }
      continue;
    }
    if (value === "") {
      if (input.required) missing.push(input.name);
      continue;
    }
    params[input.name] = value.slice(0, MAX_PARAM_LENGTH);
  }
  return { params, missing, quantity, badQuantity };
}

export function createRealOpsServer(config: RealOpsConfig): Server {
  const now = config.now ?? (() => new Date());
  const secure = config.secureCookies ?? true;

  /** The signed-in account, or `undefined`. The only way a handler learns who is asking. */
  async function currentAccount(request: IncomingMessage): Promise<Account | undefined> {
    const sessionId = readCookie(request, SESSION_COOKIE);
    if (sessionId === undefined) return undefined;
    const session = await config.store.findSession(sessionId);
    if (!sessionIsLive(session, now())) return undefined;
    return config.store.findAccount(session!.accountId);
  }

  /**
   * One live merchant's rows, or the reason they are missing.
   *
   * A read can fail, and a failure comes back as a message rather than an
   * empty list: "the merchant published nothing" and "we could not ask the
   * merchant" are different facts and the screen must not flatten them into
   * one.
   */
  async function readLive(
    catalog: BazaarCatalog | undefined,
    unavailable: Bilingual,
  ): Promise<{ readonly rows: readonly CheckedResource[] | undefined; readonly error?: Bilingual }> {
    if (catalog === undefined) return { rows: undefined, error: unavailable };
    try {
      return { rows: await catalog.list() };
    } catch (error) {
      return { rows: undefined, error: messageFor(error) };
    }
  }

  /**
   * The shop as this account sees it.
   *
   * The two live merchants are read together, so a slow one does not add its
   * wait to the other's. The agents are read from this account's own rows and
   * never from input.
   */
  async function catalogFor(account: Account): Promise<{
    readonly cards: readonly CatalogCard[];
    readonly agents: readonly AgentConfig[];
    readonly bazaarError?: Bilingual;
    readonly vitrineeError?: Bilingual;
    readonly storeErrors: readonly { readonly slug: string; readonly name: string; readonly error: Bilingual }[];
    /** Each store's grant target, from the same rows the cards were drawn from. */
    readonly storeTargets: ReadonlyMap<string, PilotTargets>;
  }> {
    const [agents, bazaar, stores] = await Promise.all([
      config.store.listAgents(account.id),
      readLive(config.bazaarCatalog, BAZAAR_UNAVAILABLE),
      readStores(),
    ]);
    const storeTargets = new Map<string, PilotTargets>();
    for (const store of stores.read) {
      if (store.rows !== undefined) storeTargets.set(store.slug, storeTarget(config.targets, store, store.rows.map((row) => row.id)));
    }
    return {
      cards: buildCatalog({ targets: config.targets, agents, bazaar: bazaar.rows, stores: stores.read }),
      agents,
      ...(bazaar.error === undefined ? {} : { bazaarError: bazaar.error }),
      ...(stores.error === undefined ? {} : { vitrineeError: stores.error }),
      storeErrors: stores.read.flatMap((store) => (store.error === undefined ? [] : [{ slug: store.slug, name: store.name, error: store.error }])),
      storeTargets,
    };
  }

  /** Every Vitrinee store and its rows, each read on its own so one slow store does not hide the others (T104). */
  async function readStores(): Promise<{
    readonly read: readonly (StoreRows & { readonly payTo: string; readonly error?: Bilingual })[];
    readonly error?: Bilingual;
  }> {
    if (config.storefronts === undefined) return { read: [], error: VITRINEE_UNAVAILABLE };
    let stores: readonly Storefront[];
    try {
      stores = await config.storefronts.list();
    } catch (error) {
      return { read: [], error: messageFor(error) };
    }
    const read = await Promise.all(
      stores.map(async (store) => {
        const live = await readLive(store.catalog, VITRINEE_UNAVAILABLE);
        return {
          slug: store.slug,
          name: store.name,
          venueId: store.venueId,
          payTo: store.payTo,
          rows: live.rows,
          ...(live.error === undefined ? {} : { error: live.error }),
        };
      }),
    );
    return { read };
  }

  /**
   * The targets an agent's grant is built from. A store shopper's comes from
   * its own store, read now: the products it lists today, its payout account
   * (T104). `undefined` when that store cannot be read, which the caller shows
   * as "try again", never as a grant built from a guess.
   */
  async function targetsFor(agent: AgentConfig): Promise<PilotTargets | undefined> {
    if (agent.kind !== "vitrinee_shopper" || agent.comercio === null) return config.targets;
    try {
      const store = await config.storefronts?.get(agent.comercio);
      if (store === undefined) return undefined;
      const rows = await store.catalog.list();
      return storeTarget(config.targets, store, rows.map((row) => row.id));
    } catch {
      return undefined;
    }
  }

  /** Opens a session for an account and lands the person on their agents. */
  async function startSession(response: ServerResponse, accountId: string): Promise<void> {
    const session = newSession(accountId, now());
    await config.store.saveSession(session);
    await config.store.touchAccount(accountId, now());
    redirect(response, "/agentes", {
      "set-cookie": cookieFor(session.id, Math.floor((session.expiresAt.getTime() - now().getTime()) / 1000), secure),
    });
  }

  /** Whether signing in goes straight in (no email provider) or sends a link. */
  const direct = config.delivery.mode !== "email" || config.delivery.send === undefined;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", config.baseUrl);
    const { pathname } = url;
    const method = request.method ?? "GET";

    if (method === "GET" && pathname === "/") {
      sendHtml(response, 200, homePage(config.signalDeskUrl));
      return;
    }

    if (method === "GET" && pathname === "/entrar") {
      sendHtml(response, 200, signInPage({ direct }));
      return;
    }

    if (method === "POST" && pathname === "/entrar") {
      const form = await readForm(request);
      const email = emailSchema.safeParse(form.get("email"));
      const alias = aliasSchema.safeParse(form.get("alias"));
      if (!email.success || !alias.success) {
        sendHtml(response, 400, signInPage({ direct, error: bilingual("Check the email and the name.", "Revisa el correo y el nombre.") }));
        return;
      }

      // The email is the account. Signing in again with a known email reaches
      // that same account, and the alias typed this time is not applied.
      const existing = await config.store.findAccountByEmail(email.data);
      const account = existing ?? (await config.store.createAccount(email.data, alias.data));

      if (config.delivery.mode !== "email" || config.delivery.send === undefined) {
        // No email provider: straight in (C-119, decided by the user). The
        // on-screen link this replaced verified nothing either, since it was
        // shown to whoever typed the address; skipping it only removes a click.
        await startSession(response, account.id);
        return;
      }

      const issued = issueMagicLink(account.id, now());
      await config.store.saveMagicLink(issued.link);
      await config.delivery.send(email.data, `${config.baseUrl.replace(/\/+$/, "")}/entrar/${issued.token}`);
      sendHtml(response, 200, linkSentPage());
      return;
    }

    if (method === "GET" && pathname.startsWith("/entrar/")) {
      const token = pathname.slice("/entrar/".length);
      const tokenHash = hashToken(token);
      const link = await config.store.findMagicLink(tokenHash);
      const check = checkMagicLink(link, now());
      if (!check.ok) {
        const reason =
          check.reason === "expired"
            ? bilingual("That link expired. Ask for a new one.", "Ese enlace venció. Pide uno nuevo.")
            : check.reason === "already-used"
              ? LINK_ALREADY_USED
              : bilingual("That link does not exist.", "Ese enlace no existe.");
        sendHtml(response, 400, signInPage({ direct, error: reason }));
        return;
      }

      // The redemption *is* the write, so a replay loses the race instead of
      // tying it.
      const redeemed = await config.store.redeemMagicLink(tokenHash, now());
      if (!redeemed) {
        sendHtml(response, 400, signInPage({ direct, error: LINK_ALREADY_USED }));
        return;
      }

      await startSession(response, link!.accountId);
      return;
    }

    if (method === "GET" && pathname === "/salir") {
      const sessionId = readCookie(request, SESSION_COOKIE);
      if (sessionId !== undefined) await config.store.deleteSession(sessionId);
      redirect(response, "/", { "set-cookie": cookieFor("", 0, secure) });
      return;
    }

    // Everything below needs a session. Note what is *not* here: no handler
    // takes an account or tenant id from the request.
    const account = await currentAccount(request);
    if (account === undefined) {
      redirect(response, "/entrar");
      return;
    }

    if (method === "GET" && pathname === "/agentes") {
      sendHtml(response, 200, agentsPage(account, await config.store.listAgents(account.id)));
      return;
    }

    if (method === "POST" && pathname === "/agentes") {
      const form = await readForm(request);
      const kind = agentKindSchema.safeParse(form.get("kind"));
      const label = aliasSchema.safeParse(form.get("label"));
      const permissions = agentPermissionsSchema.safeParse({
        perTx: form.get("perTx") ?? "",
        perDay: form.get("perDay") ?? "",
        validForDays: Number(form.get("validForDays") ?? Number.NaN),
      });
      if (!kind.success || !label.success || !permissions.success) {
        sendHtml(
          response,
          400,
          errorPage(
            400,
            bilingual(
              "Check the limits: amounts in USDC and validity in days.",
              "Revisa los límites: montos en USDC y vigencia en días.",
            ),
          ),
        );
        return;
      }

      if (kind.data === "vitrinee_shopper") {
        sendHtml(response, 400, errorPage(400, HIRE_STORE_FROM_CATALOGUE));
        return;
      }

      const agent = newAgent(account.id, kind.data, label.data, permissions.data, now());
      await config.store.saveAgent(agent);
      redirect(response, `/agentes/${agent.id}`);
      return;
    }

    // One segment only. `startsWith` alone also matched `/agentes/{id}/volver`
    // and swallowed it before the handler below could see it — found by a
    // test, and the reason this matches a shape instead of a prefix.
    const agentMatch = /^\/agentes\/([^/]+)$/.exec(pathname);
    if (method === "GET" && agentMatch?.[1] !== undefined) {
      const agentId = agentMatch[1];
      // Scoped to this account: another person's agent is a 404, not a 403 —
      // the same posture `/v1` takes, so an id cannot be probed for existence.
      const agent = await config.store.findAgent(account.id, agentId);
      if (agent === undefined) {
        sendHtml(response, 404, errorPage(404, NO_SUCH_AGENT));
        return;
      }
      const targets = await targetsFor(agent);
      if (targets === undefined) {
        sendHtml(response, 503, errorPage(503, STORE_UNAVAILABLE));
        return;
      }
      const translated = translatePermissions(agent.kind, agent.permissions, targets, now());
      sendHtml(response, 200, reviewPage(agent, translated.grant, translated.controls, config.agentpeyBaseUrl));
      return;
    }

    /**
     * Start signing: make sure AgentPey has a tenant for this account, propose
     * the grant, and send the person to AgentPey's own consent page.
     *
     * The grant sent is the one `translatePermissions` built — the same object
     * the review screen rendered. Nothing is recomputed here, so the screen and
     * the request cannot say different things.
     */
    if (method === "POST" && pathname.startsWith("/agentes/") && pathname.endsWith("/firmar")) {
      const agentId = pathname.slice("/agentes/".length, -"/firmar".length);
      const agent = await config.store.findAgent(account.id, agentId);
      if (agent === undefined) {
        sendHtml(response, 404, errorPage(404, NO_SUCH_AGENT));
        return;
      }
      if (config.agentpey === undefined) {
        sendHtml(response, 503, errorPage(503, NOT_CONNECTED));
        return;
      }

      const targets = await targetsFor(agent);
      if (targets === undefined) {
        sendHtml(response, 503, errorPage(503, STORE_UNAVAILABLE));
        return;
      }

      try {
        const tenant = await config.agentpey.ensureTenant(account.externalRef);
        const { grant } = translatePermissions(agent.kind, agent.permissions, targets, now());
        const session = await config.agentpey.createConsentSession({
          tenantId: tenant.id,
          grant,
          // Where AgentPey sends them back to. It only works because this
          // origin is registered for this partner — see `return-urls.ts`.
          returnUrl: `${config.baseUrl.replace(/\/+$/, "")}/agentes/${agent.id}/volver`,
          // Keyed on the agent, so a double click reuses the invitation
          // instead of minting a second one for the same permission.
          idempotencyKey: `consent-${agent.id}`,
        });

        await config.store.saveAgent({ ...agent, tenantId: tenant.id, consentSessionId: session.id });

        if (session.consent_url === null) {
          sendHtml(
            response,
            409,
            errorPage(
              409,
              bilingual(
                "That invitation is no longer available. Try again.",
                "Esa invitación ya no está disponible. Inténtalo de nuevo.",
              ),
            ),
          );
          return;
        }
        redirect(response, session.consent_url);
      } catch (error) {
        sendHtml(response, 502, errorPage(502, messageFor(error)));
      }
      return;
    }

    /**
     * The return from signing. Nothing here believes the browser: it asks
     * AgentPey what actually happened to the session, and the session is found
     * from *this account's* own agent, never from a parameter.
     */
    if (method === "GET" && pathname.startsWith("/agentes/") && pathname.endsWith("/volver")) {
      const agentId = pathname.slice("/agentes/".length, -"/volver".length);
      const agent = await config.store.findAgent(account.id, agentId);
      if (agent === undefined || agent.consentSessionId === null) {
        sendHtml(
          response,
          404,
          errorPage(
            404,
            bilingual("There is no pending signature for that agent.", "No hay ninguna firma pendiente para ese agente."),
          ),
        );
        return;
      }
      if (config.agentpey !== undefined) {
        try {
          const session = await config.agentpey.readConsentSession(agent.consentSessionId);
          if (session.status === "completed" && session.mandate_id !== null) {
            await config.store.saveAgent({ ...agent, mandateId: session.mandate_id });
          }
        } catch {
          // A read that failed is not a reason to lose the page: the review
          // screen below shows whatever state is actually stored.
        }
      }
      redirect(response, `/agentes/${agent.id}`);
      return;
    }

    /**
     * The catalogue: the whole shop, marked against what is actually signed.
     *
     * The bazaar half is read live from a third party, so it can fail — and a
     * failure shows as a message beside a working SignalDesk half, not as a
     * broken page. Nothing here is an authorisation: every card's mark comes
     * from the grant RealOps itself proposed and saw signed, and AgentPey still
     * decides at purchase time.
     */
    if (method === "GET" && pathname === "/catalogo") {
      const { cards, bazaarError, vitrineeError, storeErrors } = await catalogFor(account);
      // A typed sentence lands here with the product and quantity it named.
      // Only a prefill: an unknown product or an odd number is ignored, never
      // an error, because nothing is bought until the person sends the form.
      const prefillProduct = url.searchParams.get("producto");
      const prefillQuantity = Number(url.searchParams.get("cantidad"));
      const prefill =
        prefillProduct !== null &&
        findCard(cards, prefillProduct) !== undefined &&
        Number.isInteger(prefillQuantity) &&
        prefillQuantity >= 1 &&
        prefillQuantity <= MAX_FORM_QUANTITY
          ? { productId: prefillProduct, quantity: prefillQuantity }
          : undefined;
      sendHtml(
        response,
        200,
        catalogPage({
          cards,
          ...(bazaarError === undefined ? {} : { bazaarError }),
          ...(vitrineeError === undefined ? {} : { vitrineeError }),
          storeErrors,
          ...(prefill === undefined ? {} : { prefill }),
        }),
      );
      return;
    }

    /**
     * The permission an item outside the grant would need, shown literally.
     *
     * The same object `translatePermissions` builds for the review screen, from
     * the same function, so the two screens cannot describe different grants.
     */
    if (method === "GET" && pathname === "/catalogo/permiso") {
      const productId = url.searchParams.get("producto");
      const { cards, storeTargets } = await catalogFor(account);
      const card = productId === null ? undefined : findCard(cards, productId);
      const targets = card?.store === undefined ? config.targets : storeTargets.get(card.store.slug);
      if (card === undefined || targets === undefined) {
        sendHtml(response, 404, errorPage(404, NO_SUCH_PRODUCT));
        return;
      }
      const translated = translatePermissions(card.kind, defaultPermissionsFor(card.kind), targets, now());
      sendHtml(
        response,
        200,
        grantDiffPage({
          card,
          agentName: AGENT_KIND_NAMES[card.kind],
          grant: translated.grant,
          controls: translated.controls,
        }),
      );
      return;
    }

    /**
     * Set up the agent an out-of-grant item would need.
     *
     * This creates a row and authorises nothing: the person lands back on the
     * review screen, and signing still happens on AgentPey's domain with their
     * own wallet. The kind is resolved from the product against `targets`, never
     * taken from the form, so a posted product id cannot name a power RealOps
     * does not already offer.
     */
    if (method === "POST" && pathname === "/catalogo/permiso") {
      const form = await readForm(request);
      const productId = form.get("product_id");
      const { cards } = await catalogFor(account);
      const card = productId === null ? undefined : findCard(cards, productId);
      if (card === undefined) {
        sendHtml(response, 404, errorPage(404, NO_SUCH_PRODUCT));
        return;
      }
      if (card.coverage.state !== "outside") {
        // Already has one. Sending them to it beats minting a second agent
        // with the same power because a form was posted twice.
        redirect(response, `/agentes/${card.coverage.agentId}`);
        return;
      }
      // A store shopper is bound to the store of the card it was hired from
      // (T104). The store comes from the card RealOps drew, never from the form.
      const label = card.store === undefined ? AGENT_KIND_NAMES[card.kind].en : `${AGENT_KIND_NAMES[card.kind].en} · ${card.store.name}`;
      const agent = newAgent(account.id, card.kind, label, defaultPermissionsFor(card.kind), now(), card.store?.slug ?? null);
      await config.store.saveAgent(agent);
      redirect(response, `/agentes/${agent.id}`);
      return;
    }

    if (method === "GET" && pathname === "/servicios") {
      const agents = await config.store.listAgents(account.id);
      const tenantId = agents.find((agent) => agent.tenantId !== null)?.tenantId ?? null;

      // One call for everything this page shows. The numbers come from the
      // same code that runs the authorisation (`@agentpey/activity`, C-81), so
      // the figure a person reads is the figure a purchase is checked against.
      let activity = null;
      let activityError: Bilingual | undefined;
      if (config.agentpey !== undefined && tenantId !== null) {
        try {
          activity = await config.agentpey.readActivity(tenantId);
        } catch (error) {
          activityError = messageFor(error);
        }
      }

      sendHtml(response, 200, servicesPage({ account, activity, activityError, agents }));
      return;
    }

    /**
     * Ask for a purchase.
     *
     * Note the order and what it means: the instruction is read here, and the
     * *only* thing that reading produces is a product kind and a quantity. The
     * venue, the price, the asset and the payee are never taken from the
     * sentence — they come from the signed Mandate and from the merchant's own
     * invoice, on AgentPey's side. A misreading buys the wrong product; it
     * cannot buy at the wrong place, for the wrong amount, or from the wrong
     * account.
     */
    if (method === "POST" && pathname === "/instruccion") {
      const form = await readForm(request);
      const chosen = agentKindSchema.safeParse(form.get("kind"));
      const posted = form.get("product_id");
      const instruction = form.get("instruction") ?? "";

      // The catalogue's forms, and only they, carry a product id. It is
      // resolved against the catalogue this account can see — never taken as
      // the name of a product — so a posted id cannot reach a venue or a
      // product no `PilotTarget` already names.
      const { cards, storeTargets } = await catalogFor(account);

      let kind: AgentKind;
      let productId: string;
      let quantity = 1;
      let pair: string | undefined;
      let formParams: Readonly<Record<string, string>> = {};
      // The Vitrinee store of the card being bought (T104). A store shopper buys
      // only at the store it was hired for.
      let storeSlug: string | undefined;

      if (posted !== null) {
        const card = findCard(cards, posted);
        if (card === undefined) {
          sendHtml(response, 404, errorPage(404, NO_SUCH_PRODUCT));
          return;
        }
        const read = readRouteParams(card, form);
        if (read.missing.length > 0) {
          sendHtml(response, 400, errorPage(400, MISSING_PARAMS));
          return;
        }
        if (read.badQuantity) {
          sendHtml(response, 400, errorPage(400, BAD_QUANTITY));
          return;
        }
        kind = card.kind;
        productId = card.productId;
        storeSlug = card.store?.slug;
        quantity = read.quantity ?? 1;
        formParams = read.params;
        pair = kind === "market_brief" ? SUPPORTED_PAIR : undefined;
      } else if (chosen.success) {
        // The fallback buttons: a kind chosen explicitly, with nothing guessed.
        kind = chosen.data;
        const firstOfKind = cards.find((card) => card.kind === kind);
        if (firstOfKind === undefined) {
          sendHtml(response, 404, errorPage(404, NO_SUCH_PRODUCT));
          return;
        }
        productId = firstOfKind.productId;
        storeSlug = firstOfKind.store?.slug;
        pair = kind === "market_brief" ? SUPPORTED_PAIR : undefined;
      } else {
        try {
          const read = interpretInstruction(instruction);
          kind = read.kind;
          productId = read.productId;
          quantity = read.quantity;
          pair = read.pair;
          // A typed sentence can name the bazaar's product but not its
          // parameters (which pair, which tone, how long). Inventing them is
          // the guess `interpretInstruction` exists not to make, so the person
          // is sent to the card that asks.
          // The quantity the sentence named travels with it, so the card opens
          // with it already filled in; the person still sees and can change it.
          const card = findCard(cards, productId);
          if (card !== undefined && card.inputs.some((input) => !card.serverFilled.includes(input.name))) {
            const query = new URLSearchParams({ producto: productId, cantidad: String(quantity) });
            redirect(response, `/catalogo?${query.toString()}#${encodeURIComponent(productId)}`);
            return;
          }
        } catch (error) {
          if (isAgentPassError(error) && error.code === "InstructionNotUnderstood") {
            sendHtml(response, 200, notRecognisedPage(problemOf(error.details), String(error.details.instruction ?? "")));
            return;
          }
          throw error;
        }
      }

      // Every agent of this account that could buy what was asked: the right
      // kind, and a signed Mandate. Read from this account's own agents only;
      // an `agent_id` from the form is looked up among these and nowhere else.
      const agents = await config.store.listAgents(account.id);
      const candidates = agents.filter(
        (candidate) =>
          candidate.kind === kind &&
          candidate.mandateId !== null &&
          candidate.tenantId !== null &&
          (kind !== "vitrinee_shopper" || candidate.comercio === storeSlug),
      );
      if (candidates.length === 0) {
        sendHtml(
          response,
          409,
          errorPage(
            409,
            bilingual(
              "You do not have an agent with a signed permission for that. The catalogue shows exactly which permission it needs.",
              "No tienes un agente con permiso firmado para eso. El catálogo muestra exactamente qué permiso necesita.",
            ),
          ),
        );
        return;
      }
      // One key per rendered form, not per attempt (C-98, amended in T84). The
      // form carries a key minted when the page was drawn, so sending the same
      // form again — a double click, a resubmit after a timeout — replays the
      // purchase AgentPey already made instead of paying a second time. Asking
      // again from a fresh page is still a new purchase, which is what C-98
      // protects; the daily limit is still what bounds it.
      const requestKey = requestKeySchema.safeParse(form.get("request_key"));

      // Which agent buys (T90, decided by the user). With one candidate there
      // is nothing to choose. With more, the person chooses, and the choice
      // page carries this same form's key, so choosing is still one form.
      const chosenId = form.get("agent_id");
      let agent = candidates[0]!;
      if (chosenId !== null) {
        const match = candidates.find((candidate) => candidate.id === chosenId);
        if (match === undefined) {
          sendHtml(response, 400, errorPage(400, CANNOT_BUY_THAT));
          return;
        }
        agent = match;
      } else if (candidates.length > 1) {
        sendHtml(
          response,
          200,
          chooseAgentPage({
            agents: candidates,
            kind,
            // What was asked for, carried verbatim through the choice: the
            // catalogue's product and its parameters, or the kind, or the
            // sentence. Losing any of them here would buy something else.
            ...(posted !== null
              ? { productId, params: formParams }
              : chosen.success
                ? { chosenKind: kind }
                : { instruction }),
            requestKey: requestKey.success ? requestKey.data : randomUUID(),
          }),
        );
        return;
      }

      if (config.agentpey === undefined) {
        sendHtml(response, 503, errorPage(503, NOT_CONNECTED));
        return;
      }

      try {
        await config.agentpey.purchase({
          tenantId: agent.tenantId!,
          // The venue of the *kind* that is buying, not a global one (T96).
          // AgentPey resolves it against its own `venues.json` regardless, so
          // naming a venue it does not know produces a refusal, never a payment.
          venue:
            kind === "vitrinee_shopper" && storeSlug !== undefined
              ? (storeTargets.get(storeSlug)?.vitrinee_shopper.venueId ?? config.targets[kind].venueId)
              : config.targets[kind].venueId,
          productId,
          quantity,
          // What RealOps owns first, so a form field can never override it:
          // the credits route's `account` stays the tenant's opaque reference
          // whatever a browser posts.
          routeParams: { ...formParams, ...serverParamsFor(productId, pair, account.externalRef) },
          // Always the chosen agent's own Mandate, even when it is the only
          // one: AgentPey then goes through exactly the permission this page
          // says is buying, and a revoked one is refused rather than replaced.
          mandateId: agent.mandateId!,
          // The form, not the agent: choosing another agent from the same form
          // is the same request with a different body, which AgentPey answers
          // with `409` instead of making a second purchase (T90).
          idempotencyKey: `buy-${requestKey.success ? requestKey.data : randomUUID()}`,
        });
      } catch (error) {
        if (isAgentPassError(error) && error.details.code === "IdempotencyKeyConflict") {
          sendHtml(response, 409, errorPage(409, ALREADY_ASKED));
          return;
        }
        // T95: AgentPey counts requests before it does anything else, so a
        // `429` here means this purchase was never attempted. Unlike a
        // timeout, it is safe to say nothing was bought — and to say when to
        // try again, which is the only useful thing a person can do about it.
        if (isAgentPassError(error) && error.details.code === "RateLimited") {
          sendHtml(
            response,
            429,
            errorPage(
              429,
              bilingual(
                "Too many requests to AgentPey right now, so nothing was bought. Wait a minute and ask again.",
                "Hay demasiados pedidos a AgentPey en este momento, así que no se compró nada. Espera un minuto y vuelve a pedirlo.",
              ),
            ),
          );
          return;
        }
        // A timeout is not a failure to buy: AgentPey may still be settling the
        // payment. Saying "could not reach" here is what made people retry and
        // pay twice in the deployed pilot (T84).
        if (isAgentPassError(error) && error.details.timedOut === true) {
          sendHtml(
            response,
            504,
            errorPage(
              504,
              bilingual(
                "AgentPey has not confirmed the purchase yet, and it may have completed. Check My services before asking for it again.",
                "AgentPey todavía no confirma la compra y puede haberse completado. Revisa Mis servicios antes de volver a pedirla.",
              ),
            ),
          );
          return;
        }
        // A refusal is a `201` and lands on the page below. Reaching here means
        // the request itself failed, which is a different thing and says so.
        sendHtml(response, 502, errorPage(502, messageFor(error)));
        return;
      }

      redirect(response, "/servicios");
      return;
    }

    if (method === "POST" && pathname === "/cuenta/borrar") {
      await config.store.forgetAccount(account.id);
      await config.store.deleteSessionsFor(account.id);
      redirect(response, "/", { "set-cookie": cookieFor("", 0, secure) });
      return;
    }

    sendHtml(response, 404, errorPage(404, bilingual("There is nothing at that address.", "No hay nada en esta dirección.")));
  }

  return createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const status = isAgentPassError(error) && error.code === "InvalidArguments" ? 400 : 500;
      sendHtml(
        response,
        status,
        errorPage(
          status,
          status === 400
            ? bilingual("Invalid request.", "Petición inválida.")
            : bilingual("Something failed on our side.", "Algo falló de nuestro lado."),
        ),
      );
    });
  });
}
