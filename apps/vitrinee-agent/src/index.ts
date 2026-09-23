/** The buyer as a library: what the CLI and the buyer console both drive. */
export { buy, type BuyOptions, type BuyResult } from "./buy.js";
export { directIntent, parseIntent, type PurchaseIntent, type ShippingDetails } from "./matcher.js";
export { reportVerification } from "./report.js";
export { tamperAmount } from "./tamper.js";
export { loadRepoEnv, registryId, repoRoot, LAST_RECEIPT_PATH } from "./env.js";
