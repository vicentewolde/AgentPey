import { hasErrorCode } from "@agentpass/core";
import { describe, expect, it } from "vitest";

import {
  assertWebhookUrlResolvesPublicly,
  assertWebhookUrlShape,
  isPrivateAddress,
} from "./webhook-url.js";

/** The check has one job, and a miss is an outbound request this process makes on someone else's behalf. */
describe("isPrivateAddress", () => {
  it("knows the ranges the public internet does not route to", () => {
    for (const address of [
      "127.0.0.1", // loopback — the sibling apps `apps/gateway` starts
      "127.1.2.3", // the whole /8, not just .0.1
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // the cloud metadata endpoint
      "100.64.0.1", // carrier-grade NAT
      "0.0.0.0",
      "255.255.255.255",
      "224.0.0.1", // multicast
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it("lets ordinary public addresses through", () => {
    for (const address of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "172.32.0.1", "172.15.0.1", "192.167.0.1"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("does not fall for the boundaries of the private ranges", () => {
    // `172.16.0.0/12` is 172.16 through 172.31. The two neighbours are public,
    // and an off-by-one here is a hole rather than a nuisance.
    expect(isPrivateAddress("172.16.0.0")).toBe(true);
    expect(isPrivateAddress("172.31.0.0")).toBe(true);
    expect(isPrivateAddress("172.15.255.255")).toBe(false);
    expect(isPrivateAddress("172.32.0.0")).toBe(false);
  });

  it("knows the IPv6 equivalents", () => {
    for (const address of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("sees through v4-mapped IPv6, which is loopback wearing a different hat", () => {
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("calls anything it cannot read private, rather than letting it through", () => {
    // Fail-closed: this is only ever handed resolved addresses, so a value
    // that is not one means something upstream is wrong.
    expect(isPrivateAddress("not-an-address")).toBe(true);
    expect(isPrivateAddress("")).toBe(true);
  });
});

describe("assertWebhookUrlShape", () => {
  function refusalFor(url: string): string {
    try {
      assertWebhookUrlShape(url);
      return expect.unreachable(`expected ${url} to be refused`);
    } catch (error) {
      expect(hasErrorCode(error, "WebhookUrlNotAllowed")).toBe(true);
      return (error as Error).message;
    }
  }

  it("accepts an ordinary https endpoint", () => {
    expect(assertWebhookUrlShape("https://partner.example/hooks/agentpey")).toEqual({
      url: "https://partner.example/hooks/agentpey",
      hostname: "partner.example",
    });
  });

  it("refuses http, because the body is signed but not hidden", () => {
    expect(refusalFor("http://partner.example/hooks")).toContain("https");
  });

  it("refuses credentials in the URL, which end up in logs", () => {
    expect(refusalFor("https://user:pass@partner.example/hooks")).toContain("credentials");
  });

  it("refuses a non-default port, which is how an inward URL reaches something interesting", () => {
    expect(refusalFor("https://partner.example:5432/hooks")).toContain("port");
    // 443 is the default and may be written out.
    expect(assertWebhookUrlShape("https://partner.example:443/hooks").hostname).toBe("partner.example");
  });

  it("refuses a literal IP address, because delivery-time re-resolution cannot catch one", () => {
    expect(refusalFor("https://169.254.169.254/latest/meta-data/")).toContain("not an IP address");
    expect(refusalFor("https://127.0.0.1/hooks")).toContain("not an IP address");
    expect(refusalFor("https://[::1]/hooks")).toContain("not an IP address");
  });

  it("refuses a bare or .localhost name, which only resolves inside a private network", () => {
    expect(refusalFor("https://localhost/hooks")).toContain("public host");
    expect(refusalFor("https://internal-api/hooks")).toContain("public host");
    expect(refusalFor("https://app.localhost/hooks")).toContain("public host");
  });

  it("refuses something that is not a URL at all", () => {
    expect(refusalFor("not a url")).toContain("not a URL");
  });
});

describe("assertWebhookUrlResolvesPublicly", () => {
  it("passes a name that resolves only to public addresses", async () => {
    await expect(
      assertWebhookUrlResolvesPublicly("partner.example", async () => ["93.184.216.34"]),
    ).resolves.toBeUndefined();
  });

  it("refuses a name that resolves inward — the attack a registration-time check cannot see", async () => {
    // `partner.example` passed every shape check the day it was registered.
    // Its owner repointed it at the metadata endpoint afterwards, which is
    // exactly why this runs at delivery and not only at registration.
    await expect(
      assertWebhookUrlResolvesPublicly("partner.example", async () => ["169.254.169.254"]),
    ).rejects.toSatisfy((error: unknown) => hasErrorCode(error, "WebhookUrlNotAllowed"));
  });

  it("refuses when any address is private, not only when all of them are", async () => {
    // A name answering with one public and one private address is a name whose
    // next connection could go either way.
    await expect(
      assertWebhookUrlResolvesPublicly("partner.example", async () => ["93.184.216.34", "127.0.0.1"]),
    ).rejects.toSatisfy((error: unknown) => hasErrorCode(error, "WebhookUrlNotAllowed"));
  });

  it("names the offending addresses, so an operator can tell a mistake from a probe", async () => {
    try {
      await assertWebhookUrlResolvesPublicly("partner.example", async () => ["10.0.0.5"]);
      expect.unreachable("expected a refusal");
    } catch (error) {
      expect((error as { details: { addresses: string[] } }).details.addresses).toEqual(["10.0.0.5"]);
    }
  });

  it("refuses a name that resolves to nothing", async () => {
    await expect(assertWebhookUrlResolvesPublicly("partner.example", async () => [])).rejects.toSatisfy(
      (error: unknown) => hasErrorCode(error, "WebhookUrlNotAllowed"),
    );
  });

  it("refuses a name that cannot be resolved, rather than sending anyway", async () => {
    await expect(
      assertWebhookUrlResolvesPublicly("partner.example", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toSatisfy((error: unknown) => hasErrorCode(error, "WebhookUrlNotAllowed"));
  });
});
