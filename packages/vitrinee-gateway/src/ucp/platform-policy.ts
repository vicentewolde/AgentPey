import { VitrineeError } from "@vitrinee/core";

/**
 * Who may open a checkout at a store (T172, VT-49). Both switches are off by default: a store that sets neither
 * lets any platform open one, as before.
 *
 * Requiring AP2 alone proves little: the store checks a mandate against the profile of whichever platform opened the
 * session, and anyone can publish a profile with a key of their own. What makes it a control is the allowlist, so
 * that a store which wants to know who buys through it names the platforms it deals with.
 */
export interface PlatformPolicy {
  /** A session is refused unless its platform negotiated AP2 (2026-08-25 with the mandate extension). */
  requireAp2: boolean;
  /** Origins of the platform profiles that may open a checkout. Empty: any platform may. */
  allowedPlatforms: readonly string[];
}

export const OPEN_PLATFORM_POLICY: PlatformPolicy = { requireAp2: false, allowedPlatforms: [] };

export interface PlatformRefusal {
  code: "platform_not_allowed" | "ap2_required";
  content: string;
}

/** The platform behind a request, as the checkout read it: its profile URL and whether it declares AP2. */
export interface PolicyView {
  version: string;
  platform: { url: string; ap2: boolean } | null;
}

/** `undefined` when the platform may open a checkout here. */
export function platformRefusal(policy: PlatformPolicy, view: PolicyView): PlatformRefusal | undefined {
  if (policy.allowedPlatforms.length > 0) {
    const origin = view.platform === null ? undefined : new URL(view.platform.url).origin;
    if (origin === undefined || !policy.allowedPlatforms.includes(origin)) {
      return { code: "platform_not_allowed", content: "this store only opens checkouts for the platforms it has approved" };
    }
  }
  if (policy.requireAp2 && !(view.version === "2026-08-25" && view.platform !== null && view.platform.ap2)) {
    return { code: "ap2_required", content: "this store only sells through platforms that sign an AP2 mandate: open the checkout in UCP 2026-08-25 with the AP2 extension" };
  }
  return undefined;
}

/**
 * `ALLOWED_PLATFORMS`: https URLs separated by commas, of the platforms' profiles or their origins. Only the origin is
 * kept: a platform is the host that publishes its profile.
 *
 * @throws VitrineeError `ConfigError` on anything that is not an https URL
 */
export function parseAllowedPlatforms(value: string | undefined, name = "ALLOWED_PLATFORMS"): string[] {
  if (value === undefined || value.trim() === "") return [];
  const origins = value.split(",").map((u) => u.trim()).filter((u) => u !== "").map((u) => {
    if (!URL.canParse(u) || new URL(u).protocol !== "https:") {
      throw new VitrineeError("ConfigError", `invalid environment: ${name}: expected https URLs separated by commas`, { details: { name } });
    }
    return new URL(u).origin;
  });
  return [...new Set(origins)];
}

/**
 * `REQUIRE_AP2`: `true` or `false`.
 *
 * @throws VitrineeError `ConfigError` on anything else
 */
export function parseRequireAp2(value: string | undefined, name = "REQUIRE_AP2"): boolean {
  if (value === undefined || value.trim() === "") return false;
  const v = value.trim().toLowerCase();
  if (v !== "true" && v !== "false") throw new VitrineeError("ConfigError", `invalid environment: ${name}: expected true or false`, { details: { name } });
  return v === "true";
}
