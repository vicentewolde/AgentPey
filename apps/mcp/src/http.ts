/**
 * The HTTP face of AgentPey's MCP server (T128): Streamable HTTP at `/mcp`,
 * stateless, one fresh `McpServer` per request.
 *
 * The SDK's handler speaks Web `Request`/`Response`; `bridge` hands it an
 * Express request and streams its answer back, so the server needs neither
 * the Node adapter package nor its framework. Express is the one the SDK's
 * own adapter builds, with JSON parsing and DNS-rebinding protection on.
 */
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { createMcpHandler, type AuthInfo, type McpHttpHandler } from "@modelcontextprotocol/server";
import type { Express, Request, Response } from "express";

import type { Shopper } from "./shopper.js";
import { createAgentPeyMcpServer } from "./tools.js";

export const MCP_PATH = "/mcp";

export interface McpAppOptions {
  readonly shopper: Shopper;
  /** Hostnames the `Host` header may carry. Without it, only localhost. */
  readonly allowedHosts?: readonly string[];
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

export function createMcpApp(options: McpAppOptions): Express {
  const handler = createMcpHandler(() => createAgentPeyMcpServer(options.shopper, options.log));
  const app = createMcpExpressApp(options.allowedHosts === undefined ? {} : { host: "0.0.0.0", allowedHosts: [...options.allowedHosts] });
  app.disable("x-powered-by");
  app.all(MCP_PATH, (req, res) => void bridge(handler, req, res, options.log));
  return app;
}

async function bridge(handler: McpHttpHandler, req: Request, res: Response, log?: McpAppOptions["log"]): Promise<void> {
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(name, value);
      else if (Array.isArray(value)) for (const one of value) headers.append(name, one);
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body !== undefined;
    const request = new Request(new URL(req.originalUrl, `${req.protocol}://${req.get("host") ?? "localhost"}`), {
      method: req.method,
      headers,
      ...(hasBody ? { body: JSON.stringify(req.body) } : {}),
    });
    // Set by the bearer-token middleware once OAuth is in front of this route.
    const auth = (req as Request & { auth?: AuthInfo }).auth;
    const response = await handler.fetch(request, { ...(hasBody ? { parsedBody: req.body as unknown } : {}), ...(auth === undefined ? {} : { authInfo: auth }) });
    res.status(response.status);
    response.headers.forEach((value, name) => res.setHeader(name, value));
    if (response.body === null) {
      res.end();
      return;
    }
    Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>).pipe(res);
  } catch (error) {
    log?.("mcp request failed", { error: error instanceof Error ? error.message : String(error) });
    if (!res.headersSent) res.status(500).json({ error: "InternalError" });
    else res.end();
  }
}
