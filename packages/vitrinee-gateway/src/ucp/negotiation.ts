/**
 * UCP version negotiation (T131, T133, R-14). A platform says which version it
 * speaks in the `ucp.version` of its profile, the document `UCP-Agent:
 * profile="…"` points to. A `version="…"` parameter on that header is not in
 * the spec, but the official conformance suite sends it, so it is honored and
 * wins. A version this store does not serve is answered with 422
 * `version_unsupported`, before any route runs. When the version cannot be
 * known (no header, a profile that does not answer or does not parse), the
 * store answers in the newest version it serves.
 *
 * The negotiated version is left in `res.locals.ucpVersion` for the routes.
 */
import { UCP_LATEST_VERSION, UCP_VERSIONS, isUcpVersion, type UcpVersion } from "@vitrinee/core";
import type { NextFunction, Request, Response } from "express";

import type { PlatformProfileReader } from "./platform-profile.js";

/** The versions this store serves, newest first. */
export const SUPPORTED_UCP_VERSIONS: readonly string[] = UCP_VERSIONS;

function headerParam(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  const match = new RegExp(`(?:^|[;,\\s])${name}="([^"]*)"`).exec(header);
  return match === null ? null : match[1]!;
}

/** The `version` parameter of a `UCP-Agent` header (an RFC 8941 dictionary), or null when there is none. */
export function requestedUcpVersion(header: string | undefined): string | null {
  return headerParam(header, "version");
}

/** The `profile` parameter of a `UCP-Agent` header: the platform's profile URL, or null. */
export function platformProfileUrl(header: string | undefined): string | null {
  return headerParam(header, "profile");
}

/** The version a request speaks, or the version it asked for that this store does not serve. */
export async function negotiateUcpVersion(
  header: string | undefined,
  profiles: PlatformProfileReader | null,
): Promise<{ ok: true; version: UcpVersion; source: "header" | "profile" | "default"; unread?: { host: string; reason: string } } | { ok: false; asked: string }> {
  const asked = requestedUcpVersion(header);
  if (asked !== null) return isUcpVersion(asked) ? { ok: true, version: asked, source: "header" } : { ok: false, asked };
  const url = platformProfileUrl(header);
  if (url !== null && profiles !== null) {
    const read = await profiles.read(url);
    if (read.ok) {
      const declared = read.profile.ucp.version;
      return isUcpVersion(declared) ? { ok: true, version: declared, source: "profile" } : { ok: false, asked: declared };
    }
    // R-14 departs from UCP here, by the user's decision: the spec answers an unreadable profile with
    // profile_unreachable (424) or profile_malformed (422); this store answers in its newest version.
    return { ok: true, version: UCP_LATEST_VERSION, source: "default", unread: { host: hostOf(url), reason: read.reason } };
  }
  return { ok: true, version: UCP_LATEST_VERSION, source: "default" };
}

/** Only the host goes to the log: the rest of a URL a stranger wrote is theirs. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(not a URL)";
  }
}

/** The version this request was answered in; set by {@link ucpVersionGuard}. */
export function ucpVersionOf(res: Response): UcpVersion {
  const version = (res.locals as { ucpVersion?: unknown }).ucpVersion;
  return typeof version === "string" && isUcpVersion(version) ? version : UCP_LATEST_VERSION;
}

export function ucpVersionGuard(profiles: PlatformProfileReader | null, log: (message: string, fields?: Record<string, unknown>) => void = () => {}) {
  // At most one line a minute per host: a stranger can name any number of unreadable profiles.
  const lastLogged = new Map<string, number>();
  const logUnread = (fields: { host: string; reason: string; version: string }) => {
    const t = Date.now();
    if ((lastLogged.get(fields.host) ?? 0) > t - 60_000) return;
    if (lastLogged.size >= 1_000) lastLogged.clear();
    lastLogged.set(fields.host, t);
    log("ucp platform profile unread; answering in the default version", fields);
  };
  return (req: Request, res: Response, next: NextFunction): void => {
    negotiateUcpVersion(req.get("ucp-agent"), profiles)
      .then((outcome) => {
        if (outcome.ok) {
          // A platform that names a profile the store cannot read gets the default version; say so, or
          // AgentPey's own agent could drift to it unseen while agentpey.com is down.
          if (outcome.unread !== undefined) logUnread({ ...outcome.unread, version: outcome.version });
          (res.locals as { ucpVersion?: UcpVersion }).ucpVersion = outcome.version;
          return next();
        }
        log("ucp version unsupported", { asked: outcome.asked });
        res
          .status(422)
          .set("Cache-Control", "no-store")
          .json({
            ucp: { version: UCP_LATEST_VERSION, status: "error" },
            messages: [
              {
                type: "error",
                code: "version_unsupported",
                content: `UCP version ${outcome.asked} is not supported; this store serves ${SUPPORTED_UCP_VERSIONS.join(", ")}`,
                severity: "unrecoverable",
              },
            ],
          });
      })
      .catch(next);
  };
}
