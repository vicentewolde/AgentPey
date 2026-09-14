import { hasErrorCode } from "@agentpass/core";
import { describe, expect, it } from "vitest";

import {
  agentIdFromLocation,
  checkCode,
  checkThat,
  consentSessionIdFromUrl,
  createCookieJar,
  declared,
  pageSays,
  parseAcceptanceArgs,
  personaEmail,
  readExternalRef,
  readOnScreenMagicLink,
  readRequestKey,
  readSignedMandateId,
  redact,
  tally,
  unescapeHtml,
} from "./f9-acceptance.js";

describe("parseAcceptanceArgs", () => {
  it("defaults to day1 and every persona", () => {
    expect(parseAcceptanceArgs([])).toEqual({ phase: "day1", only: null });
  });

  it("reads --phase and --only, case-insensitively for personas", () => {
    expect(parseAcceptanceArgs(["--phase=day2", "--only=a, c"])).toEqual({ phase: "day2", only: ["A", "C"] });
  });

  it("ignores the bare -- that pnpm may forward", () => {
    expect(parseAcceptanceArgs(["--", "--only=B"])).toEqual({ phase: "day1", only: ["B"] });
  });

  it("refuses an unknown phase, persona or flag instead of running everything", () => {
    for (const argv of [["--phase=day3"], ["--only=Z"], ["--only="], ["--all"]]) {
      let thrown: unknown;
      try {
        parseAcceptanceArgs(argv);
      } catch (error) {
        thrown = error;
      }
      expect(hasErrorCode(thrown, "InvalidArguments")).toBe(true);
    }
  });
});

describe("createCookieJar", () => {
  it("keeps a session cookie and sends it back without its attributes", () => {
    const jar = createCookieJar();
    jar.absorb(["realops_session=abc123; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800"]);
    expect(jar.header()).toBe("realops_session=abc123");
  });

  it("forgets a cookie sent back empty or with Max-Age=0, as RealOps does on sign-out", () => {
    const jar = createCookieJar();
    jar.absorb(["a=1", "b=2"]);
    jar.absorb(["a=; Path=/; Max-Age=0", "b=2; Max-Age=0"]);
    expect(jar.header()).toBeUndefined();
  });

  it("clears everything", () => {
    const jar = createCookieJar();
    jar.absorb(["a=1"]);
    jar.clear();
    expect(jar.header()).toBeUndefined();
  });
});

describe("reading RealOps pages", () => {
  it("finds the on-screen sign-in link, unescaped", () => {
    const html =
      '<p><a class="button" href="https://realops.example/entrar/tok_&amp;x" data-magic-link><span data-tr="en">Sign in with the link</span></a></p>';
    expect(readOnScreenMagicLink(html)).toBe("https://realops.example/entrar/tok_&x");
    expect(readOnScreenMagicLink('<p><a class="button" href="/entrar">Sign in</a></p>')).toBeUndefined();
  });

  it("finds the purchase form's request key", () => {
    const html = '<input type="hidden" name="request_key" value="6f1c2b1e-0000-4000-8000-000000000000">';
    expect(readRequestKey(html)).toBe("6f1c2b1e-0000-4000-8000-000000000000");
  });

  it("finds the stored Mandate id and the external reference", () => {
    expect(readSignedMandateId('<p>✓ Signed. Mandate <code data-mandate-id>mdt_01M2EGQG5831T7BJVJMQKVTMSK</code></p>')).toBe(
      "mdt_01M2EGQG5831T7BJVJMQKVTMSK",
    );
    expect(readExternalRef("Te identificamos ante AgentPey como <code>rop_01M2DPVEA88Q99SKWTGBDE3YK4</code>.")).toBe(
      "rop_01M2DPVEA88Q99SKWTGBDE3YK4",
    );
  });

  it("reads ids out of redirects, and nothing out of the wrong shape", () => {
    expect(agentIdFromLocation("/agentes/rag_01M2EGQG5831T7BJVJMQKVTMSK")).toBe("rag_01M2EGQG5831T7BJVJMQKVTMSK");
    expect(agentIdFromLocation("/agentes/rag_01M2EGQG5831T7BJVJMQKVTMSK/volver")).toBeUndefined();
    expect(consentSessionIdFromUrl("https://agentpay-web.onrender.com/consent/cs_01ABC")).toBe("cs_01ABC");
    expect(consentSessionIdFromUrl("https://agentpay-web.onrender.com/revocar/cs_01ABC")).toBeUndefined();
    expect(consentSessionIdFromUrl("not a url")).toBeUndefined();
  });

  it("compares page text, not escaped markup", () => {
    expect(unescapeHtml("&lt;b&gt; &quot;x&quot; &#39;y&#39;")).toBe("<b> \"x\" 'y'");
    expect(pageSays("<p>El comercio no &quot;ofrece&quot; eso.</p>", 'El comercio no "ofrece" eso.')).toBe(true);
  });
});

describe("checks", () => {
  it("passes a code only when it is one of the accepted ones", () => {
    expect(checkCode("x", "MandateRevoked", ["MandateRevoked"]).status).toBe("pass");
    expect(checkCode("x", "MandateNotFound", ["MandateRevoked"])).toMatchObject({
      status: "fail",
      observed: "MandateNotFound",
    });
    expect(checkCode("x", null, ["MandateRevoked"])).toMatchObject({ status: "fail", observed: "(ninguno)" });
  });

  it("tallies pass, fail and declared separately", () => {
    const checks = [
      checkThat("a", true, "", ""),
      checkThat("b", false, "", ""),
      declared("c", "tests"),
      declared("d", "tests"),
    ];
    expect(tally(checks)).toEqual({ pass: 1, fail: 1, declared: 2 });
  });
});

describe("personaEmail", () => {
  it("builds an address on the reserved example.test domain that RealOps accepts", () => {
    const email = personaEmail("01M2XYZ", "A");
    expect(email).toBe("t85-01m2xyz-a@example.test");
    expect(email).toMatch(/^[^@\s]+@[^@\s]+\.[^@\s]+$/);
  });
});

describe("redact", () => {
  it("removes every occurrence of each secret", () => {
    expect(redact('{"h":"Bearer sk_live_12345678","again":"sk_live_12345678"}', ["sk_live_12345678"])).toBe(
      '{"h":"Bearer [redactado]","again":"[redactado]"}',
    );
  });

  it("ignores values too short to be a secret, so it cannot shred the evidence", () => {
    expect(redact('{"a":"1"}', ["1", ""])).toBe('{"a":"1"}');
  });
});
