import { describe, expect, it } from "vitest";

import { isVitrineeError } from "./errors.js";
import {
  STELLAR_X402_HANDLER,
  STELLAR_X402_SCHEMA_URL,
  STELLAR_X402_SPEC_URL,
  UCP_CATALOG_SEARCH,
  UCP_SPEC_URLS,
  namespaceAuthority,
  originMatchesNamespace,
  stellarX402BusinessConfigSchema,
  toMinorUnits,
} from "./ucp.js";

describe("namespaceAuthority", () => {
  it("reverses the first two labels of a UCP name", () => {
    expect(namespaceAuthority("com.agentpey.stellar_x402")).toBe("agentpey.com");
    expect(namespaceAuthority("dev.ucp.shopping.catalog.search")).toBe("ucp.dev");
  });

  it("rejects a name with no domain", () => {
    expect(() => namespaceAuthority("checkout")).toThrowError(/reverse-domain/);
    let thrown: unknown;
    try {
      namespaceAuthority("");
    } catch (error) {
      thrown = error;
    }
    expect(isVitrineeError(thrown) && thrown.code).toBe("ValidationError");
  });
});

describe("originMatchesNamespace", () => {
  it("accepts the URLs this project publishes under its own names", () => {
    expect(originMatchesNamespace(STELLAR_X402_HANDLER, STELLAR_X402_SPEC_URL)).toBe(true);
    expect(originMatchesNamespace(STELLAR_X402_HANDLER, STELLAR_X402_SCHEMA_URL)).toBe(true);
    expect(originMatchesNamespace(UCP_CATALOG_SEARCH, UCP_SPEC_URLS.catalogSearch.spec)).toBe(true);
    expect(originMatchesNamespace(UCP_CATALOG_SEARCH, UCP_SPEC_URLS.catalogSearch.schema)).toBe(true);
  });

  it("rejects a handler whose spec is hosted by someone else", () => {
    expect(originMatchesNamespace("com.agentpey.stellar_x402", "https://evil.example/ucp/handlers/stellar-x402/spec")).toBe(false);
    // A subdomain, a look-alike suffix and a path that merely mentions the host are all different origins.
    expect(originMatchesNamespace("com.agentpey.stellar_x402", "https://docs.agentpey.com/spec")).toBe(false);
    expect(originMatchesNamespace("com.agentpey.stellar_x402", "https://agentpey.com.evil.example/spec")).toBe(false);
    expect(originMatchesNamespace("com.agentpey.stellar_x402", "https://evil.example/agentpey.com/spec")).toBe(false);
  });

  it("rejects plain http, a custom port and a string that is not a URL", () => {
    expect(originMatchesNamespace("com.agentpey.stellar_x402", "http://agentpey.com/spec")).toBe(false);
    expect(originMatchesNamespace("com.agentpey.stellar_x402", "https://agentpey.com:8443/spec")).toBe(false);
    expect(originMatchesNamespace("com.agentpey.stellar_x402", "not a url")).toBe(false);
  });
});

describe("toMinorUnits", () => {
  it("expresses a local price as the integer UCP asks for", () => {
    expect(toMinorUnits("34990", "CLP")).toBe(34990);
    expect(toMinorUnits("12.50", "USD")).toBe(1250);
    expect(toMinorUnits("0", "CLP")).toBe(0);
  });

  it("refuses an amount a JSON number cannot hold exactly", () => {
    expect(() => toMinorUnits("9007199254740993", "CLP")).toThrowError(/too large/);
  });

  it("refuses more decimals than the currency has, and an unknown currency", () => {
    expect(() => toMinorUnits("10.5", "CLP")).toThrow();
    expect(() => toMinorUnits("10", "XXX")).toThrowError(/unsupported currency/);
  });
});

describe("stellarX402BusinessConfigSchema", () => {
  const config = {
    x402_version: 2,
    scheme: "exact",
    network: "stellar:testnet",
    asset: { code: "USDC", contract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", decimals: 7 },
    pay_to: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    facilitator: "https://channels.openzeppelin.com/x402/testnet",
  };

  it("accepts the config a storefront publishes", () => {
    expect(stellarX402BusinessConfigSchema.parse(config)).toEqual(config);
  });

  it("rejects a contract address as pay_to and any unknown field", () => {
    expect(stellarX402BusinessConfigSchema.safeParse({ ...config, pay_to: config.asset.contract }).success).toBe(false);
    expect(stellarX402BusinessConfigSchema.safeParse({ ...config, secret: "S..." }).success).toBe(false);
  });
});
