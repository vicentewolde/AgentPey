/**
 * Which URLs AgentPey is willing to send a webhook to — T94.
 *
 * Until this milestone, every outbound request this system made went to an
 * address *it* chose: a Stellar RPC, a venue in `venues.json`, a catalogue it
 * registered. Webhooks are the first time a **partner** picks the destination,
 * and that inverts the threat: a URL is no longer only a place to reach, it is
 * an instruction to this process to open a connection on someone else's
 * behalf. Pointed inward, that is server-side request forgery — and the
 * juiciest targets are exactly the ones a deployment can reach and the
 * internet cannot: the cloud metadata endpoint at `169.254.169.254`, the
 * sibling apps on `127.0.0.1` that `apps/gateway` starts (`C-114`), the
 * Postgres host on a private range.
 *
 * So the rule is an **allowlist of shape, and a denylist of destination**:
 * `https` only, no credentials, no non-standard port, and no address that
 * resolves into a range the public internet does not route to.
 *
 * **Checked twice, and the second time is the one that counts.** Registration
 * refuses what it can see in the string; delivery re-resolves the hostname and
 * checks the addresses it actually got. A check only at registration would be
 * defeated by a name that resolves to `1.2.3.4` today and `127.0.0.1` when the
 * event fires — the host is the partner's to repoint whenever they like.
 *
 * **What this does not close, said out loud.** Between the lookup here and the
 * connection `fetch` makes, the name can be resolved a second time and answer
 * differently — classic DNS rebinding. Closing that needs the request pinned
 * to the address that was checked, which Node's `fetch` does not expose. The
 * mitigation that *is* in place is that redirects are refused outright
 * (`redirect: "error"` at the delivery site), so the cheaper version of the
 * same attack — answer once from a public address, then `302` to
 * `169.254.169.254` — does not work.
 */
import { AgentPassError } from "@agentpass/core";
import { isIP } from "node:net";

/** Where a webhook may be sent, once every check has passed. */
export interface AllowedWebhookUrl {
  readonly url: string;
  readonly hostname: string;
}

function refuse(reason: string, details: Readonly<Record<string, unknown>>): AgentPassError {
  return new AgentPassError("WebhookUrlNotAllowed", reason, { details });
}

/**
 * Whether a dotted-quad IPv4 address is one the public internet does not
 * route to.
 *
 * Written out rather than pulled from a dependency because the list is short,
 * stable and load-bearing: a reader has to be able to audit it without
 * leaving the file.
 */
function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  const [a, b] = parts;
  if (a === undefined || b === undefined || parts.some((part) => !Number.isInteger(part))) return true;

  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC 1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local — the cloud metadata endpoint lives here
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return true; // RFC 6598, carrier-grade NAT
  if (a === 192 && b === 0) return true; // RFC 6890 special-purpose
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/** The IPv6 equivalent, including the v4-mapped forms that smuggle the ranges above. */
function isPrivateIpv6(address: string): boolean {
  const lower = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "::" || lower === "::1") return true; // unspecified, loopback
  if (lower.startsWith("fe80")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
  if (lower.startsWith("ff")) return true; // multicast

  // `::ffff:127.0.0.1` and `::ffff:7f00:1` are loopback wearing a v6 hat.
  const mapped = /^::ffff:(.+)$/.exec(lower);
  if (mapped?.[1] !== undefined) {
    const inner = mapped[1];
    if (isIP(inner) === 4) return isPrivateIpv4(inner);
    // The hex form: treat anything we cannot read as private, fail-closed.
    return true;
  }
  return false;
}

/** True when `address` is one the public internet does not route to. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  // Not an IP at all. Callers only ever pass resolved addresses here, so this
  // means something upstream is wrong — refuse rather than allow.
  return true;
}

/**
 * The checks that can be made from the string alone, run when a partner
 * registers an endpoint.
 *
 * @throws AgentPassError `WebhookUrlNotAllowed` with a reason a partner can
 * act on — never a generic rejection, because the most likely cause by far is
 * an honest mistake (`http`, a trailing space, a private staging host).
 */
export function assertWebhookUrlShape(value: string): AllowedWebhookUrl {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw refuse("that is not a URL", { url: value });
  }

  if (url.protocol !== "https:") {
    // Not negotiable even for a partner's own staging: the payload carries a
    // signature over the body, and plaintext would let anyone on the path
    // read every event and replay it within the five-minute window
    // `WEBHOOK_REPLAY_WINDOW_MS` allows.
    throw refuse("a webhook endpoint must use https", { url: value, protocol: url.protocol });
  }
  if (url.username !== "" || url.password !== "") {
    // Credentials in a URL end up in logs and error messages. If the endpoint
    // needs to authenticate us, the signature header is how.
    throw refuse("a webhook endpoint must not carry credentials in its URL", { url: value });
  }
  if (url.port !== "" && url.port !== "443") {
    // A port is how an inward-pointing URL reaches something interesting —
    // 5432, 6379, a sibling app's internal port. Public webhook receivers
    // listen on 443.
    throw refuse("a webhook endpoint must use the default https port", { url: value, port: url.port });
  }
  if (url.hash !== "") {
    throw refuse("a webhook endpoint must not have a fragment", { url: value });
  }
  if (isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0) {
    // A literal address skips DNS, so the delivery-time re-resolution below
    // has nothing to catch it with. Refusing them all is simpler to reason
    // about than allowing the public ones.
    throw refuse("a webhook endpoint must name a host, not an IP address", { url: value, host: url.hostname });
  }
  if (!url.hostname.includes(".") || url.hostname.endsWith(".localhost")) {
    // A bare name is only resolvable inside a private network.
    throw refuse("a webhook endpoint must name a public host", { url: value, host: url.hostname });
  }

  return { url: url.toString(), hostname: url.hostname };
}

/** How {@link assertWebhookUrlResolvesPublicly} looks up a name. Injected so a test needs no DNS. */
export type ResolveHost = (hostname: string) => Promise<readonly string[]>;

/**
 * The check that actually protects the network: resolve the hostname now, at
 * delivery time, and refuse if **any** address it answers with is one the
 * public internet does not route to.
 *
 * Any, not all: a name that answers with one public and one private address is
 * a name whose next connection could go either way.
 *
 * @throws AgentPassError `WebhookUrlNotAllowed` when the name resolves inward,
 * or cannot be resolved at all.
 */
export async function assertWebhookUrlResolvesPublicly(
  hostname: string,
  resolve: ResolveHost,
): Promise<void> {
  let addresses: readonly string[];
  try {
    addresses = await resolve(hostname);
  } catch (error) {
    throw refuse("could not resolve that webhook endpoint's host", { host: hostname, cause: String(error) });
  }
  if (addresses.length === 0) {
    throw refuse("that webhook endpoint's host resolves to nothing", { host: hostname });
  }
  const privateAddresses = addresses.filter((address) => isPrivateAddress(address));
  if (privateAddresses.length > 0) {
    throw refuse("that webhook endpoint's host resolves to a private address", {
      host: hostname,
      // The addresses themselves, so an operator reading a log can tell a
      // misconfigured partner from someone probing the network.
      addresses: privateAddresses,
    });
  }
}
