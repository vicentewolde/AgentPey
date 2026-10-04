/**
 * UCP version negotiation (T131): a platform may say which version it speaks
 * in the `UCP-Agent` header (`profile="…"; version="2026-04-08"`). A version
 * this store does not serve is answered with 422 `version_unsupported`, before
 * any route runs, instead of being served in a version the platform did not ask
 * for. No version in the header means the platform takes what the profile
 * declares.
 */
import { UCP_VERSION } from "@vitrinee/core";
import type { NextFunction, Request, Response } from "express";

/** The versions this store serves. T133 adds `2026-08-25` here. */
export const SUPPORTED_UCP_VERSIONS: readonly string[] = [UCP_VERSION];

/** The `version` parameter of a `UCP-Agent` header (an RFC 8941 dictionary), or null when there is none. */
export function requestedUcpVersion(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /(?:^|[;,\s])version="([^"]*)"/.exec(header);
  return match === null ? null : match[1]!;
}

export function ucpVersionGuard(req: Request, res: Response, next: NextFunction): void {
  const asked = requestedUcpVersion(req.get("ucp-agent"));
  if (asked === null || SUPPORTED_UCP_VERSIONS.includes(asked)) return next();
  res
    .status(422)
    .set("Cache-Control", "no-store")
    .json({
      ucp: { version: UCP_VERSION, status: "error" },
      messages: [
        {
          type: "error",
          code: "version_unsupported",
          content: `UCP version ${asked} is not supported; this store serves ${SUPPORTED_UCP_VERSIONS.join(", ")}`,
          severity: "unrecoverable",
        },
      ],
    });
}
