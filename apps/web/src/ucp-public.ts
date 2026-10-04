/**
 * The UCP payment handler and extension AgentPey authors (Fase 7, E-1). UCP
 * requires a name's `spec` and `schema` URLs to live on that name's domain, so
 * `com.agentpey.*` is published here, on agentpey.com. A `/spec` URL serves
 * the Markdown next to its schema.
 */
export function ucpPublicPath(pathname: string): string | undefined {
  // AgentPey's own platform profile, sent in the UCP-Agent header of every request it makes (T122).
  // The same platform declaring UCP 2026-08-25 (T133): a store answers in the version this profile says.
  if (pathname === "/ucp/platform/agentpey.json" || pathname === "/ucp/platform/agentpey-2026-08-25.json") return pathname;
  const match = /^\/ucp\/(handlers\/stellar-x402|extensions\/receipt)\/(spec|schema\.json)$/.exec(pathname);
  if (match === null) return undefined;
  return match[2] === "spec" ? `/ucp/${match[1]}/spec.md` : pathname;
}
