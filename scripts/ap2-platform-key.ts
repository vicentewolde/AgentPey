#!/usr/bin/env node
/**
 * `pnpm run ap2:platform-key [-- --check]` — AgentPey's AP2 platform key (T134, R-16).
 *
 * The platform signs the open checkout mandates its agent closes in a UCP
 * checkout with a P-256 key. Its secret lives only in `.env.local` as
 * `AGENTPEY_PLATFORM_AP2_SECRET` (created here once, never printed); its
 * public half goes in `apps/web/public/ucp/platform/agentpey-ap2.json`, the
 * platform profile that declares UCP 2026-08-25 and the AP2 extension, which
 * agentpey.com serves and stores read.
 *
 * Without `--check`: create the secret if missing, and (re)write the profile
 * from it. With `--check`: change nothing, and fail unless the published key
 * is the secret's.
 */
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { AgentPassError } from "@agentpass/core";

import { p256FromScalar } from "../packages/ap2/src/keys.js";
import { PLATFORM_AP2_KID } from "./lib/ap2-platform.js";
import { readEnvFile, upsertEnvValue, writeEnvFile } from "./lib/env-file.js";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const ENV_PATH = resolve(ROOT, ".env.local");
const BASE_PROFILE = resolve(ROOT, "apps/web/public/ucp/platform/agentpey-2026-08-25.json");
const AP2_PROFILE = resolve(ROOT, "apps/web/public/ucp/platform/agentpey-ap2.json");
const KEY = "AGENTPEY_PLATFORM_AP2_SECRET";

const { values } = parseArgs({ args: process.argv.slice(2).filter((a) => a !== "--"), options: { check: { type: "boolean", default: false } } });

function newScalar(): Buffer {
  for (;;) {
    const d = randomBytes(32);
    try {
      p256FromScalar(d, PLATFORM_AP2_KID);
      return d;
    } catch {
      // out of [1, n): draw again (probability about 2^-32)
    }
  }
}

const env = await readEnvFile(ENV_PATH);
let secret = env.get(KEY)?.trim() ?? "";
if (secret === "") {
  if (values.check) throw new AgentPassError("ConfigError", `${KEY} is missing from .env.local`, { details: { fix: "pnpm run ap2:platform-key" } });
  secret = newScalar().toString("base64url");
  await writeEnvFile(ENV_PATH, upsertEnvValue(await readFile(ENV_PATH, "utf8"), KEY, secret));
  process.stdout.write(`created ${KEY} in .env.local (not shown)\n`);
}
const key = p256FromScalar(Buffer.from(secret, "base64url"), PLATFORM_AP2_KID);

const base = JSON.parse(await readFile(BASE_PROFILE, "utf8")) as { ucp: { version: string; capabilities: Record<string, unknown> } };
const profile = {
  ucp: {
    ...base.ucp,
    capabilities: {
      ...base.ucp.capabilities,
      "dev.ucp.common.payment.ap2_mandate": [
        {
          version: base.ucp.version,
          spec: "https://ucp.dev/2026-08-25/specification/payment/extensions/ap2-mandates",
          schema: "https://ucp.dev/2026-08-25/schemas/common/payment_ap2_mandate.json",
          extends: "dev.ucp.shopping.checkout",
        },
      ],
    },
  },
  keys: [key.publicJwk],
};
const text = `${JSON.stringify(profile, null, 2)}\n`;

if (values.check) {
  const published = await readFile(AP2_PROFILE, "utf8").catch(() => "");
  if (published !== text) throw new AgentPassError("ConfigError", "agentpey-ap2.json does not publish this secret's key; run pnpm run ap2:platform-key", { details: {} });
  process.stdout.write(`ok: agentpey-ap2.json publishes ${PLATFORM_AP2_KID}\n`);
} else {
  await writeFile(AP2_PROFILE, text);
  process.stdout.write(`wrote apps/web/public/ucp/platform/agentpey-ap2.json with ${PLATFORM_AP2_KID}\n`);
}
