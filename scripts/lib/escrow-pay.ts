/**
 * One x402 payment from a `policy_rail` into a `purchase-escrow`, settled by
 * the facilitator the way a checkout's is (`X-14`). Used by the escrow scripts
 * that prove the contract on testnet (T157, T159). Moves real testnet USDC.
 */
import { AgentPassError } from "@agentpass/core";
import type { Keypair } from "@stellar/stellar-sdk";
import { x402Client } from "@x402/core/client";
import type { HTTPFacilitatorClient } from "@x402/core/server";
import { z } from "zod";

import { policyRailPayer, railOwnerSigner } from "../../packages/ucp-stellar/src/index.js";

const NETWORK = "stellar:testnet";

export interface EscrowPayment {
  readonly facilitator: HTTPFacilitatorClient;
  /** The paying `policy_rail` and the key that owns it. */
  readonly rail: string;
  readonly railOwner: Keypair;
  readonly token: string;
  readonly escrow: string;
  readonly amountAtomic: bigint;
  /** Names the payment in the x402 resource URL. */
  readonly label: string;
}

/** Returns the settled transaction's hash. */
export async function payIntoEscrow(p: EscrowPayment): Promise<string> {
  const supported = await p.facilitator.getSupported();
  const kind = supported.kinds.find((k) => k.x402Version === 2 && k.scheme === "exact" && k.network === NETWORK);
  if (kind === undefined) throw new AgentPassError("NetworkError", "the facilitator offers no exact scheme on stellar:testnet", { details: { kinds: supported.kinds } });
  const requirements = {
    scheme: "exact",
    network: NETWORK,
    amount: p.amountAtomic.toString(),
    asset: p.token,
    payTo: p.escrow,
    maxTimeoutSeconds: 120,
    extra: { ...(kind.extra ?? {}), paymentFlow: "upfront" },
  } as const;
  const client = new x402Client().register(NETWORK, policyRailPayer({ contractId: p.rail, signAuthPayload: railOwnerSigner(p.railOwner.secret()) }));
  const payload = await client.createPaymentPayload({
    x402Version: 2,
    resource: { url: `https://agentpey.com/escrow-rehearsal/${p.label}`, description: "purchase-escrow rehearsal", mimeType: "application/json" },
    accepts: [requirements],
  });
  const verified = await p.facilitator.verify(payload, requirements);
  if (!verified.isValid) throw new AgentPassError("CommandFailed", "the facilitator refused the payment", { details: { verified } });
  const settled = await p.facilitator.settle(payload, requirements);
  if (!settled.success) throw new AgentPassError("CommandFailed", "the facilitator did not settle the payment", { details: { settled } });
  return z.string().regex(/^[0-9a-f]{64}$/).parse(settled.transaction);
}
