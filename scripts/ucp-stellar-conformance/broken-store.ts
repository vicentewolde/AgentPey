/**
 * A UCP store that declares `com.agentpey.stellar_x402` and breaks it on
 * purpose (T137), to show the conformance kit failing with a clear reason.
 * Each break is one way a store can get the handler wrong; with none it is a
 * small store that follows the spec. It never moves money: there is no
 * facilitator. A "settlement" here is only counted, once per transaction, so
 * a test can tell what a real store would have charged.
 *
 *   pnpm run ucp:stellar:broken-store [-- --break spec-off-domain,pay-to-mismatch] [--port 4137]
 *
 * With no `--break`, every break is on.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { parseArgs } from "node:util";

import { Keypair } from "@stellar/stellar-sdk";

export const BREAKS = [
  /** The handler's spec and schema are not on agentpey.com: UCP's namespace binding fails. */
  "spec-off-domain",
  /** The asset declares 6 decimals instead of Stellar's 7. */
  "decimals",
  /** The checkout asks to pay another account than the profile declares. */
  "pay-to-mismatch",
  /** The checkout's handler config has no `binding.checkout_id`. */
  "no-binding",
  /** Complete Checkout accepts a credential whose `accepted` differs from the checkout's requirements. */
  "accepts-tampered",
  /**
   * It refuses a junk transaction, but settles a really signed one whose `accepted` was altered, and still answers
   * `payment_failed`: the lie only a balance shows.
   */
  "settles-signed",
] as const;
export type Break = (typeof BREAKS)[number];

const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const AMOUNT = "15684211";

export interface BrokenStore {
  readonly url: string;
  readonly payTo: string;
  /** How many checkouts this store completed. */
  completed(): number;
  /** How many transactions it "settled", each once. */
  settled(): number;
  close(): Promise<void>;
}

export async function startBrokenStore(options: { readonly breaks: ReadonlySet<Break>; readonly port?: number; readonly payTo?: string }): Promise<BrokenStore> {
  const breaks = options.breaks;
  const payTo = options.payTo ?? Keypair.random().publicKey();
  const otherPayTo = Keypair.random().publicKey();
  const sessions = new Map<string, { status: string; order?: { id: string; permalink_url: string } }>();
  let completed = 0;
  const settledTransactions = new Set<string>();
  let url = "";
  /** The kit's junk transaction (R6), which no store could settle. */
  const isJunk = (transaction: string | undefined) => transaction === undefined || Buffer.from(transaction, "base64").toString("utf8").startsWith("ucp-stellar-conformance");

  const spec = breaks.has("spec-off-domain") ? "https://agentpey.example/ucp/handlers/stellar-x402/spec" : "https://agentpey.com/ucp/handlers/stellar-x402/spec";
  const schema = breaks.has("spec-off-domain") ? "https://agentpey.example/ucp/handlers/stellar-x402/schema.json" : "https://agentpey.com/ucp/handlers/stellar-x402/schema.json";
  const businessConfig = () => ({
    x402_version: 2,
    scheme: "exact",
    network: "stellar:testnet",
    asset: { code: "USDC", contract: USDC, decimals: breaks.has("decimals") ? 6 : 7 },
    pay_to: payTo,
    facilitator: "https://channels.openzeppelin.com/x402/testnet",
  });
  const requirements = () => ({ scheme: "exact", network: "stellar:testnet", asset: USDC, amount: AMOUNT, payTo: breaks.has("pay-to-mismatch") ? otherPayTo : payTo, maxTimeoutSeconds: 300, extra: { areFeesSponsored: true } });

  const checkout = (id: string) => {
    const session = sessions.get(id)!;
    return {
      ucp: {
        version: "2026-04-08",
        payment_handlers: {
          "com.agentpey.stellar_x402": [
            {
              id: "stellar_x402",
              version: "2026-09-30",
              config: {
                ...businessConfig(),
                payment_requirements: requirements(),
                fx: { base: "USD", quote: "USDC", rate: "1" },
                ...(breaks.has("no-binding") ? {} : { binding: { checkout_id: id } }),
              },
            },
          ],
        },
      },
      id,
      status: session.status,
      currency: "USD",
      line_items: [{ id: "li_1", item: { id: "iman-roto", title: "Imán roto", price: 157 }, quantity: 1 }],
      totals: [{ type: "total", amount: 157 }],
      ...(session.order === undefined ? {} : { order: session.order }),
    };
  };

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const read = async (req: IncomingMessage): Promise<unknown> => {
    let text = "";
    for await (const chunk of req) text += String(chunk);
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };

  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://store").pathname;
      if (req.method === "GET" && path === "/.well-known/ucp") {
        return send(res, 200, {
          ucp: {
            version: "2026-04-08",
            services: { "dev.ucp.shopping": [{ version: "2026-04-08", transport: "rest", endpoint: `${url}/ucp/v1` }] },
            capabilities: { "dev.ucp.shopping.checkout": [{ version: "2026-04-08" }] },
            payment_handlers: { "com.agentpey.stellar_x402": [{ id: "stellar_x402", version: "2026-09-30", spec, schema, available_instruments: [{ type: "stellar_x402" }], config: businessConfig() }] },
          },
        });
      }
      if (req.method === "POST" && path === "/ucp/v1/catalog/search") return send(res, 200, { products: [{ id: "iman-roto", title: "Imán roto" }] });
      if (req.method === "POST" && path === "/ucp/v1/checkout-sessions") {
        const id = `chk_broken_${sessions.size + 1}`;
        sessions.set(id, { status: "ready_for_complete" });
        return send(res, 201, checkout(id));
      }
      const match = /^\/ucp\/v1\/checkout-sessions\/([^/]+)(\/complete)?$/.exec(path);
      const id = match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
      if (id !== undefined && sessions.has(id)) {
        if (req.method === "GET" && match?.[2] === undefined) return send(res, 200, checkout(id));
        if (req.method === "POST" && match?.[2] === "/complete") {
          const body = (await read(req)) as { payment?: { instruments?: Array<{ credential?: { accepted?: Record<string, unknown>; payload?: { transaction?: string } } }> } } | undefined;
          const credential = body?.payment?.instruments?.[0]?.credential;
          const accepted = credential?.accepted;
          const transaction = credential?.payload?.transaction;
          const asked = requirements();
          const matches = accepted !== undefined && (["scheme", "network", "asset", "amount", "payTo"] as const).every((k) => accepted[k] === asked[k]);
          const session = sessions.get(id)!;
          if (session.order !== undefined) return send(res, 200, checkout(id));
          const refuse = (content: string) => send(res, 200, { ...checkout(id), messages: [{ type: "error", code: "payment_failed", content, severity: "recoverable" }] });
          if (!matches && breaks.has("settles-signed") && !isJunk(transaction)) {
            settledTransactions.add(transaction!);
            return refuse("the credential was signed for other payment requirements than this checkout's");
          }
          if (!matches && !breaks.has("accepts-tampered")) return refuse("the credential was signed for other payment requirements than this checkout's");
          if (!isJunk(transaction)) {
            if (settledTransactions.has(transaction!)) return refuse("the payment did not settle: this authorization was already used");
            settledTransactions.add(transaction!);
          }
          completed += 1;
          session.status = "completed";
          session.order = { id: `ord_broken_${completed}`, permalink_url: `${url}/orders/ord_broken_${completed}` };
          return send(res, 200, checkout(id));
        }
      }
      return send(res, 404, { messages: [{ type: "error", code: "not_found", content: `${req.method} ${path}` }] });
    })();
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  url = `http://localhost:${(server.address() as AddressInfo).port}`;
  return {
    url,
    payTo,
    completed: () => completed,
    settled: () => settledTransactions.size,
    close: () => new Promise((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error)))),
  };
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const { values } = parseArgs({ args: argv[0] === "--" ? argv.slice(1) : argv, options: { break: { type: "string" }, port: { type: "string", default: "4137" } } });
  const asked = values.break === undefined ? [...BREAKS] : values.break.split(",").map((b) => b.trim());
  const unknown = asked.filter((b) => !(BREAKS as readonly string[]).includes(b));
  if (unknown.length > 0) {
    process.stderr.write(`unknown break: ${unknown.join(", ")}; one of ${BREAKS.join(", ")}\n`);
    process.exit(2);
  }
  const store = await startBrokenStore({ breaks: new Set(asked as Break[]), port: Number(values.port) });
  process.stdout.write(`broken store at ${store.url} (breaks: ${asked.join(", ") || "none"})\nrun: pnpm run ucp:stellar:conformance -- ${store.url}\n`);
}
