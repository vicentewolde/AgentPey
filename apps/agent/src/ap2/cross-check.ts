/**
 * The cross-check variant of the AP2 export — T123, `E-9`.
 *
 * Identical to `exportMandateAsAp2` except that `cnf` is bound to a key the
 * caller supplies: a single-use P-256 key, the only `cnf` type the AP2
 * reference SDK follows when an agent closes a mandate. Used by
 * `scripts/ap2-export.ts --ephemeral-p256` and by tests, never by the agent,
 * and deliberately **not** exported from the package index: in production
 * the pair is bound to the intent's own `did:stellar` key and to nothing else.
 *
 * Its issuer must not claim to be the Stellar issuer either: a pair signed
 * with an ephemeral key carries an `iss` that says so.
 */
import { AgentPassError } from "@agentpass/core";
import type { Ap2PublicJwk } from "@agentpey/ap2";

import { exportPair } from "./export.js";
import type { Ap2ExportVerifiers, ExportMandateAsAp2Input, ExportedAp2Mandates } from "./export.js";

/** `iss` prefix of every cross-check pair. */
export const AP2_CROSS_CHECK_ISSUER_PREFIX = "urn:agentpey:ap2-cross-check:";

export async function exportMandateAsAp2ForCrossCheck(
  verifiers: Ap2ExportVerifiers,
  input: ExportMandateAsAp2Input,
  agentKey: Ap2PublicJwk,
): Promise<ExportedAp2Mandates> {
  if (!input.issuer.did.startsWith(AP2_CROSS_CHECK_ISSUER_PREFIX)) {
    throw new AgentPassError("InvalidArguments", `a cross-check pair's iss must start with ${AP2_CROSS_CHECK_ISSUER_PREFIX}`, {
      details: { iss: input.issuer.did },
    });
  }
  return exportPair(verifiers, input, agentKey);
}
