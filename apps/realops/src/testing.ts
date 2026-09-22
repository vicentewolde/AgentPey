/**
 * Fixtures the tests share.
 *
 * `TEST_TARGETS` used to be copied into four test files. Once a target became
 * one row per agent kind (T96) that copy was four places to forget, so it lives
 * here once: a test that adds a kind fails to compile everywhere at the same
 * time, which is the point.
 *
 * The values are the pilot's real ones, because a fixture that disagrees with
 * production tests a system nobody runs.
 */
import type { PilotTargets } from "./permissions.js";

export const SIGNALDESK_VENUE_ID = "signaldesk:GB4D4PLLFEIKZK6MDW42MZRQ5XMPC6QRJN4FFRODO6D3PRB3MDGGYOOF";
export const SIGNALDESK_PAY_TO = "GB4D4PLLFEIKZK6MDW42MZRQ5XMPC6QRJN4FFRODO6D3PRB3MDGGYOOF";
export const BAZAAR_VENUE_ID = "stellar-bazaar:CBDWMXZEE44NJ3RA6RS7K4EK36KDFW5S7KHP276HCMM4I52MIUUHEF5B";
/** Verified against the bazaar's own live 402, not copied from `venues.json` (T96). */
export const PILOT_ASSET_ID = "USDC:CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

export const TEST_TARGETS: PilotTargets = {
  market_brief: {
    venueId: SIGNALDESK_VENUE_ID,
    assetId: PILOT_ASSET_ID,
    payTo: [SIGNALDESK_PAY_TO],
    products: ["signaldesk:market-brief-xlm-usdc"],
  },
  ai_credits: {
    venueId: SIGNALDESK_VENUE_ID,
    assetId: PILOT_ASSET_ID,
    payTo: [SIGNALDESK_PAY_TO],
    products: ["signaldesk:ai-credits-1000"],
  },
  bazaar_shopper: {
    venueId: BAZAAR_VENUE_ID,
    assetId: PILOT_ASSET_ID,
    payTo: [
      "GDVR2KDK5DSMNYZJKNISUIOBDC6FZK3XZOIQWSS7KL4BRMD5BMW6RMCQ",
      "GBYXQUSY7WA3DUXZSANGQ3HMER2EBMOK5IYPUJV4YY2UH7QS736J62LB",
    ],
    products: ["swap-risk-quote", "ai-video-scriptwriter"],
  },
};
