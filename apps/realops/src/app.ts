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
  chooseAgentPage,
  errorPage,
  homePage,
  linkSentPage,
  notRecognisedPage,
  reviewPage,
  servicesPage,
  signInPage,
} from "./pages.js";
import { translatePermissions, type PilotTargets } from "./permissions.js";

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
function routeParamsFor(
  kind: AgentKind,
  pair: string | undefined,
  account: string,
): Readonly<Record<string, string | number>> {
  // The credits route credits an address. It is the *tenant's* opaque
  // reference and never the person's email — SignalDesk has no business
  // learning who anyone is.
  return kind === "market_brief" ? { pair: pair ?? SUPPORTED_PAIR } : { account };
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
      const translated = translatePermissions(agent.kind, agent.permissions, config.targets, now());
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

      try {
        const tenant = await config.agentpey.ensureTenant(account.externalRef);
        const { grant } = translatePermissions(agent.kind, agent.permissions, config.targets, now());
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
      const instruction = form.get("instruction") ?? "";

      let kind: AgentKind;
      let quantity = 1;
      let pair: string | undefined;
      if (chosen.success) {
        // The fallback buttons: a kind chosen explicitly, with nothing guessed.
        kind = chosen.data;
        pair = kind === "market_brief" ? SUPPORTED_PAIR : undefined;
      } else {
        try {
          const read = interpretInstruction(instruction);
          kind = read.kind;
          quantity = read.quantity;
          pair = read.pair;
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
        (candidate) => candidate.kind === kind && candidate.mandateId !== null && candidate.tenantId !== null,
      );
      if (candidates.length === 0) {
        sendHtml(
          response,
          409,
          errorPage(
            409,
            bilingual(
              "You do not have an agent with a signed permission for that. Set one up and sign it first.",
              "No tienes un agente con permiso firmado para eso. Configura uno y fírmalo primero.",
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
            ...(chosen.success ? { chosenKind: kind } : { instruction }),
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
          venue: config.targets.venueId,
          productId: config.targets.products[kind][0]!,
          quantity,
          routeParams: routeParamsFor(kind, pair, account.externalRef),
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
