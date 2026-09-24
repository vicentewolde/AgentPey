/**
 * The two things onboarding asks of Stellar testnet (T105, VT-27, VT-29):
 * whether a payout account can receive testnet USDC, and funding a fresh
 * signing key with XLM from friendbot so it can pay for its own anchors.
 *
 * Plain `fetch` against Horizon and friendbot, injectable, so tests never
 * touch the network. Testnet only: there is no switch, and there must not be
 * one (Ley 21.521, CONTEXTO of Vitrinee).
 */
import { USDC_TESTNET, VitrineeError } from "@vitrinee/core";

export type PayoutReadiness = "ready" | "account_missing" | "usdc_trustline_missing";

export interface StellarNetwork {
  /** Whether `account` exists and holds a trustline to Circle's testnet USDC. */
  payoutReadiness(account: string): Promise<PayoutReadiness>;
  /** Creates `account` with friendbot's XLM and resolves once Horizon shows it. */
  fund(account: string): Promise<void>;
}

export interface TestnetOptions {
  horizonUrl?: string;
  friendbotUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** How long to wait for Horizon to show a funded account, per attempt. */
  pollDelaysMs?: readonly number[];
}

interface HorizonBalance {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function testnet(options: TestnetOptions = {}): StellarNetwork {
  const horizon = (options.horizonUrl ?? "https://horizon-testnet.stellar.org").replace(/\/+$/, "");
  const friendbot = options.friendbotUrl ?? "https://friendbot.stellar.org";
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const pollDelays = options.pollDelaysMs ?? [500, 1_000, 2_000, 3_000];

  async function loadBalances(account: string): Promise<HorizonBalance[] | undefined> {
    let response: Response;
    try {
      response = await fetchImpl(`${horizon}/accounts/${encodeURIComponent(account)}`);
    } catch (error) {
      throw new VitrineeError("NetworkError", "could not reach Stellar Horizon", { cause: error });
    }
    if (response.status === 404) return undefined;
    if (!response.ok) throw new VitrineeError("NetworkError", `Stellar Horizon responded ${response.status}`);
    const body = (await response.json()) as { balances?: HorizonBalance[] };
    return Array.isArray(body.balances) ? body.balances : [];
  }

  return {
    async payoutReadiness(account) {
      const balances = await loadBalances(account);
      if (balances === undefined) return "account_missing";
      const trusts = balances.some(
        (b) => (b.asset_type === "credit_alphanum4" || b.asset_type === "credit_alphanum12") && b.asset_code === USDC_TESTNET.code && b.asset_issuer === USDC_TESTNET.issuer,
      );
      return trusts ? "ready" : "usdc_trustline_missing";
    },

    async fund(account) {
      let response: Response;
      try {
        response = await fetchImpl(`${friendbot}?addr=${encodeURIComponent(account)}`);
      } catch (error) {
        throw new VitrineeError("SigningKeyNotFunded", "could not reach the testnet faucet (friendbot)", { cause: error });
      }
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        // A race with an earlier attempt on the same fresh key; harmless.
        if (!body.includes("createAccountAlreadyExist")) {
          throw new VitrineeError("SigningKeyNotFunded", `the testnet faucet (friendbot) refused to fund the signing key: HTTP ${response.status}`, {
            details: { status: response.status },
          });
        }
      }
      for (const delay of [0, ...pollDelays]) {
        if (delay > 0) await sleep(delay);
        if ((await loadBalances(account).catch(() => undefined)) !== undefined) return;
      }
      throw new VitrineeError("SigningKeyNotFunded", "the faucet accepted the signing key but Horizon never showed the account");
    },
  };
}
