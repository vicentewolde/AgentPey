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

import { createMcpExpressApp, getOAuthProtectedResourceMetadataUrl, mcpAuthMetadataRouter, requireBearerAuth } from "@modelcontextprotocol/express";
import { createMcpHandler, type AuthInfo, type McpHttpHandler } from "@modelcontextprotocol/server";
import type { Express, NextFunction, Request, Response } from "express";

import { MCP_SCOPE, type OAuthServer } from "./oauth/server.js";
import type { Shopper } from "./shopper.js";
import { createAgentPeyMcpServer } from "./tools.js";

export const MCP_PATH = "/mcp";

export interface McpAuth {
  readonly oauth: OAuthServer;
  /** The protected resource: this server's public URL plus `/mcp`. */
  readonly resource: string;
  /** Tests on plain-HTTP localhost only. */
  readonly allowInsecureIssuer?: boolean;
}

export interface McpAppOptions {
  readonly shopper: Shopper;
  /**
   * OAuth in front of `/mcp` (`R-2`). Not optional: a server that pays has to
   * say out loud that it runs without it, and only tests do.
   */
  readonly auth: McpAuth | "none-for-tests";
  /** Hostnames the `Host` header may carry. Without it, only localhost. */
  readonly allowedHosts?: readonly string[];
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

export function createMcpApp(options: McpAppOptions): Express {
  const handler = createMcpHandler(() => createAgentPeyMcpServer(options.shopper, options.log));
  const app = createMcpExpressApp(options.allowedHosts === undefined ? {} : { host: "0.0.0.0", allowedHosts: [...options.allowedHosts] });
  app.disable("x-powered-by");
  if (options.auth === "none-for-tests") {
    app.all(MCP_PATH, (req, res) => void bridge(handler, req, res, options.log));
    app.use(jsonErrors(options.log));
    return app;
  }
  const { oauth, resource } = options.auth;
  const resourceUrl = new URL(resource);
  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata: oauth.metadata,
      resourceServerUrl: resourceUrl,
      scopesSupported: [MCP_SCOPE],
      resourceName: "AgentPey",
      ...(options.auth.allowInsecureIssuer === true ? { dangerouslyAllowInsecureIssuerUrl: true } : {}),
    }),
  );
  app.use(oauth.router);
  const bearer = requireBearerAuth({ verifier: oauth.verifier, requiredScopes: [MCP_SCOPE], resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl) });
  app.all(MCP_PATH, bearer, (req, res) => void bridge(handler, req, res, options.log));
  app.use(jsonErrors(options.log));
  return app;
}

/**
 * Every error Express would otherwise render as an HTML page with its stack
 * (a malformed JSON body, most often) answers as an OAuth-shaped JSON error
 * instead. The gateway does not set `NODE_ENV`, so Express runs in its
 * development mode and would show the stack in production too.
 */
function jsonErrors(log?: McpAppOptions["log"]) {
  return (error: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) return next(error);
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 500;
    if (status >= 500) log?.("request failed", { error: error instanceof Error ? error.message : String(error) });
    res
      .status(status >= 400 && status < 600 ? status : 500)
      .set("Cache-Control", "no-store")
      .json(status < 500 ? { error: "invalid_request", error_description: "the request body is malformed" } : { error: "server_error" });
  };
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
