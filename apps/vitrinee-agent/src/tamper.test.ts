import { describe, expect, it } from "vitest";

import { tamperAmount } from "./tamper.js";

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");

describe("tamperAmount", () => {
  it("lowers the amount tenfold and keeps header and signature", () => {
    const jws = `${b64({ alg: "EdDSA" })}.${b64({ amountUSDC: "1.0421053", amountUSDCAtomic: "10421053", orderId: "ord_1" })}.c2lnbmF0dXJl`;
    const t = tamperAmount(jws);
    expect(t).toMatchObject({ from: "1.0421053", to: "0.1042105" });
    const [h, p, s] = t.jws.split(".");
    expect(h).toBe(jws.split(".")[0]);
    expect(s).toBe("c2lnbmF0dXJl");
    expect(JSON.parse(Buffer.from(p!, "base64url").toString())).toEqual({ amountUSDC: "0.1042105", amountUSDCAtomic: "1042105", orderId: "ord_1" });
  });
});
