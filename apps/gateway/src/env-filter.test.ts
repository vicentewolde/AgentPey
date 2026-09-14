import { describe, expect, it } from "vitest";

import { filterEnv } from "./env-filter.js";

describe("filterEnv", () => {
  const source = {
    PATH: "/usr/bin",
    HOME: "/home/pilot",
    DATABASE_URL: "postgres://shared",
    SIGNALDESK_SECRET_KEY: "SSIGNALDESK",
    AGENT_SECRET_KEY: "SAGENT",
    MASTER_MNEMONIC: "twelve words here",
    UNRELATED_NOISE: "should never appear anywhere",
  };

  it("forwards only the keys this app was granted, never a sibling's secret", () => {
    const env = filterEnv(source, ["DATABASE_URL", "SIGNALDESK_SECRET_KEY"]);

    expect(env).toMatchObject({ DATABASE_URL: "postgres://shared", SIGNALDESK_SECRET_KEY: "SSIGNALDESK" });
    expect(env).not.toHaveProperty("AGENT_SECRET_KEY");
    expect(env).not.toHaveProperty("MASTER_MNEMONIC");
    expect(env).not.toHaveProperty("UNRELATED_NOISE");
  });

  it("always forwards the system keys that are present, for every app", () => {
    const env = filterEnv(source, []);

    expect(env).toMatchObject({ PATH: "/usr/bin", HOME: "/home/pilot" });
  });

  it("never invents a value for a key the source does not have", () => {
    const env = filterEnv(source, ["NOT_SET_ANYWHERE"]);

    expect(env).not.toHaveProperty("NOT_SET_ANYWHERE");
  });

  it("lets an override win even over a same-named key the source and appKeys both allow", () => {
    const env = filterEnv(source, ["DATABASE_URL"], { DATABASE_URL: "postgres://overridden", PORT: "4101" });

    expect(env).toMatchObject({ DATABASE_URL: "postgres://overridden", PORT: "4101" });
  });

  it("produces plain strings only — never undefined — which is what child_process.spawn requires", () => {
    const env = filterEnv(source, ["DATABASE_URL", "NOT_SET_ANYWHERE"]);

    for (const value of Object.values(env)) expect(typeof value).toBe("string");
  });
});
