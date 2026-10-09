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
});
