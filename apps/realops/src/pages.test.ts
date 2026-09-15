import { describe, expect, it } from "vitest";

import { bilingual } from "./copy.js";
import { errorPage, formatAmount, localTime } from "./pages.js";

describe("the page script", () => {
  /** `toLocaleString` throws on this combination, and the times would silently stay in UTC. */
  it("does not combine timeZoneName with dateStyle or timeStyle", () => {
    const html = errorPage(404, bilingual("x", "x"));

    expect(html).toContain("timeZoneName");
    expect(html).not.toContain("dateStyle");
    expect(html).not.toContain("timeStyle");
  });
});

describe("formatAmount", () => {
  it("shows at most three decimals and at least two", () => {
    expect(formatAmount("0.5000000")).toBe("0.50");
    expect(formatAmount("0.2500000")).toBe("0.25");
    expect(formatAmount("0.1234567")).toBe("0.123");
    expect(formatAmount("0.60")).toBe("0.60");
    expect(formatAmount("32.6840000")).toBe("32.684");
    expect(formatAmount("1")).toBe("1.00");
  });

  it("does not invent a number from something that is not one", () => {
    expect(formatAmount(null)).toBe("?");
    expect(formatAmount("")).toBe("");
    expect(formatAmount("<b>")).toBe("&lt;b&gt;");
  });
});

describe("localTime", () => {
  it("carries the exact moment for the browser to localise, and a labelled UTC fallback", () => {
    expect(localTime("2026-09-12T21:11:22.000Z")).toBe(
      '<time datetime="2026-09-12T21:11:22.000Z" data-local>2026-09-12 21:11 UTC</time>',
    );
  });

  it("escapes what it is given", () => {
    expect(localTime('"><script>')).not.toContain("<script>");
  });
});
