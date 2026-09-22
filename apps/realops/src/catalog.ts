/**
 * The shop, contrasted against what the visitor's agents are actually allowed
 * to buy.
 *
 * **The idea this module exists for.** Until T96 RealOps showed two buttons,
 * because those were the two things its one agent could buy. Everything else in
 * the world was invisible, and a person who went looking for it met a wall with
 * no explanation. The wall was right — AgentPey refuses what no Mandate covers,
 * and it should — but hiding it wasted the best demonstration the pilot has.
 *
 * So the catalogue shows the whole shop, and marks each item against the
 * permission that has actually been signed. An item outside the grant is not
 * hidden and not an error: it is an offer to sign a specific, visible, literal
 * increase in what an agent may do.
 *
 * **What this module is allowed to claim.** Only what RealOps itself proposed
 * and watched get signed. `coverageOf` reproduces the grant the same pure
 * function builds for the review screen (`translatePermissions`), so the
 * screen cannot drift from the request. It is not a second opinion on
 * authorisation and must never be read as one: AgentPey decides at purchase
 * time, against the Mandate itself, and can still refuse something marked
 * covered here — an expired window, a revoked Mandate, a day's limit already
 * spent, an invoice that does not match. The copy says so on the page, because
 * a screen that implied otherwise would be claiming a guarantee RealOps is
 * structurally incapable of making.
 */
import type { AgentConfig, AgentKind } from "./accounts.js";
import { agentKindSchema } from "./accounts.js";
import { bilingual, type Bilingual } from "./copy.js";
import type { CheckedResource, ResourceAvailability, ResourceInput } from "./bazaar-catalog.js";
import type { PilotTargets } from "./permissions.js";

/** The two groups the shop is drawn in. A merchant, not a product taxonomy. */
export type CatalogVenue = "signaldesk" | "bazaar";

/**
 * How an item stands against this account's signed permissions.
 *
 * - `covered` — an agent of this kind exists and its Mandate is signed. The
 *   buy form is offered. AgentPey still decides.
 * - `unsigned` — the agent exists but nobody has signed its permission yet.
 *   Nothing new to grant: finish the signature that is already waiting.
 * - `outside` — no agent of this account holds a permission covering this. The
 *   card offers the diff of what would have to be signed.
 */
export type Coverage =
  | { readonly state: "covered"; readonly agentId: string; readonly agentLabel: string }
  | { readonly state: "unsigned"; readonly agentId: string; readonly agentLabel: string }
  | { readonly state: "outside" };

export interface CatalogCard {
  readonly venue: CatalogVenue;
  /** The merchant's own product id, verbatim. This is what lands in a signed intent. */
  readonly productId: string;
  /** The kind of agent whose grant names this product. */
  readonly kind: AgentKind;
  readonly venueId: string;
  /**
   * Both languages, always (`copy.ts`). A merchant that publishes one string
   * gets that string in both, rather than the server picking a language: the
   * same URL must render the same bytes for everyone, or a cached page comes
   * back in the wrong language.
   */
  readonly title: Bilingual;
  readonly description: Bilingual;
  /**
   * The merchant's declared price, for a person to read.
   *
   * **Never a decision input** (`C-77`). AgentPey re-fetches the merchant's own
   * 402 at purchase time and `reconcileTerms` compares *that* against the
   * signed Mandate. A catalogue that lies about the price cannot cause an
   * overpayment; it can only make this line wrong.
   */
  readonly declaredAmount: string;
  readonly declaredAsset: string;
  /** What the merchant requires to serve it. Becomes the fields of the buy form. */
  readonly inputs: readonly ResourceInput[];
  /**
   * Inputs RealOps fills itself, which therefore never appear as form fields.
   *
   * Two reasons, and both matter. The credits route wants an `account`: that is
   * the *tenant's* opaque reference, and letting a browser supply it would let
   * a person credit somebody else — and would put a value RealOps controls
   * under the control of whoever is typing. The report's `pair` is fixed by the
   * pilot to the one pair it knows. Anything not listed here is the person's to
   * fill, and the bazaar's resources are entirely theirs.
   */
  readonly serverFilled: readonly string[];
  readonly availability: ResourceAvailability;
  readonly coverage: Coverage;
}

/**
 * SignalDesk's two products, described here rather than fetched.
 *
 * Deliberate: SignalDesk is the path the pilot has demonstrated since T54, and
 * making it newly depend on a live catalogue read would put a demo that works
 * behind a network call that can fail. The bazaar is read live because a
 * catalogue that can change is the whole point of it. When SignalDesk's
 * discovery is wanted live too, it speaks the same API and
 * `createBazaarCatalog` already reads it unchanged.
 */
const SIGNALDESK_PRODUCTS: readonly {
  readonly productId: string;
  readonly kind: AgentKind;
  readonly title: Bilingual;
  readonly description: Bilingual;
  readonly declaredAmount: string;
  readonly inputs: readonly ResourceInput[];
  readonly serverFilled: readonly string[];
}[] = [
  {
    productId: "signaldesk:market-brief-xlm-usdc",
    kind: "market_brief",
    title: bilingual("XLM/USDC market report", "Informe de mercado XLM/USDC"),
    description: bilingual(
      "A short written read on the XLM/USDC pair. The data is synthetic: this is a pilot, not advice.",
      "Una lectura escrita y breve del par XLM/USDC. Los datos son sintéticos: esto es un piloto, no una recomendación.",
    ),
    declaredAmount: "0.25",
    inputs: [{ name: "pair", type: "string", required: true }],
    serverFilled: ["pair"],
  },
  {
    productId: "signaldesk:ai-credits-1000",
    kind: "ai_credits",
    title: bilingual("1000 AI credits", "1000 créditos de IA"),
    description: bilingual(
      "A pack of 1000 product credits, added to your account. They are not transferable.",
      "Un paquete de 1000 créditos de producto, acreditados a tu cuenta. No son transferibles.",
    ),
    declaredAmount: "0.10",
    inputs: [{ name: "account", type: "string", required: true }],
    serverFilled: ["account"],
  },
];

/** Which kind of agent, if any, holds a grant naming this product at this venue. */
export function kindFor(targets: PilotTargets, venueId: string, productId: string): AgentKind | undefined {
  for (const kind of agentKindSchema.options) {
    const target = targets[kind];
    if (target.venueId === venueId && target.products.includes(productId)) return kind;
  }
  return undefined;
}

/**
 * How this account stands against one kind.
 *
 * A signed agent wins over an unsigned one, so an account that made two
 * attempts at the same agent sees the one that actually works. Among signed
 * agents the first is taken; they hold the same grant, because the grant is a
 * function of the kind and the permissions, and the buy form re-resolves the
 * agent from the account's own rows anyway.
 */
export function coverageOf(agents: readonly AgentConfig[], kind: AgentKind): Coverage {
  const ofKind = agents.filter((agent) => agent.kind === kind);
  const signed = ofKind.find((agent) => agent.mandateId !== null && agent.tenantId !== null);
  if (signed !== undefined) {
    return { state: "covered", agentId: signed.id, agentLabel: signed.label };
  }
  const started = ofKind[0];
  if (started !== undefined) {
    return { state: "unsigned", agentId: started.id, agentLabel: started.label };
  }
  return { state: "outside" };
}

export interface BuildCatalogInput {
  readonly targets: PilotTargets;
  readonly agents: readonly AgentConfig[];
  /** The bazaar's live rows, or `undefined` when the read failed. Empty is a different fact. */
  readonly bazaar: readonly CheckedResource[] | undefined;
}

/**
 * The whole shop, in the order it is drawn: SignalDesk first, then the bazaar.
 *
 * A bazaar row naming a product no grant could ever cover is dropped rather
 * than drawn as permanently forbidden. Offering to sign a permission for a
 * product that is not in any `PilotTarget` would be offering a grant RealOps
 * cannot build, and a button that cannot work is worse than an absence.
 */
export function buildCatalog(input: BuildCatalogInput): readonly CatalogCard[] {
  const signaldesk: CatalogCard[] = SIGNALDESK_PRODUCTS.map((product) => ({
    venue: "signaldesk" as const,
    productId: product.productId,
    kind: product.kind,
    venueId: input.targets[product.kind].venueId,
    title: product.title,
    description: product.description,
    declaredAmount: product.declaredAmount,
    declaredAsset: "USDC",
    inputs: product.inputs,
    serverFilled: product.serverFilled,
    // SignalDesk is the pilot's own merchant and the path that has been
    // exercised since T54. It is not probed on every page render.
    availability: "sellable" as const,
    coverage: coverageOf(input.agents, product.kind),
  }));

  const bazaarVenueId = input.targets.bazaar_shopper.venueId;
  const bazaar: CatalogCard[] = (input.bazaar ?? []).flatMap((resource) => {
    const kind = kindFor(input.targets, bazaarVenueId, resource.id);
    if (kind === undefined) return [];
    return [
      {
        venue: "bazaar" as const,
        productId: resource.id,
        kind,
        venueId: bazaarVenueId,
        // The merchant's own words, in whatever language it wrote them. Shown
        // identically in both, because inventing a translation of a third
        // party's product description would be putting words in its mouth.
        title: bilingual(resource.name, resource.name),
        description: bilingual(resource.description, resource.description),
        declaredAmount: resource.declaredAmount,
        declaredAsset: resource.declaredAsset,
        inputs: resource.inputs,
        // The bazaar's resources ask for nothing RealOps owns: every parameter
        // is the person's to choose, which is why they need a form at all.
        serverFilled: [],
        availability: resource.availability,
        coverage: coverageOf(input.agents, kind),
      },
    ];
  });

  return [...signaldesk, ...bazaar];
}

/** The one card a product id names, among the ones this account can see. */
export function findCard(cards: readonly CatalogCard[], productId: string): CatalogCard | undefined {
  return cards.find((card) => card.productId === productId);
}
