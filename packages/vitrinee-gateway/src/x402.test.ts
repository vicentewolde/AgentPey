import { describe, expect, it } from "vitest";

import { withoutQuery } from "./x402.js";

describe("withoutQuery", () => {
  it("drops the query and the fragment, and leaves a bare URL alone", () => {
    expect(withoutQuery("https://t.test/checkout/7?name=Ana&address=Calle%201")).toBe("https://t.test/checkout/7");
    expect(withoutQuery("https://t.test/checkout/7#x")).toBe("https://t.test/checkout/7");
    expect(withoutQuery("https://t.test/checkout/7")).toBe("https://t.test/checkout/7");
    expect(withoutQuery("https://t.test/checkout/a%3Fb?q=1")).toBe("https://t.test/checkout/a%3Fb");
  });
});
