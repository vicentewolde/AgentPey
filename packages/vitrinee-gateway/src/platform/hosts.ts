/**
 * Which merchant (comercio) a request is for, read from its `Host` (C-142).
 *
 * `vitrinee.agentpey.com` is the portal; `<slug>.vitrinee.agentpey.com` is one
 * merchant's store for agents. The rule is narrow on purpose, the same one the
 * gateway in front of this process applies: exactly one label, shaped like a
 * slug, in front of the platform host, compared whole. Never a prefix or
 * substring test: `bazar.vitrinee.agentpey.com.attacker.example` must not
 * match (the mistake C-109 and C-114 already closed once).
 *
 * The gateway copies this rule rather than importing it: Vitrinee imports
 * nothing from AgentPey's apps (C-88, C-136).
 */

/** Same shape as a venue slug in AgentPey's registry: lowercase, digits, single hyphens. */
export const COMERCIO_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const COMERCIO_SLUG_MAX = 40;

export type HostRoute = { kind: "portal" } | { kind: "store"; slug: string } | { kind: "unknown" };

export function isComercioSlug(value: string): boolean {
  return value.length <= COMERCIO_SLUG_MAX && COMERCIO_SLUG_PATTERN.test(value);
}

/** Strips `:port` and lowercases: what a browser's `Host` header actually carries. */
export function normaliseHost(hostHeader: string | undefined): string | undefined {
  if (hostHeader === undefined || hostHeader === "") return undefined;
  const host = hostHeader.split(":")[0]?.toLowerCase();
  return host === undefined || host === "" ? undefined : host;
}

export function routeHost(hostHeader: string | undefined, platformHost: string): HostRoute {
  const host = normaliseHost(hostHeader);
  const platform = platformHost.toLowerCase();
  if (host === undefined) return { kind: "unknown" };
  if (host === platform) return { kind: "portal" };
  const suffix = `.${platform}`;
  if (!host.endsWith(suffix)) return { kind: "unknown" };
  const label = host.slice(0, host.length - suffix.length);
  return isComercioSlug(label) ? { kind: "store", slug: label } : { kind: "unknown" };
}
