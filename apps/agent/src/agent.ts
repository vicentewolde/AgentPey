/**
 * Starting the agent.
 *
 * Two things happen here that decide everything else: the agent's own
 * credential is verified, and — as of T21 — so is the principal's own
 * consent for it, the Mandate. The tool set is shaped by both outcomes
 * together. There is no separate "am I allowed?" check inside the tools to
 * forget, get wrong, or talk out of — the capability either exists or it
 * does not, and it takes both documents to exist.
 */
import { AgentPassError, didToStellarAddress } from "@agentpass/core";
import type { Keypair } from "@stellar/stellar-sdk/base";

import type { CatalogAdapter } from "./catalog/catalog.js";
import type { CredentialState, CredentialVerifier } from "./credential/verifier.js";
import { checkOwnCredential } from "./credential/verifier.js";
import type { MandateSource, MandateState, MandateVerifier } from "./mandate/verifier.js";
import { checkOwnMandate } from "./mandate/verifier.js";
import { createInMemorySpendLedger, type SpendLedger } from "./ledger/spend-ledger.js";
import type { PolicyRail } from "./policy/policy-rail.js";
import {
  createAgentTools,
  createPurchasePreviewer,
  type PaymentDeps,
  type PurchasePreviewer,
} from "./tools/agent-tools.js";
import type { ToolSet } from "./tools/tool.js";

export interface AgentConfig {
  /** The agent's own AgentPass credential, as a compact JWS. */
  readonly credential: string;
  readonly catalog: CatalogAdapter;
  /**
   * Verifies the credential against the registry. `AgentPass` from
   * `@agentpass/sdk` satisfies this; the narrow port is what keeps the agent
   * from being able to issue or revoke anything.
   */
  readonly verifier: CredentialVerifier;
  /**
   * The principal's signed consent for this agent — a compact JWS (a
   * platform-held key signed it), or a `{ mandate, signature }` pair (a
   * connected wallet signed it, T35). Optional at the level of
   * *configuration* — an agent can exist, and read the catalogue, before any
   * principal has consented to anything — but its absence means
   * `create_purchase_intent` is withheld exactly as it would be for a missing
   * signer (T21). If supplied, {@link mandateVerifier} must be supplied too.
   */
  readonly mandate?: MandateSource;
  /** Verifies the mandate against the registry. Required alongside `mandate`. */
  readonly mandateVerifier?: MandateVerifier;
  /**
   * The agent's own Stellar key — the one its credential names as the subject.
   * Without it nothing can be signed, so `create_purchase_intent` is withheld
   * rather than advertised and then failing.
   */
  readonly signer?: Keypair;
  /** How long a signed intent stays valid. Defaults to 15 minutes. */
  readonly intentTtlSeconds?: number;
  /** Injectable clock, for the validity window and for `PolicyRail`'s `perDay`. */
  readonly now?: Date;
  /**
   * The agent's daily-spend memory. Defaults to a fresh in-memory ledger, one
   * per agent instance — override to share one across agents in a test, or
   * later to plug in something durable.
   */
  readonly ledger?: SpendLedger;
  /**
   * The venue's own base URL, when this agent should be able to pay for
   * real, not just sign. Enables `execute_payment` (G-4) alongside
   * everything `create_purchase_intent` already needs — absent, the tool
   * stays out of the tool set exactly as it does for the mock catalogue.
   */
  readonly payment?: PaymentDeps;
  /**
   * Overrides the `LocalPolicyRail` this agent would otherwise build from
   * `ledger`. Absent, behaviour is unchanged — pass one (e.g. wrapped with
   * `withVault`, T27) to also keep every refusal, not just every grant.
   */
  readonly policyRail?: PolicyRail;
}

export interface Agent {
  /** Exactly what this agent can do, given what its credential and mandate turned out to be. */
  readonly tools: ToolSet;
  /** The startup check's outcome, kept so callers can report it without re-running it. */
  readonly credential: CredentialState;
  /** The startup check's outcome for the principal's consent, T21. */
  readonly mandate: MandateState | undefined;
  /**
   * Asks what a purchase would do, reserving nothing and signing nothing
   * (T93). `undefined` for exactly the agents that have no
   * `create_purchase_intent` either — an agent that cannot buy does not get
   * to answer questions about what it would be allowed to buy.
   */
  readonly preview: PurchasePreviewer | undefined;
}

/**
 * Verifies the credential, then builds the tool set that outcome allows.
 *
 * A failed check does **not** stop the agent from starting. It starts able to
 * read the catalogue and to say why it cannot buy — which is the behaviour the
 * phase's demo needs after a revocation, and a good deal more useful than a
 * process that dies with a stack trace.
 *
 * @throws AgentPassError `ConfigError` when the configuration itself is unusable.
 */
export async function createAgent(config: AgentConfig): Promise<Agent> {
  if (config === null || typeof config !== "object") {
    throw new AgentPassError("ConfigError", "createAgent needs a configuration object", {
      details: { received: typeof config },
    });
  }
  if (typeof config.credential !== "string" || config.credential.length === 0) {
    throw new AgentPassError("ConfigError", "the agent needs its credential as a compact JWS", {
      details: { received: typeof config.credential },
    });
  }
  if (typeof config.verifier?.verify !== "function") {
    throw new AgentPassError("ConfigError", "the agent needs a credential verifier", {});
  }
  if (typeof config.catalog?.listProducts !== "function") {
    throw new AgentPassError("ConfigError", "the agent needs a catalogue adapter", {});
  }
  if (config.mandate !== undefined && typeof config.mandateVerifier?.verify !== "function") {
    throw new AgentPassError("ConfigError", "a mandate was supplied without a mandateVerifier to check it", {});
  }

  const credential = await checkOwnCredential(config.verifier, config.credential, {
    now: config.now,
  });

  // A key that is not the credential's subject would sign intents that can
  // never verify against it. That is a misconfiguration, not a policy state, so
  // it is loud and immediate rather than a quietly withheld capability.
  if (config.signer !== undefined && credential.usable) {
    const subject = credential.verified.credential.credentialSubject.id;
    if (didToStellarAddress(subject) !== config.signer.publicKey()) {
      throw new AgentPassError(
        "SignerMismatch",
        "the signing key is not the subject of the agent's own credential",
        { details: { subject, signer: config.signer.publicKey() } },
      );
    }
  }

  const mandate =
    config.mandate === undefined
      ? undefined
      : await checkOwnMandate(config.mandateVerifier!, config.mandate, { now: config.now });

  // A mandate that empowers some other agent is a misconfiguration, not a
  // policy state to withhold quietly — the same reasoning as the signer check
  // above, and `checkMandate`'s own T17 code reused verbatim (M-4's identity
  // check applies here just as much as it does when comparing against an
  // intent).
  if (mandate?.usable && credential.usable) {
    const subject = credential.verified.credential.credentialSubject.id;
    if (mandate.verified.agent !== subject) {
      throw new AgentPassError(
        "MandateAgentMismatch",
        "this mandate does not empower the agent this credential names",
        { details: { mandateAgent: mandate.verified.agent, credentialSubject: subject } },
      );
    }
  }

  const ledger = config.ledger ?? createInMemorySpendLedger();

  const toolDeps = {
    catalog: config.catalog,
    credential,
    mandate,
    mandateVerifier: config.mandateVerifier,
    signer: config.signer,
    verifier: config.verifier,
    intentTtlSeconds: config.intentTtlSeconds,
    now: config.now,
    ledger,
    payment: config.payment,
    policyRail: config.policyRail,
  };

  return {
    credential,
    mandate,
    preview: createPurchasePreviewer(toolDeps),
    // The same deps the previewer got: one description of what this agent is
    // allowed to do, not two that could disagree.
    tools: createAgentTools(toolDeps),
  };
}
