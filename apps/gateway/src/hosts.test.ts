import { describe, expect, it } from "vitest";

import { filterEnv } from "./env-filter.js";
import {
  APP_TARGETS,
  REALOPS_TARGET,
  SIGNALDESK_TARGET,
  VITRINEE_TARGET,
  WEB_TARGET,
  buildHostMap,
  missingEnv,
  normaliseHost,
  resolveTarget,
} from "./hosts.js";

const CONFIG = {
  agentpeyHost: "agentpey.com",
  realopsHost: "realops.agentpey.com",
  signaldeskHost: "signaldesk.agentpey.com",
  vitrineeHost: "vitrinee.agentpey.com",
};

describe("normaliseHost", () => {
  it("lowercases and drops a :port suffix, the shape a browser's Host header actually has", () => {
    expect(normaliseHost("RealOps.AgentPey.com:443")).toBe("realops.agentpey.com");
    expect(normaliseHost("agentpey.com")).toBe("agentpey.com");
  });

  it("is undefined for a missing or empty header", () => {
    expect(normaliseHost(undefined)).toBeUndefined();
    expect(normaliseHost("")).toBeUndefined();
  });
});

describe("resolveTarget", () => {
  const hostMap = buildHostMap(CONFIG);

  it("resolves each configured host to its own app", () => {
    expect(resolveTarget(hostMap, "agentpey.com")).toBe(WEB_TARGET);
    expect(resolveTarget(hostMap, "realops.agentpey.com")).toBe(REALOPS_TARGET);
    expect(resolveTarget(hostMap, "signaldesk.agentpey.com")).toBe(SIGNALDESK_TARGET);
    expect(resolveTarget(hostMap, "vitrinee.agentpey.com")).toBe(VITRINEE_TARGET);
  });

  it("matches case-insensitively and ignores a :port suffix", () => {
    expect(resolveTarget(hostMap, "REALOPS.AGENTPEY.COM:443")).toBe(REALOPS_TARGET);
  });

  it("refuses an unknown host with undefined, not a default app", () => {
    expect(resolveTarget(hostMap, "attacker.example")).toBeUndefined();
    expect(resolveTarget(hostMap, undefined)).toBeUndefined();
  });

  /**
   * The whole reason this is an exact map and not `host.startsWith("realops.")`
   * (see hosts.ts's docstring) — a domain an attacker chose specifically to
   * begin with the right word must not match.
   */
  it("refuses a host that only starts with a configured one", () => {
    expect(resolveTarget(hostMap, "realops.agentpey.com.attacker.example")).toBeUndefined();
    expect(resolveTarget(hostMap, "notrealops.agentpey.com")).toBeUndefined();
  });

  describe("a store of the Vitrinee platform (T103, C-142)", () => {
    const V = "vitrinee.agentpey.com";

    it("sends one slug-shaped label in front of the Vitrinee host to Vitrinee", () => {
      expect(resolveTarget(hostMap, "bazar-cordillera.vitrinee.agentpey.com", V)).toBe(VITRINEE_TARGET);
      expect(resolveTarget(hostMap, "Tienda2.Vitrinee.AgentPey.com:443", V)).toBe(VITRINEE_TARGET);
    });

    it("refuses anything that only looks like a store", () => {
      for (const host of [
        "bazar.vitrinee.agentpey.com.attacker.example",
        "a.b.vitrinee.agentpey.com",
        "bazarvitrinee.agentpey.com",
        "-bazar.vitrinee.agentpey.com",
        "baz_ar.vitrinee.agentpey.com",
        `${"a".repeat(41)}.vitrinee.agentpey.com`,
        ".vitrinee.agentpey.com",
        "x.realops.agentpey.com",
        "x.agentpey.com",
      ]) {
        expect(resolveTarget(hostMap, host, V), host).toBeUndefined();
      }
    });

    it("is off unless the caller names the Vitrinee host", () => {
      expect(resolveTarget(hostMap, "bazar.vitrinee.agentpey.com")).toBeUndefined();
    });
  });
});

describe("buildHostMap", () => {
  it("refuses a config where two apps would share the same host", () => {
    expect(() => buildHostMap({ ...CONFIG, realopsHost: "agentpey.com" })).toThrow(/same host/);
  });

  it("compares hosts case-insensitively when checking for a collision", () => {
    expect(() => buildHostMap({ ...CONFIG, realopsHost: "AgentPey.com" })).toThrow(/same host/);
  });
});

/**
 * T102 (`C-134`, `C-136`): the property `C-88` bought for SignalDesk, now for
 * Vitrinee too, checked against the real target table rather than restated.
 * One container holds every secret; each child sees only its own.
 */
describe("which secrets each child actually receives", () => {
  const CONTAINER = {
    PATH: "/usr/bin",
    DATABASE_URL: "postgres://shared",
    ISSUER_SECRET_KEY: "S-ISSUER",
    AGENT_SECRET_KEY: "S-AGENT",
    ADMIN_SECRET_KEY: "S-ADMIN",
    MASTER_MNEMONIC: "twelve words",
    REALOPS_AGENTPEY_API_KEY: "apk-realops",
    RESEND_API_KEY: "re-key",
    SIGNALDESK_SECRET_KEY: "S-SIGNALDESK",
    SIGNALDESK_FACILITATOR_SECRET: "S-SD-FACILITATOR",
    PUBLIC_BASE_URL: "https://agentpey.com",
    VITRINEE_ADAPTER: "jumpseller",
    VITRINEE_PUBLIC_BASE_URL: "https://vitrinee.agentpey.com",
    VITRINEE_MERCHANT_STELLAR_ACCOUNT: "G-MERCHANT",
    VITRINEE_MERCHANT_SIGNING_SECRET: "S-RECEIPTS",
    VITRINEE_FACILITATOR_API_KEY: "oz-key",
    VITRINEE_JUMPSELLER_LOGIN: "store-login",
    VITRINEE_JUMPSELLER_AUTHTOKEN: "store-token",
    VITRINEE_DATABASE_URL: "postgres://vitrinee-role",
    VITRINEE_MASTER_KEY: "master-key",
  };
  const VITRINEE_SECRETS = ["S-RECEIPTS", "oz-key", "store-login", "store-token", "postgres://vitrinee-role", "master-key"];
  const AGENTPEY_SECRETS = ["S-ISSUER", "S-AGENT", "S-ADMIN", "twelve words", "apk-realops", "re-key", "S-SIGNALDESK", "S-SD-FACILITATOR", "postgres://shared"];

  const childEnv = (target: typeof WEB_TARGET) => filterEnv(CONTAINER, target.envKeys, { PORT: String(target.port) }, target.envAliases);

  it("hands Vitrinee its own values under the names it reads, and nothing of AgentPey's", () => {
    const env = childEnv(VITRINEE_TARGET);

    expect(env).toMatchObject({
      ADAPTER: "jumpseller",
      PUBLIC_BASE_URL: "https://vitrinee.agentpey.com",
      MERCHANT_STELLAR_ACCOUNT: "G-MERCHANT",
      MERCHANT_SIGNING_SECRET: "S-RECEIPTS",
      FACILITATOR_API_KEY: "oz-key",
      JUMPSELLER_LOGIN: "store-login",
      JUMPSELLER_AUTHTOKEN: "store-token",
      DATABASE_URL: "postgres://vitrinee-role",
      MASTER_KEY: "master-key",
      PORT: "4104",
    });
    for (const secret of AGENTPEY_SECRETS) expect(Object.values(env)).not.toContain(secret);
    // The prefixed names themselves stay behind: the child reads only the generic ones.
    expect(Object.keys(env).some((key) => key.startsWith("VITRINEE_"))).toBe(false);
  });

  it("never hands Vitrinee's receipt-signing key, or any of its secrets, to another app", () => {
    for (const target of APP_TARGETS.filter((candidate) => candidate !== VITRINEE_TARGET)) {
      const values = Object.values(childEnv(target));
      for (const secret of VITRINEE_SECRETS) expect(values, `${target.name} got ${secret}`).not.toContain(secret);
    }
  });

  it("does not hand web's PUBLIC_BASE_URL to Vitrinee, nor Vitrinee's to web", () => {
    expect(childEnv(VITRINEE_TARGET).PUBLIC_BASE_URL).toBe("https://vitrinee.agentpey.com");
    expect(childEnv(WEB_TARGET).PUBLIC_BASE_URL).toBe("https://agentpey.com");
  });

  /** A `VITRINEE_` name in another app's list would be the leak this whole scheme exists to prevent. */
  it("lists no VITRINEE_ secret in any other app's keys", () => {
    const secretNames = Object.values(VITRINEE_TARGET.envAliases ?? {}).filter((name) => /SECRET|KEY|LOGIN|AUTHTOKEN/.test(name));
    expect(secretNames).toHaveLength(5);
    for (const target of APP_TARGETS.filter((candidate) => candidate !== VITRINEE_TARGET)) {
      for (const name of [...secretNames, "VITRINEE_DATABASE_URL"]) expect(target.envKeys).not.toContain(name);
    }
  });

  /** T103, C-143: the container's DATABASE_URL is AgentPey's; Vitrinee only ever gets its own role's. */
  it("never hands Vitrinee AgentPey's DATABASE_URL, even when its own is not set", () => {
    const { VITRINEE_DATABASE_URL: _own, ...withoutOwn } = CONTAINER;
    const env = filterEnv(withoutOwn, VITRINEE_TARGET.envKeys, {}, VITRINEE_TARGET.envAliases);
    expect(env.DATABASE_URL).toBeUndefined();
    expect(Object.values(env)).not.toContain("postgres://shared");
  });
});

describe("missingEnv", () => {
  const COMPLETE = {
    VITRINEE_ADAPTER: "jumpseller",
    VITRINEE_MERCHANT_STELLAR_ACCOUNT: "G",
    VITRINEE_MERCHANT_SIGNING_SECRET: "S",
    VITRINEE_FACILITATOR_API_KEY: "k",
    VITRINEE_JUMPSELLER_LOGIN: "l",
    VITRINEE_JUMPSELLER_AUTHTOKEN: "t",
  };

  it("lets Vitrinee start once every secret it needs is set", () => {
    expect(missingEnv(VITRINEE_TARGET, COMPLETE)).toEqual([]);
  });

  /** The rollout window: the blueprint is deployed before the secrets are loaded. */
  it("names what is missing, and treats an empty value as missing", () => {
    expect(missingEnv(VITRINEE_TARGET, { ...COMPLETE, VITRINEE_MERCHANT_SIGNING_SECRET: "" })).toEqual(["VITRINEE_MERCHANT_SIGNING_SECRET"]);
    expect(missingEnv(VITRINEE_TARGET, {})).toHaveLength(6);
  });

  /** What the first real deploy looked like: the four secrets set, none of the public values. */
  it("does not start Vitrinee on its mock store just because the adapter was never set", () => {
    const { VITRINEE_ADAPTER: _adapter, VITRINEE_MERCHANT_STELLAR_ACCOUNT: _account, ...secretsOnly } = COMPLETE;
    expect(missingEnv(VITRINEE_TARGET, secretsOnly)).toEqual(["VITRINEE_ADAPTER", "VITRINEE_MERCHANT_STELLAR_ACCOUNT"]);
  });

  it("never holds back the three apps the pilot cannot run without", () => {
    for (const target of [WEB_TARGET, REALOPS_TARGET, SIGNALDESK_TARGET]) {
      expect(missingEnv(target, {})).toEqual([]);
      expect(target.critical).toBe(true);
    }
    expect(VITRINEE_TARGET.critical).toBe(false);
  });
});
