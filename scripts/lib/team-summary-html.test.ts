import { describe, expect, it } from "vitest";

import { dayRows, displayAmount, escapeHtml, renderSummaryHtml } from "./team-summary-html.js";
import type { MonthSummary } from "./team-summary.js";

const tx = (c: string) => c.repeat(64);

const summary: MonthSummary = {
  month: "2026-10",
  currency: "USDC",
  spent: "0.6000000",
  activeDays: 2,
  payments: [
    { intentId: "a", amount: "0.1000000", currency: "USDC", at: "2026-10-07T18:10:00.000Z", paymentTx: tx("1"), anchorTx: tx("9"), released: false },
    { intentId: "b", amount: "0.1000000", currency: "USDC", at: "2026-10-07T18:10:30.000Z", paymentTx: tx("2"), anchorTx: tx("9"), released: false },
    { intentId: "c", amount: "0.1000000", currency: "USDC", at: "2026-10-07T18:11:00.000Z", paymentTx: tx("3"), anchorTx: tx("9"), released: false },
    { intentId: "d", amount: "0.1000000", currency: "USDC", at: "2026-10-08T16:17:00.000Z", paymentTx: null, anchorTx: null, released: false },
    { intentId: "e", amount: "0.1000000", currency: "USDC", at: "2026-10-08T16:18:00.000Z", paymentTx: "not-a-hash", anchorTx: null, released: false },
    { intentId: "f", amount: "0.1000000", currency: "USDC", at: "2026-10-08T16:19:00.000Z", paymentTx: tx("4"), anchorTx: null, released: true },
  ],
  refusals: [{ intentId: "g", code: "ScopeDailyLimitExceeded", reason: "over <b>budget</b>", at: "2026-10-07T18:11:30.000Z" }],
};

describe("dayRows (T153)", () => {
  it("adds each UTC day's paid purchases against the daily budget, leaving released ones out", () => {
    expect(dayRows(summary, "0.30")).toEqual([
      { day: "2026-10-07", spent: "0.3000000", payments: 3, refusals: 1, percent: 100 },
      { day: "2026-10-08", spent: "0.2000000", payments: 2, refusals: 0, percent: 66.66 },
    ]);
  });

  it("does not hide a day above the budget behind a full bar", () => {
    const over = { ...summary, payments: summary.payments.slice(0, 3), refusals: [] };
    expect(dayRows(over, "0.20")[0]?.percent).toBe(150);
    const html = renderSummaryHtml({ month: "2026-10", summary: over, teamPerTx: "0.10", teamPerDay: "0.20", records: 3, rail: null, generatedAt: new Date() });
    expect(html).toContain('class="fill over" style="width:100.00%"');
    expect(html).toContain("over the budget");
  });
});

describe("renderSummaryHtml (T153)", () => {
  const html = renderSummaryHtml({
    month: "2026-10",
    summary,
    teamPerTx: "0.10",
    teamPerDay: "0.30",
    records: 15,
    rail: { contractId: "CBDRI5B72VWNZGRVUXNMUNOSYWXGB7RZLK5ITRVOVSGOS4VXPCRMD3YA", perTx: "5.0000000", perDay: "10.0000000", spentToday: "0.3000000" },
    generatedAt: new Date("2026-10-08T20:00:00Z"),
  });

  it("links every payment with a real transaction hash, and only those", () => {
    for (const c of ["1", "2", "3"]) expect(html).toContain(`https://stellar.expert/explorer/testnet/tx/${tx(c)}`);
    expect(html).not.toContain("tx/not-a-hash");
    // A released payment never settled: it is not listed.
    expect(html).not.toContain(tx("4"));
  });

  it("counts as paid on Stellar only the payments with an anchored transaction, and says so for the rest", () => {
    expect(html).toContain('<b>3</b><span><span data-tr="en">purchases paid on Stellar');
    expect(html).toContain('<b>2</b><span><span data-tr="en">counted by the budget, no anchored transaction');
    expect(html.match(/<span data-tr="en">no anchored transaction<\/span>/g)?.length).toBe(2);
    expect(html).toContain("USDC counted by the budget this month");
    expect(html).not.toContain("Every payment links");
  });

  it("tells how many payments were released and left out", () => {
    expect(html).toContain('1 <span data-tr="en">released: it never reached the network and is not counted.');
  });

  it("escapes what the vault holds, so a refusal reason cannot inject markup", () => {
    expect(html).toContain("over &lt;b&gt;budget&lt;/b&gt;");
    expect(html).not.toContain("<b>budget</b>");
    const hostile: MonthSummary = {
      ...summary,
      currency: "<i>USDC",
      payments: [{ intentId: "x", amount: "0.1000000", currency: "<i>USDC", at: "2026-10-07T<s>x</s>", paymentTx: `"><script>alert(1)</script>`, anchorTx: null, released: false }],
      refusals: [{ intentId: "y", code: "<img src=x>", reason: "r", at: "2026-10-07T<u>" }],
    };
    const page = renderSummaryHtml({ month: "2026-10", summary: hostile, teamPerTx: "0.10", teamPerDay: "0.30", records: 2, rail: null, generatedAt: new Date() });
    for (const raw of ["<i>", "<s>", "<script>alert", "<img", "<u>"]) expect(page).not.toContain(raw);
    expect(page).toContain("&lt;img src=x&gt;");
    expect(escapeHtml(`"<'&>`)).toBe("&quot;&lt;&#39;&amp;&gt;");
  });

  it("says what the budget is, what the rail's on-chain limits are, and has every text in both languages", () => {
    expect(html).toContain("0.30 USDC");
    expect(html).toContain("10.0000000 USDC");
    expect(html.match(/data-tr="es"/g)?.length).toBe(html.match(/data-tr="en"/g)?.length);
    expect(html).not.toContain("—");
  });

  it("says so when the rail could not be read, instead of showing numbers", () => {
    const offline = renderSummaryHtml({ month: "2026-10", summary, teamPerTx: "0.10", teamPerDay: "0.30", records: 15, rail: null, generatedAt: new Date() });
    expect(offline).toContain("could not be read from the network");
    const reason = renderSummaryHtml({ month: "2026-10", summary, teamPerTx: "0.10", teamPerDay: "0.30", records: 15, rail: null, railError: "timeout <30s>", generatedAt: new Date() });
    expect(reason).toContain("<code>timeout &lt;30s&gt;</code>");
  });

  it("says the month had nothing, instead of an empty page", () => {
    const empty: MonthSummary = { month: "2026-11", currency: null, spent: "0.0000000", activeDays: 0, payments: [], refusals: [] };
    const page = renderSummaryHtml({ month: "2026-11", summary: empty, teamPerTx: "0.10", teamPerDay: "0.30", records: 15, rail: null, generatedAt: new Date() });
    expect(page).toContain("No spending this month.");
    expect(page.match(/None this month\./g)?.length).toBe(2);
    expect(page).toContain("USDC spent this month");
  });
});

describe("displayAmount (T153)", () => {
  it("drops trailing zeros but keeps two decimals", () => {
    expect(displayAmount("0.6000000")).toBe("0.60");
    expect(displayAmount("1.5684211")).toBe("1.5684211");
    expect(displayAmount("2.0000000")).toBe("2.00");
    expect(displayAmount("0.1050000")).toBe("0.105");
  });
});

