/**
 * How the MCP's agent signs the intent for a quote (T150): one line through
 * the model's own `create_purchase_intent`, as since T128; two or more through
 * the agent's cart signer (T148), which makes every check that tool makes.
 *
 * Split out of `runtime.ts` so the branch is tested without a network.
 */
import { AgentPassError } from "@agentpass/core";
import type { Agent, UcpLine } from "@agentpey/agent";

export type LineSigner = Pick<Agent, "tools" | "signCart" | "credential" | "mandate">;

/**
 * What the agent answered when asked to sign these lines: still to be checked
 * as a signed intent by the caller.
 *
 * @throws AgentPassError the credential's or the Mandate's own problem when
 * either is unusable (a revocation reads as a revocation), and
 * `InvalidArguments` for no lines.
 */
export async function signLines(agent: LineSigner, lines: readonly UcpLine[]): Promise<unknown> {
  const [single] = lines;
  if (single === undefined) throw new AgentPassError("InvalidArguments", "a quote needs at least one line", { details: {} });
  if (lines.length === 1) {
    return agent.tools.invoke("create_purchase_intent", { product_id: single.productId, quantity: single.quantity });
  }
  if (agent.signCart === undefined) {
    // Withheld exactly as the tool is: say why, so a chat can tell a revocation from an outage.
    if (!agent.credential.usable) throw agent.credential.problem;
    if (agent.mandate !== undefined && !agent.mandate.usable) throw agent.mandate.problem;
    throw new AgentPassError("InvalidIntent", "this agent cannot sign a cart", { details: {} });
  }
  return agent.signCart(lines);
}
