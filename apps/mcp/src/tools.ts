/**
 * The six MCP tools (T128), each a thin face over `Shopper`. Inputs and
 * outputs are zod schemas the SDK publishes to the client and checks.
 *
 * `quote`, `pay` and `open_claim` are not read-only (R-10), so Claude and
 * ChatGPT can ask the person before calling them. `pay` asks for
 * `confirm: true` on top of that: a model that skips the question still
 * cannot pay.
 *
 * A failure comes back as a tool error with its typed code and its message,
 * never its details or a stack: an error's details can carry what a store
 * answered, and nothing a store wrote is repeated to the model unchecked.
 */
import { isAgentPassError } from "@agentpass/core";
import { CLAIM_REASONS } from "@agentpey/resolve";
import { mayHaveBeenPaid } from "@agentpey/agent";
import { McpServer } from "@modelcontextprotocol/server";
import { isVitrineeError } from "@vitrinee/core";
import { z } from "zod";

import { claimInputSchema, quoteInputSchema, type Shopper } from "./shopper.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

const money = z.object({ amount: z.number().int().nullable(), currency: z.string().nullable() });
const productHit = z.object({
  store: z.string(),
  product_id: z.string(),
  title: z.string(),
  description: z.string(),
  price: z.object({ amount: z.number().int(), currency: z.string() }),
  available: z.boolean(),
});
const check = z.object({ ok: z.boolean(), reason: z.string().nullable() });

export const outputSchemas = {
  search_products: z.object({ products: z.array(productHit), unavailable_stores: z.array(z.string()) }),
  get_product: productHit,
  quote: z.object({
    quote_id: z.string(),
    store: z.string(),
    /** The product and its quantity when the quote is for one; null for a cart, whose lines are in `items`. */
    product_id: z.string().nullable(),
    quantity: z.number().int().nullable(),
    items: z.array(z.object({ product_id: z.string(), quantity: z.number().int() })),
    total: z.object({ amount: z.number(), currency: z.string() }),
    pays: z.object({ amount_usdc: z.string(), to: z.string(), network: z.string(), asset: z.string(), from: z.string().nullable() }),
    expires_at: z.string(),
  }),
  pay: z.object({
    order_id: z.string(),
    checkout_id: z.string(),
    store: z.string(),
    total: z.object({ amount: z.number(), currency: z.string() }),
    paid_usdc: z.string(),
    paid_to: z.string(),
    transaction: z.string().nullable(),
    explorer_url: z.string().nullable(),
    receipt: z.object({ hash: z.string(), verify_url: z.string(), anchor: z.string() }).nullable(),
  }),
  get_order: z.object({
    order_id: z.string(),
    store: z.string(),
    checkout_id: z.string().nullable(),
    total: money,
    items: z.array(z.object({ id: z.string().nullable(), title: z.string().nullable(), quantity: z.unknown() })),
    dispute: z.string().nullable(),
    receipt: z
      .object({
        hash: z.string(),
        verify_url: z.string().nullable(),
        settlement_tx_hash: z.string().nullable(),
        explorer_url: z.string().nullable(),
        anchor: z.string().nullable(),
        valid: z.boolean(),
        checks: z.object({ order: check, signature: check, anchored: check, settlement: check }),
      })
      .nullable(),
  }),
  open_claim: z.object({
    claim_id: z.string(),
    claim_hash: z.string(),
    receipt_hash: z.string(),
    amount_usdc: z.string(),
    claim_jws: z.string(),
    next_step: z.string(),
  }),
} as const;

/** The tool error a chat sees: typed code, message, and whether money may have moved. */
export function toolFailure(error: unknown, options: { paysMoney: boolean; log?: ((message: string, fields?: Record<string, unknown>) => void) | undefined }) {
  const typed = isAgentPassError(error) || isVitrineeError(error);
  const body = {
    error: typed ? error.code : "InternalError",
    message: typed ? error.message : "unexpected failure",
    // Only `pay` can move money; for it, unknown means "maybe" (C-113).
    payment_may_have_been_sent: options.paysMoney && mayHaveBeenPaid(error),
  };
  const log = options.log;
  log?.("tool failed", { code: body.error, ...(typed ? {} : { error: error instanceof Error ? error.message : String(error) }) });
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(body) }] };
}

function success<T extends Record<string, unknown>>(result: T) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
}

async function run<T extends Record<string, unknown>>(work: () => Promise<T>, log?: (message: string, fields?: Record<string, unknown>) => void, paysMoney = false) {
  try {
    return success(await work());
  } catch (error) {
    return toolFailure(error, { paysMoney, log });
  }
}

/** A fresh server with the six tools; the HTTP handler builds one per request. */
export function createAgentPeyMcpServer(shopper: Shopper, log?: (message: string, fields?: Record<string, unknown>) => void): McpServer {
  const server = new McpServer({ name: "agentpey", title: "AgentPey", version: "0.1.0" });

  server.registerTool(
    "search_products",
    {
      title: "Search products",
      description:
        "Search the stores that sell through AgentPey (Vitrinee stores with a UCP catalog). Prices are in the store's currency, in minor units (CLP has none). Optionally limit to one store by its name.",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(200).describe("What to look for, e.g. 'imán'"),
        store: z.string().trim().min(1).max(200).optional().describe("A store's host or its first label, e.g. 'agentcommerce'"),
      }),
      outputSchema: outputSchemas.search_products,
      annotations: { title: "Search products", ...READ_ONLY },
    },
    async ({ query, store }) =>
      run(async () => {
        const found = await shopper.searchProducts({ query, store });
        return { products: found.products, unavailable_stores: found.unavailable };
      }, log),
  );

  server.registerTool(
    "get_product",
    {
      title: "Get a product",
      description: "One product of one store, by its id from search_products.",
      inputSchema: z.object({ store: z.string().trim().min(1).max(200), product_id: z.string().trim().min(1).max(200) }),
      outputSchema: outputSchemas.get_product,
      annotations: { title: "Get a product", ...READ_ONLY },
    },
    async (input) => run(async () => ({ ...(await shopper.getProduct(input)) }), log),
  );

  server.registerTool(
    "quote",
    {
      title: "Quote a purchase",
      description:
        "Open a checkout at the store and say exactly what paying would cost: the total in the store's currency, the USDC amount on Stellar testnet, who receives it, and until when the quote holds. Give either one product (product_id, quantity) or several from the same store in one checkout (items, up to 10 lines, each with its own quantity), never both; a cart is paid with one payment. The agent signs a purchase intent for it, but nothing is paid and no money moves. Needs the shipping address; ask the person for it. Show the quote to the person before calling pay.",
      inputSchema: quoteInputSchema,
      outputSchema: outputSchemas.quote,
      annotations: { title: "Quote a purchase", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => run(async () => shopper.quote(input), log),
  );

  server.registerTool(
    "pay",
    {
      title: "Pay a quote",
      description:
        "Pay a quote from AgentPey's spending account on Stellar testnet, whose limits the network enforces. Only after the person saw the quote and said yes: pass confirm: true. A quote pays once. Returns the order and its receipt.",
      inputSchema: z.object({
        quote_id: z.string().trim().min(1).max(100),
        // Optional on purpose: a call without it must reach `pay` and be refused with its typed code.
        confirm: z.boolean().optional().describe("true only if the person explicitly confirmed this quote"),
      }),
      outputSchema: outputSchemas.pay,
      annotations: { title: "Pay a quote", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => run(async () => shopper.pay(input), log, true),
  );

  server.registerTool(
    "get_order",
    {
      title: "Get an order and check its receipt",
      description:
        "Read an order from its store and verify its receipt independently of the store: that it is this order's receipt from this store, the merchant's signature, its anchor on Stellar, and the payment on Stellar.",
      inputSchema: z.object({ store: z.string().trim().min(1).max(200), order_id: z.string().trim().min(1).max(200) }),
      outputSchema: outputSchemas.get_order,
      annotations: { title: "Get an order", ...READ_ONLY },
    },
    async (input) => run(async () => shopper.getOrder(input), log),
  );

  server.registerTool(
    "open_claim",
    {
      title: "Sign a refund claim",
      description: `Sign a refund claim over an order's receipt, for AgentResolve. Reasons: ${CLAIM_REASONS.join(", ")}. It does not open the dispute: the arbiter does. Only when the person asks for it.`,
      inputSchema: claimInputSchema,
      outputSchema: outputSchemas.open_claim,
      annotations: { title: "Sign a refund claim", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => run(async () => shopper.openClaim(input), log),
  );

  return server;
}
