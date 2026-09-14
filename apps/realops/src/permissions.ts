/**
 * Turning what a person ticked in a form into the grant they are about to
 * sign — and being honest, on screen, about which layer makes each one true.
 *
 * **Why this is a pure function with its own tests.** The review screen has to
 * show *literally* the grant that will be signed, not a friendly paraphrase of
 * it. If the translation lived inline in a page template, the screen and the
 * request could drift, and the drift would be invisible precisely because both
 * would look right. One function builds it; the screen renders what it built;
 * T81 sends the same object.
 *
 * **And the honesty requirement is part of the output, not a comment.** Every
 * control carries an `enforcedBy`, because the difference between "signed",
 * "on-chain" and "RealOps decides" is the difference between a guarantee and a
 * promise. `PILOTO-F9.md` § 7.1 asks for that mark to be visible. A UI that
 * displayed them all the same way would be claiming guarantees the system does
 * not make.
 */
import { z } from "zod";

import type { AgentKind, AgentPermissions } from "./accounts.js";
import { bilingual, type Bilingual } from "./copy.js";

/** Where the venue and asset come from. Not chosen in the UI: the pilot has one merchant. */
export interface PilotTargets {
  /** `signaldesk:G…` — the venue identity from `venues.json`. */
  readonly venueId: string;
  /** `USDC:C…` — the asset id the venue quotes. */
  readonly assetId: string;
  /** The merchant's payout account. Compared against the 402 invoice by `reconcileTerms`. */
  readonly payTo: string;
  /** The product ids each agent kind is allowed to buy. */
  readonly products: Readonly<Record<AgentKind, readonly string[]>>;
}

/**
 * The shape `POST /v1/consent_sessions` takes as its proposed grant. Mirrors
 * `mandateGrantSchema` (`packages/mandate`), including `products` as added in
 * T73 — kept as a local schema on purpose: RealOps is a partner, and a partner
 * builds this from the published contract, not from an internal import.
 */
export const proposedGrantSchema = z.strictObject({
  actions: z.array(z.string()).min(1),
  venues: z.array(z.string()).min(1),
  assets: z.array(z.string()).min(1),
  products: z.array(z.string()).min(1),
  payTo: z.array(z.string()).min(1),
  limits: z.strictObject({
    perTx: z.string(),
    perDay: z.string(),
    currency: z.string(),
  }),
  validFrom: z.string(),
  validUntil: z.string(),
});

export type ProposedGrant = z.infer<typeof proposedGrantSchema>;

/** Who actually makes a control true. The three are not interchangeable. */
export type Enforcer = "signed" | "onchain" | "realops";

export interface ExplainedControl {
  /** What the person set, in their words. */
  readonly label: Bilingual;
  /** What it became in the grant. */
  readonly field: string;
  readonly value: string;
  readonly enforcedBy: Enforcer;
  /** One sentence a non-technical person can read. */
  readonly explanation: Bilingual;
}

export interface TranslatedPermissions {
  readonly grant: ProposedGrant;
  readonly controls: readonly ExplainedControl[];
}

/**
 * The single action the pilot's agents are authorised for.
 *
 * Must be `checkScope`'s own `INTENT_CREATE_ACTION` (`apps/agent/src/scope`),
 * the one action string every real Mandate needs — documented for partners
 * in `examples/cloudops-partner-integration.md` (`actions: ["catalog:read",
 * "intent:create"]`). This was `"purchase"`, a name invented for this file
 * that never matched what enforcement actually checks: every real
 * consent-session mandate signed through F9 was rejected at the first
 * purchase attempt with `ScopeActionNotAllowed: this credential does not
 * permit "intent:create"` — found running the flow end to end with a real
 * signed Mandate, not by reading. RealOps does not import `apps/agent`
 * (a partner builds from the published contract, not an internal import,
 * `C-75`'s precedent), so the value is copied here rather than imported —
 * and has to stay copied correctly.
 */
export const PURCHASE_ACTION = "intent:create";
export const CURRENCY = "USDC";

/**
 * Builds the grant, and the explanation of it, from one agent's permissions.
 *
 * The dates are computed from `now` rather than taken from the caller: a
 * validity window a browser could choose is a validity window an attacker
 * could choose.
 */
export function translatePermissions(
  kind: AgentKind,
  permissions: AgentPermissions,
  targets: PilotTargets,
  now: Date = new Date(),
): TranslatedPermissions {
  const validUntil = new Date(now.getTime() + permissions.validForDays * 24 * 60 * 60 * 1000);
  const products = targets.products[kind];

  const grant: ProposedGrant = {
    actions: [PURCHASE_ACTION],
    venues: [targets.venueId],
    assets: [targets.assetId],
    products: [...products],
    payTo: [targets.payTo],
    limits: {
      perTx: permissions.perTx,
      perDay: permissions.perDay,
      currency: CURRENCY,
    },
    validFrom: now.toISOString(),
    validUntil: validUntil.toISOString(),
  };

  const controls: ExplainedControl[] = [
    {
      label: bilingual("Where it can buy", "Dónde puede comprar"),
      field: "venues",
      value: targets.venueId,
      enforcedBy: "signed",
      explanation: bilingual(
        "AgentPey resolves the merchant against its own registry and refuses any other before making a single call to it.",
        "AgentPey resuelve el comercio contra su propio registro y rechaza cualquier otro antes de hacerle una sola llamada.",
      ),
    },
    {
      label: bilingual("What it can buy", "Qué puede comprar"),
      field: "products",
      value: products.join(", "),
      enforcedBy: "signed",
      explanation: bilingual(
        "The per-product permission is inside the Mandate you are about to sign: a different product is refused even from the same merchant.",
        "El permiso por producto va dentro del Mandato que vas a firmar: un producto distinto se rechaza aunque sea del mismo comercio.",
      ),
    },
    {
      label: bilingual("Which asset", "Con qué activo"),
      field: "assets",
      value: targets.assetId,
      enforcedBy: "signed",
      explanation: bilingual(
        "A payment in any other asset is refused, even if the merchant offers it.",
        "Un pago en cualquier otro activo se rechaza, aunque el comercio lo ofrezca.",
      ),
    },
    {
      label: bilingual("Which account it can pay", "A qué cuenta puede pagar"),
      field: "payTo",
      value: targets.payTo,
      enforcedBy: "signed",
      explanation: bilingual(
        "AgentPey requests the invoice from the merchant itself and checks the receiving account against this one before paying.",
        "AgentPey pide él mismo la factura al comercio y compara la cuenta que cobra con esta antes de pagar.",
      ),
    },
    {
      label: bilingual("Max per purchase", "Máximo por compra"),
      field: "limits.perTx",
      value: `${permissions.perTx} ${CURRENCY}`,
      enforcedBy: "onchain",
      explanation: bilingual(
        "Signed, and revalidated by the contract on Stellar: even if everything else failed, the network would not let a larger amount through.",
        "Firmado y además revalidado por el contrato en Stellar: aunque todo lo demás fallara, la red no deja pasar un monto mayor.",
      ),
    },
    {
      label: bilingual("Max per day", "Máximo por día"),
      field: "limits.perDay",
      value: `${permissions.perDay} ${CURRENCY}`,
      enforcedBy: "onchain",
      explanation: bilingual(
        "Signed and revalidated by the contract. The day's spending is kept in the durable ledger, not in memory.",
        "Firmado y revalidado por el contrato. El gasto del día se lleva en el registro durable, no en memoria.",
      ),
    },
    {
      label: bilingual("Valid until", "Hasta cuándo vale"),
      field: "validUntil",
      value: validUntil.toISOString(),
      enforcedBy: "signed",
      explanation: bilingual(
        "After that date the Mandate stops authorizing, without anyone having to do anything.",
        "Pasada esa fecha el Mandato deja de autorizar, sin que nadie tenga que hacer nada.",
      ),
    },
    {
      label: bilingual("Agent name", "Nombre del agente"),
      field: "label",
      value: "RealOps",
      enforcedBy: "realops",
      explanation: bilingual(
        "This is a label on this platform. It does not travel into the Mandate and does not change what the agent can do.",
        "Es una etiqueta de esta plataforma. No viaja al Mandato y no cambia lo que el agente puede hacer.",
      ),
    },
  ];

  return { grant, controls };
}

/** How many of a grant's controls are actually enforced by something signed or on-chain. */
export function enforcementSummary(controls: readonly ExplainedControl[]): Record<Enforcer, number> {
  return controls.reduce<Record<Enforcer, number>>(
    (totals, control) => ({ ...totals, [control.enforcedBy]: totals[control.enforcedBy] + 1 }),
    { signed: 0, onchain: 0, realops: 0 },
  );
}
