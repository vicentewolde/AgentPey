import type { ReceiptVerification } from "@vitrinee/anchor";
import { describe, expect, it } from "vitest";

import { receiptPage } from "./receipt-page.js";

const failed = { ok: false, reason: "no <script>x</script> here" };

/** A verification as `verifyReceipt` returns it for a receipt that cannot be read at all. */
function unreadable(): ReceiptVerification {
  return {
    valid: false,
    hash: 'ab"<cd',
    receipt: null,
    checks: { signature: failed, anchored: failed, settlement: failed },
  } as unknown as ReceiptVerification;
}

describe("receiptPage (T154)", () => {
  it("renders a receipt that failed every check, in red, without a table and with every value escaped", () => {
    for (const lang of ["en", "es"] as const) {
      const html = receiptPage({ orderId: "ord_<1>", verification: unreadable(), lang });
      expect(html).toContain('class="verdict bad"');
      expect(html.match(/class="check bad"/g)).toHaveLength(3);
      expect(html).not.toContain("<table");
      expect(html).not.toContain("<script");
      expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
      expect(html).toContain("ord_&lt;1&gt;");
      expect(html).toContain("ab&quot;&lt;cd");
      expect(html).not.toContain("—");
    }
  });

  it("adds a fourth check, held, for a receipt paid into the store's escrow (T159)", () => {
    const ok = { ok: true };
    const held = (heldOk: boolean): ReceiptVerification =>
      ({
        valid: heldOk,
        hash: "ab".repeat(32),
        receipt: null,
        checks: { signature: ok, anchored: ok, settlement: ok, held: { ok: heldOk, escrow: "C", ...(heldOk ? {} : { reason: "the escrow holds another receipt for this payment" }) } },
      }) as unknown as ReceiptVerification;
    const good = receiptPage({ orderId: "ord_1", verification: held(true), lang: "en" });
    expect(good).toContain("all four checks pass");
    expect(good.match(/class="check ok"/g)).toHaveLength(4);
    expect(good).toContain("Held for this receipt");
    expect(good).toContain("into the store&#39;s escrow");
    const bad = receiptPage({ orderId: "ord_1", verification: held(false), lang: "es" });
    expect(bad).toContain("Retenido para este recibo");
    expect(bad).toContain("the escrow holds another receipt for this payment");
    expect(bad).not.toContain("—");
  });
});
