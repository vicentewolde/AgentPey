/**
 * Exercises `proxyRequest` against a real HTTP server standing in for a
 * spawned app — the only way to see that a `Host` header, a method, and a
 * request body all survive the hop, and that the upstream's own status and
 * body come back unchanged.
 *
 * Deliberately not `fetch`: the Fetch spec forbids a caller from setting its
 * own `Host` header (Node's implementation enforces that too), and the one
 * thing this module exists to prove is that the *original* `Host` header
 * survives the proxy. `node:http`'s own client has no such restriction.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { proxyRequest } from "./proxy.js";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** A minimal client that, unlike fetch, can set an arbitrary Host header. */
function requestWithHost(
  port: number,
  options: { readonly method?: string; readonly path?: string; readonly host: string; readonly body?: string },
): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: options.path ?? "/",
        method: options.method ?? "GET",
        headers: { host: options.host, "content-type": "text/plain" },
      },
      (res: IncomingMessage) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

describe("proxyRequest", () => {
  let upstream: Server | undefined;
  let gateway: Server | undefined;

  afterEach(async () => {
    if (upstream !== undefined) await close(upstream);
    if (gateway !== undefined) await close(gateway);
    upstream = undefined;
    gateway = undefined;
  });

  it("forwards the original Host header, not the internal address it proxied through", async () => {
    upstream = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(req.headers.host ?? "");
    });
    const upstreamPort = await listen(upstream);

    gateway = createServer((req, res) => proxyRequest(req, res, { host: "127.0.0.1", port: upstreamPort }));
    const gatewayPort = await listen(gateway);

    const result = await requestWithHost(gatewayPort, { host: "realops.agentpey.com" });
    expect(result).toEqual({ status: 200, body: "realops.agentpey.com" });
  });

  it("forwards method, path and body unchanged", async () => {
    upstream = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ method: req.method, url: req.url, body }));
      });
    });
    const upstreamPort = await listen(upstream);

    gateway = createServer((req, res) => proxyRequest(req, res, { host: "127.0.0.1", port: upstreamPort }));
    const gatewayPort = await listen(gateway);

    const result = await requestWithHost(gatewayPort, {
      host: "agentpey.com",
      method: "POST",
      path: "/v1/purchases",
      body: "hola",
    });

    expect(result.status).toBe(201);
    expect(JSON.parse(result.body)).toEqual({ method: "POST", url: "/v1/purchases", body: "hola" });
  });

  it("answers 502 instead of hanging when nothing is listening on the target port", async () => {
    gateway = createServer((req, res) => proxyRequest(req, res, { host: "127.0.0.1", port: 1 }));
    const gatewayPort = await listen(gateway);

    const result = await requestWithHost(gatewayPort, { host: "agentpey.com" });
    expect(result.status).toBe(502);
  });
});
