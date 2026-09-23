/**
 * Check 3 of 3: the settlement transaction the receipt cites exists on
 * Stellar, succeeded, and moved exactly the receipt's USDC from the payer to
 * the merchant. Read from Horizon, which exposes per-transaction effects.
 */
import { USDC_TESTNET, parseDecimal, type ReceiptClaims } from "@vitrinee/core";

export interface SettlementCheck {
  ok: boolean;
  reason?: string;
  ledger?: number;
  closedAt?: string;
}

interface HorizonEffect {
  type: string;
  account?: string;
  /** Set on `contract_debited`/`contract_credited`: the smart account the USDC left or reached. */
  contract?: string;
  amount?: string;
  asset_code?: string;
  asset_issuer?: string;
}

const usdc = (e: HorizonEffect): boolean => e.asset_code === USDC_TESTNET.code && e.asset_issuer === USDC_TESTNET.issuer;

export async function checkSettlement(
  claims: Pick<ReceiptClaims, "settlementTxHash" | "payerAccount" | "merchantAccount" | "amountUSDCAtomic">,
  options: { horizonUrl: string; fetchImpl?: typeof fetch; attempts?: number },
): Promise<SettlementCheck> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.horizonUrl.replace(/\/+$/, "");
  const attempts = options.attempts ?? 1;

  let tx: { successful: boolean; ledger: number; created_at: string } | undefined;
  for (let attempt = 0; attempt < attempts && tx === undefined; attempt += 1) {
    const res = await fetchImpl(`${base}/transactions/${claims.settlementTxHash}`);
    if (res.status === 200) tx = (await res.json()) as typeof tx;
    else if (res.status !== 404) return { ok: false, reason: `Horizon answered ${res.status}` };
    else if (attempt + 1 < attempts) await new Promise((r) => setTimeout(r, 1_000));
  }
  if (tx === undefined) return { ok: false, reason: "settlement transaction not found on Stellar testnet" };
  if (!tx.successful) return { ok: false, reason: "settlement transaction failed on chain", ledger: tx.ledger };

  const res = await fetchImpl(`${base}/transactions/${claims.settlementTxHash}/effects?limit=50`);
  if (res.status !== 200) return { ok: false, reason: `Horizon effects answered ${res.status}` };
  const effects = ((await res.json()) as { _embedded: { records: HorizonEffect[] } })._embedded.records;

  const expected = BigInt(claims.amountUSDCAtomic);
  const amountMatches = (e: HorizonEffect): boolean => usdc(e) && e.amount !== undefined && parseDecimal(e.amount, 7) === expected;
  const moved = (type: string, account: string): boolean =>
    effects.some((e) => e.type === type && e.account === account && amountMatches(e));
  // A smart account payer (C..., e.g. AgentPey's policy_rail) is debited as
  // `contract_debited`, and that effect's `account` is the transaction's
  // source, the facilitator's channel. Matching on `account` there would
  // credit the payment to whoever submitted it (VT-22).
  const payerDebited = claims.payerAccount.startsWith("C")
    ? effects.some((e) => e.type === "contract_debited" && e.contract === claims.payerAccount && amountMatches(e))
    : moved("account_debited", claims.payerAccount);

  if (!payerDebited) {
    return { ok: false, reason: "the payer was not debited the receipt's USDC amount in that transaction", ledger: tx.ledger };
  }
  if (!moved("account_credited", claims.merchantAccount)) {
    return { ok: false, reason: "the merchant was not credited the receipt's USDC amount in that transaction", ledger: tx.ledger };
  }
  return { ok: true, ledger: tx.ledger, closedAt: tx.created_at };
}
