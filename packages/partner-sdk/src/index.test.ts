import { AgentPassError, hasErrorCode } from "@agentpass/core";
import { successEnvelope } from "@agentpey/partner-api";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";

import { createPartnerClient } from "./index.js";

const API_KEY = "ap_test_test-key";
const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TENANT_ID = `ptn_${ULID}:${ULID}`;
const AGENT_ID = `agt_${ULID}`;
const CONSENT_SESSION_ID = `cns_${ULID}`;
const MANDATE_ID = `mdt_${ULID}`;
const ADDRESS = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

const tenant = {
  id: TENANT_ID,
  external_ref: "cloudops-workspace-1",
  label: "CloudOps",
  status: "active",
  created_at: "2026-09-10T00:00:00.000Z",
};

const agent = {
  id: AGENT_ID,
  tenant_id: TENANT_ID,
  address: ADDRESS,
  did: `did:stellar:testnet:${ADDRESS}`,
  label: null,
  status: "active",
  onchain_state: "derived",
  created_at: "2026-09-10T00:00:00.000Z",
};

const consentSession = {
  id: CONSENT_SESSION_ID,
  tenant_id: TENANT_ID,
  status: "pending",
  consent_url: "https://agentpay.test/consent/session-1",
  // T81: the server always sends it, null when the partner asked for no
  // redirect. Required-and-nullable, like the two fields around it.
  return_url: null,
  mandate_id: null,
  created_at: "2026-09-10T00:00:00.000Z",
  expires_at: "2026-09-10T01:00:00.000Z",
};

const mandate = {
  id: MANDATE_ID,
  tenant_id: TENANT_ID,
  agent_id: AGENT_ID,
  mandate_hash: "a".repeat(64),
  status: "active",
  valid_from: "2026-09-10T00:00:00.000Z",
  valid_until: "2026-12-01T00:00:00.000Z",
  anchor_tx: "abc123",
  revoked_at: null,
  supersedes_id: null,
  created_at: "2026-09-10T00:00:00.000Z",
};

const consentSessionInput = {
  tenant_id: TENANT_ID,
  grant: {
    actions: ["catalog:read"],
    venues: ["mock-bazaar:CCL57L4ZQVQCGTQKGQMOAX7QDPEDW4LX2QSPBQMTMLB7BFQ7I3TM7F4A"],
    assets: [`USDC:${ADDRESS}`],
    limits: { perTx: "50.0000000", perDay: "200.0000000", currency: "USDC" },
    payTo: [ADDRESS],
  },
  valid_until: "2026-12-01T00:00:00.000Z",
};

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

interface TestServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

async function startServer(handler: Handler): Promise<TestServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new AgentPassError("NetworkError", "test server did not receive a TCP address");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))));
    },
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

describe("createPartnerClient", () => {
  it("calls every /v1 route with bearer auth and validates its success envelope", async () => {
    const requests: Array<{ readonly url: string; readonly authorization: string | undefined }> = [];
    const server = await startServer((request, response) => {
      requests.push({ url: request.url ?? "", authorization: request.headers.authorization });
      if (request.method === "POST" && request.url === "/v1/tenants") return sendJson(response, 201, successEnvelope(tenant));
      if (request.method === "GET" && request.url === `/v1/tenants/${encodeURIComponent(TENANT_ID)}`) {
        return sendJson(response, 200, successEnvelope(tenant));
      }
      if (request.method === "GET" && request.url === `/v1/agents?tenant_id=${encodeURIComponent(TENANT_ID)}`) {
        return sendJson(response, 200, successEnvelope([agent]));
      }
      if (request.method === "POST" && request.url === "/v1/consent_sessions") {
        return sendJson(response, 201, successEnvelope(consentSession));
      }
      if (request.method === "GET" && request.url === `/v1/consent_sessions/${CONSENT_SESSION_ID}`) {
        return sendJson(response, 200, successEnvelope(consentSession));
      }
      if (request.method === "GET" && request.url === `/v1/mandates/${MANDATE_ID}`) return sendJson(response, 200, successEnvelope(mandate));
      if (request.method === "GET" && request.url === `/v1/mandates?tenant_id=${encodeURIComponent(TENANT_ID)}`) {
        return sendJson(response, 200, successEnvelope([mandate]));
      }
      return sendJson(response, 404, { ok: false, code: "TenantNotFound", message: "not found", details: {} });
    });

    try {
      const client = createPartnerClient({ apiKey: API_KEY, baseUrl: server.baseUrl });
      await expect(client.createTenant({ external_ref: tenant.external_ref, label: tenant.label })).resolves.toEqual(tenant);
      await expect(client.getTenant(TENANT_ID)).resolves.toEqual(tenant);
      await expect(client.listAgents(TENANT_ID)).resolves.toEqual([agent]);
      await expect(client.createConsentSession(consentSessionInput)).resolves.toEqual(consentSession);
      await expect(client.getConsentSession(CONSENT_SESSION_ID)).resolves.toEqual(consentSession);
      await expect(client.getMandate(MANDATE_ID)).resolves.toEqual(mandate);
      await expect(client.listMandates(TENANT_ID)).resolves.toEqual([mandate]);

      expect(requests).toHaveLength(7);
      expect(requests.map((request) => request.authorization)).toEqual(Array(7).fill(`Bearer ${API_KEY}`));
    } finally {
      await server.close();
    }
  });

  it("refuses a consent session whose grant names no payee, without calling the API (C-123)", async () => {
    let calls = 0;
    const server = await startServer((_request, response) => {
      calls += 1;
      return sendJson(response, 201, successEnvelope(consentSession));
    });

    try {
      const client = createPartnerClient({ apiKey: API_KEY, baseUrl: server.baseUrl });
      const { payTo: _payTo, ...grant } = consentSessionInput.grant;
      await expect(
        client.createConsentSession({ ...consentSessionInput, grant } as unknown as typeof consentSessionInput),
      ).rejects.toMatchObject({ code: "InvalidArguments" });
      expect(calls).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("adds an idempotency key for POST requests and accepts an explicit key", async () => {
    const keys: string[] = [];
    const server = await startServer((request, response) => {
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey === "string") keys.push(idempotencyKey);
      if (request.url === "/v1/tenants") return sendJson(response, 201, successEnvelope(tenant));
      return sendJson(response, 201, successEnvelope(consentSession));
    });

    try {
      const client = createPartnerClient({ apiKey: API_KEY, baseUrl: server.baseUrl });
      await client.createTenant({ external_ref: tenant.external_ref, label: null });
      await client.createConsentSession(consentSessionInput, { idempotencyKey: "caller-supplied-key" });

      expect(keys).toHaveLength(2);
      expect(keys[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(keys[1]).toBe("caller-supplied-key");
    } finally {
      await server.close();
    }
  });

  it("maps 401 and 403 partner envelopes to their AgentPassError codes", async () => {
    const server = await startServer((request, response) => {
      if (request.url?.endsWith("unauthorized")) {
        return sendJson(response, 401, { ok: false, code: "InvalidApiKey", message: "invalid key", details: {} });
      }
      return sendJson(response, 403, { ok: false, code: "ScopeNotGranted", message: "missing scope", details: {} });
    });

    try {
      const client = createPartnerClient({ apiKey: API_KEY, baseUrl: server.baseUrl });
      await expect(client.getTenant("unauthorized")).rejects.toSatisfy((error: unknown) => hasErrorCode(error, "InvalidApiKey"));
      await expect(client.getTenant("forbidden")).rejects.toSatisfy((error: unknown) => hasErrorCode(error, "ScopeNotGranted"));
    } finally {
      await server.close();
    }
  });

  it("times out a stalled native fetch without leaving the test server open", async () => {
    const server = await startServer(() => {
      // Deliberately never send a response: the client's AbortController must settle the call.
    });

    try {
      const client = createPartnerClient({ apiKey: API_KEY, baseUrl: server.baseUrl, timeoutMs: 25 });
      await expect(client.getTenant("timeout")).rejects.toSatisfy((error: unknown) => hasErrorCode(error, "NetworkError"));
    } finally {
      await server.close();
    }
  });

  it("rejects a malformed success response as a typed network error", async () => {
    const server = await startServer((_request, response) => sendJson(response, 200, { ok: true, data: { id: "wrong" } }));

    try {
      const client = createPartnerClient({ apiKey: API_KEY, baseUrl: server.baseUrl });
      await expect(client.getTenant(TENANT_ID)).rejects.toSatisfy((error: unknown) => hasErrorCode(error, "NetworkError"));
    } finally {
      await server.close();
    }
  });
});
