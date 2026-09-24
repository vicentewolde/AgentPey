import { describe, expect, it } from "vitest";

import { routeHost } from "./hosts.js";

const P = "vitrinee.agentpey.com";

describe("routeHost (C-142)", () => {
  it("sends the platform host to the portal", () => {
    expect(routeHost("vitrinee.agentpey.com", P)).toEqual({ kind: "portal" });
    expect(routeHost("Vitrinee.AgentPey.com:443", P)).toEqual({ kind: "portal" });
  });

  it("reads one slug-shaped label in front of the platform host as a store", () => {
    expect(routeHost("bazar-cordillera.vitrinee.agentpey.com", P)).toEqual({ kind: "store", slug: "bazar-cordillera" });
    expect(routeHost("BAZAR.vitrinee.agentpey.com:8080", P)).toEqual({ kind: "store", slug: "bazar" });
  });

  it("refuses anything that only looks like it", () => {
    for (const host of [
      "bazar.vitrinee.agentpey.com.attacker.example",
      "a.b.vitrinee.agentpey.com",
      "bazarvitrinee.agentpey.com",
      "-bazar.vitrinee.agentpey.com",
      "bazar--x.vitrinee.agentpey.com",
      "baz_ar.vitrinee.agentpey.com",
      `${"a".repeat(41)}.vitrinee.agentpey.com`,
      ".vitrinee.agentpey.com",
      "agentpey.com",
      "realops.agentpey.com",
    ]) {
      expect(routeHost(host, P), host).toEqual({ kind: "unknown" });
    }
    expect(routeHost(undefined, P)).toEqual({ kind: "unknown" });
    expect(routeHost("", P)).toEqual({ kind: "unknown" });
  });
});
