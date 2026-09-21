/**
 * The frozen `/v1` API-key permission list, and the pure decision of whether
 * a key's granted permissions cover a route.
 *
 * Named `ApiScope`, not `Scope`: `@agentpass/core` already exports `Scope` for
 * an entirely different thing — a credential or mandate's spending scope
 * (`actions`/`venues`/`assets`/`limits`). Reusing that name here for "what
 * this API key may call" would make every import of either one ambiguous at
 * a glance, in a codebase that already has enough load-bearing "scope"s.
 *
 * `PLATAFORMA-PARTNERS.md` §2.7 proposed a minimal, damage-separated set
 * (`tenants:write`, `agents:write`, `consent:create`, `mandates:read`,
 * `mandates:revoke`, `payments:authorize`, `vault:read`). T45 froze only the
 * permissions a T45-shaped route actually checked, with an explicit rule for
 * the rest: "extend this list, additively, the day a ticket implements the
 * route it would guard", because a permission nobody can be granted for is
 * worse than none at all — it looks wired when it is not.
 *
 * **T73 is that day for three of them.** F9 needs a partner to be able to
 * ask for a purchase and to read back what happened, so `payments:authorize`,
 * `payments:read` and `vault:read` join the list alongside the routes of
 * `resources/purchases.ts` and `resources/activity.ts`. They are three
 * permissions and not one on purpose, following the same damage-separation
 * the original set had: a key that can *read* a tenant's spending history
 * has no business being able to *spend*, and the overwhelmingly common
 * integration — a dashboard — only ever needs the reads.
 *
 * **T93 adds `payments:preview`**, by the same damage-separation rule. A
 * preview spends nothing: it answers whether a purchase *would* be allowed,
 * reserving no budget and signing nothing. Folding it into
 * `payments:authorize` would mean a dashboard that only ever wants to show a
 * person "this would be refused, because…" had to hold the permission to
 * actually spend their money. It is deliberately **not implied by**
 * `payments:authorize` either — this list is flat, and inventing a hierarchy
 * for one pair would make every future reader wonder which other pairs have one.
 *
 * **T94 adds `webhooks:read` and `webhooks:write`**, split for a reason that
 * is sharper here than anywhere else in this list. Registering an endpoint is
 * the one thing a partner can do that makes *this* process open an outbound
 * connection to an address *they* chose — the SSRF surface `webhook-url.ts`
 * exists to fence. Listing endpoints is harmless. Folding the two together
 * would mean a key that only needs to display a partner's configuration also
 * carries the power to point AgentPey's network at something.
 *
 * `mandates:revoke` is still not included: revocation stays a wallet-signed
 * action the principal takes through the hosted flow, not something a
 * partner's API key can trigger on their behalf.
 */
import { z } from "zod";

export const API_SCOPES = [
  "tenants:read",
  "tenants:write",
  "agents:read",
  "consent_sessions:read",
  "consent_sessions:write",
  "mandates:read",
  "payments:authorize",
  "payments:preview",
  "payments:read",
  "vault:read",
  "webhooks:read",
  "webhooks:write",
] as const;

export const apiScopeSchema = z.enum(API_SCOPES);

export type ApiScope = z.infer<typeof apiScopeSchema>;

/** True when every element of `scopes` is a permission this frozen list knows. */
export function areValidApiScopes(scopes: readonly string[]): scopes is readonly ApiScope[] {
  return scopes.every((scope) => (API_SCOPES as readonly string[]).includes(scope));
}

/**
 * Whether a key holding `granted` may call a route that requires `required`.
 * Pure and framework-agnostic on purpose — `authorizeRequest` (`auth.ts`)
 * calls this after authenticating the key; whatever wires `/v1` to Node's
 * `http` (T49) calls that in turn, without reimplementing this check.
 */
export function apiScopeCovers(granted: readonly string[], required: ApiScope): boolean {
  return granted.includes(required);
}
