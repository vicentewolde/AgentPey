import { describe, expect, it } from "vitest";

import { jcsCanonicalize } from "./jcs.js";

describe("JCS, RFC 8785 (T134)", () => {
  it("canonicalizes the RFC's own example (§3.2.3)", () => {
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}',
    ) as unknown;
    expect(jcsCanonicalize(input)).toBe('{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}');
  });

  it("sorts member names by UTF-16 code units (§3.2.3, sorting example)", () => {
    const input = JSON.parse('{"\\u20ac":"Euro Sign","\\r":"Carriage Return","\\ufb33":"Hebrew Letter Dalet With Dagesh","1":"One","\\ud83d\\ude00":"Emoji: Grinning Face","\\u0080":"Control","\\u00f6":"Latin Small Letter O With Diaeresis"}') as Record<string, string>;
    // Read the order from the text: JSON.parse would move the integer-like key "1" first.
    const values = [...jcsCanonicalize(input).matchAll(/:"([^"]*)"/g)].map((m) => m[1]);
    expect(values).toEqual([
      "Carriage Return",
      "One",
      "Control",
      "Latin Small Letter O With Diaeresis",
      "Euro Sign",
      "Emoji: Grinning Face",
      "Hebrew Letter Dalet With Dagesh",
    ]);
  });

  it("writes nested values with no whitespace, and leaves out undefined members as JSON.stringify does", () => {
    expect(jcsCanonicalize({ b: [1, { d: true, c: null }], a: "x", z: undefined })).toBe('{"a":"x","b":[1,{"c":null,"d":true}]}');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, "\uD800", 10n, () => 1])("refuses %s", (value) => {
    expect(() => jcsCanonicalize(value)).toThrow();
  });
});
