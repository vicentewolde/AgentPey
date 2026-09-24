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

/** The three groups the shop is drawn in. A merchant, not a product taxonomy. */
export type CatalogVenue = "signaldesk" | "bazaar" | "vitrinee";

/**
 * The one route input that is not a route parameter (T100, `C-132`).
 *
 * A Vitrinee store prices per unit and declares `quantity` as an input of its
 * paid route. AgentPey fills that input from the purchase's own quantity, the
 * one the intent is signed for, and refuses a `route_params.quantity` that
 * says otherwise (`RouteParamConflict`). So RealOps reads this field as the
 * purchase's quantity and never forwards it as a route parameter: one number,
 * carried once, in the place that gets signed.
 */
export const QUANTITY_INPUT = "quantity";

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

/** The Vitrinee store a card belongs to (T104). Absent for SignalDesk and the bazaar. */
export interface CardStore {
  readonly slug: string;
  readonly name: string;
}

export interface CatalogCard {
  readonly venue: CatalogVenue;
  readonly store?: CardStore;
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

/** One Vitrinee store's live rows (T104), read through the same feed as the bazaar. */
export interface StoreRows {
  readonly slug: string;
  readonly name: string;
  readonly venueId: string;
  /** `undefined` when the read failed. Empty is a different fact. */
  readonly rows: readonly CheckedResource[] | undefined;
}

export interface BuildCatalogInput {
  readonly targets: PilotTargets;
  readonly agents: readonly AgentConfig[];
  /** The bazaar's live rows, or `undefined` when the read failed. Empty is a different fact. */
  readonly bazaar: readonly CheckedResource[] | undefined;
  /** Every Vitrinee store the directory names, each with its own rows (T104, `C-141`). */
  readonly stores: readonly StoreRows[];
}

/**
 * A store shopper covers the products of the one store it was hired for, so
 * coverage is counted among that store's shoppers only (T104).
 */
function storeCoverage(agents: readonly AgentConfig[], slug: string): Coverage {
  return coverageOf(
    agents.filter((agent) => agent.comercio === slug),
    "vitrinee_shopper",
  );
}

/** A Vitrinee store's cards: every product it lists is one its own shopper's grant would name. */
function storeCards(store: StoreRows, agents: readonly AgentConfig[]): readonly CatalogCard[] {
  return (store.rows ?? []).map((resource) => ({
    venue: "vitrinee" as const,
    store: { slug: store.slug, name: store.name },
    productId: resource.id,
    kind: "vitrinee_shopper" as const,
    venueId: store.venueId,
    title: bilingual(resource.name, resource.name),
    description: bilingual(resource.description, resource.description),
    declaredAmount: resource.declaredAmount,
    declaredAsset: resource.declaredAsset,
    inputs: resource.inputs,
    serverFilled: [],
    availability: resource.availability,
    coverage: storeCoverage(agents, store.slug),
  }));
}

/**
 * The cards of a merchant whose catalogue is read live.
 *
 * A row naming a product no grant could ever cover is dropped rather than
 * drawn as permanently forbidden. Offering to sign a permission for a product
 * that is not in any `PilotTarget` would be offering a grant RealOps cannot
 * build, and a button that cannot work is worse than an absence.
 */
function liveCards(
  venue: CatalogVenue,
  venueId: string,
  rows: readonly CheckedResource[] | undefined,
  input: BuildCatalogInput,
): readonly CatalogCard[] {
  return (rows ?? []).flatMap((resource) => {
    const kind = kindFor(input.targets, venueId, resource.id);
    if (kind === undefined) return [];
    return [
      {
        venue,
        productId: resource.id,
        kind,
        venueId,
        // The merchant's own words, in whatever language it wrote them. Shown
        // identically in both, because inventing a translation of a third
        // party's product description would be putting words in its mouth.
        title: bilingual(resource.name, resource.name),
        description: bilingual(resource.description, resource.description),
        declaredAmount: resource.declaredAmount,
        declaredAsset: resource.declaredAsset,
        inputs: resource.inputs,
        // A live merchant's resources ask for nothing RealOps owns: every
        // parameter is the person's to choose, which is why they need a form.
        serverFilled: [],
        availability: resource.availability,
        coverage: coverageOf(input.agents, kind),
      },
    ];
  });
}

/** The whole shop, in the order it is drawn: SignalDesk first, then the bazaar, then the Vitrinee store. */
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

  const bazaar = liveCards("bazaar", input.targets.bazaar_shopper.venueId, input.bazaar, input);
  const fixed = [...signaldesk, ...bazaar];

  // A product id is what a buy form, a typed sentence and a prefill link carry.
  // Two cards with the same one would make every one of those ambiguous, so a
  // store's card whose id another card already uses is not drawn at all.
  const stores = input.stores.flatMap((store) => storeCards(store, input.agents));
  const count = new Map<string, number>();
  for (const card of [...fixed, ...stores]) count.set(card.productId, (count.get(card.productId) ?? 0) + 1);
  return [...fixed, ...stores.filter((card) => count.get(card.productId) === 1)];
}

/** The grant target a store's shopper signs for: that store, its payout account, and the products it lists now. */
export function storeTarget(base: PilotTargets, store: { readonly venueId: string; readonly payTo: string }, productIds: readonly string[]): PilotTargets {
  return {
    ...base,
    vitrinee_shopper: { venueId: store.venueId, assetId: base.vitrinee_shopper.assetId, payTo: [store.payTo], products: [...productIds] },
  };
}

/** The one card a product id names, among the ones this account can see. */
export function findCard(cards: readonly CatalogCard[], productId: string): CatalogCard | undefined {
  return cards.find((card) => card.productId === productId);
}
