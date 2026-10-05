import { USDC_TESTNET, fromAtomic, pay, policyRailPayer, quote, railOwnerSigner } from "@agentpey/ucp-stellar";

const storeUrl = "https://agentcommerce.vitrinee.agentpey.com";
const buyer = { email: "buyer@example.com", first_name: "Ada", last_name: "Lovelace" };
const destination = { first_name: "Ada", last_name: "Lovelace", street_address: "Av. Providencia 1234", address_locality: "Providencia", address_country: "CL" };

// 1. Open a checkout and check it against the store's public profile. Nothing is signed.
const q = await quote({ storeUrl, productId: "67624104591666", quantity: 1, buyer, destination });
console.log(`checkout ${q.checkoutId}: ${fromAtomic(BigInt(q.requirements.amount), q.asset.decimals)} ${q.asset.code} to ${q.requirements.payTo}`);
if (process.env.PAY !== "yes") process.exit(0);

// 2. Pay from a policy_rail. The owner's key signs; the network enforces the rail's limits.
const payer = policyRailPayer({ contractId: process.env.RAIL_CONTRACT_ID, signAuthPayload: railOwnerSigner(process.env.RAIL_OWNER_SECRET) });
const receipt = await pay(q, { payer, maxAmount: "2.00", asset: USDC_TESTNET });
console.log(`order ${receipt.orderId}, tx https://stellar.expert/explorer/testnet/tx/${receipt.transaction}`);
