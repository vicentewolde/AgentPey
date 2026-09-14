import { describe, expect, it } from "vitest";

import {
  REALOPS_TARGET,
  SIGNALDESK_TARGET,
  WEB_TARGET,
  buildHostMap,
  normaliseHost,
  resolveTarget,
} from "./hosts.js";

const CONFIG = {
  agentpeyHost: "agentpey.com",
  realopsHost: "realops.agentpey.com",
  signaldeskHost: "signaldesk.agentpey.com",
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
});

describe("buildHostMap", () => {
  it("refuses a config where two apps would share the same host", () => {
    expect(() => buildHostMap({ ...CONFIG, realopsHost: "agentpey.com" })).toThrow(/same host/);
  });

  it("compares hosts case-insensitively when checking for a collision", () => {
    expect(() => buildHostMap({ ...CONFIG, realopsHost: "AgentPey.com" })).toThrow(/same host/);
  });
});
