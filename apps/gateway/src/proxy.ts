/**
 * Forwarding one HTTP request to whichever internal app answers for it.
 *
 * **Why the `Host` header is never rewritten.** `apps/web/src/server.ts`'s
 * `resolveBaseUrl` infers this deployment's own public origin from the
 * request's `Host` header when `PUBLIC_BASE_URL` is not set — the same trick
 * every one of the three apps could use once they no longer sit on their own
 * dedicated hostname. Proxying to `127.0.0.1:<port>` while forwarding the
 * *original* `Host` header (`realops.agentpey.com`, say) is what lets that
 * keep working unchanged: the app on the other end sees exactly what the
 * browser sent, not the internal address it happens to be reachable at.
 */
import { request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface ProxyTarget {
  readonly host: string;
  readonly port: number;
}

/**
 * Streams `req` straight through to `target` and streams the response
 * straight back — no buffering, so a large upload or a slow response does not
 * sit in memory here.
 *
 * A failure to reach `target` (the child not started yet, or crashed) answers
 * `502` rather than hanging the request, and never after `res` has already
 * started sending a body — a response cannot un-start once headers are on
 * the wire.
 */
export function proxyRequest(req: IncomingMessage, res: ServerResponse, target: ProxyTarget): void {
  const upstream = httpRequest(
    { host: target.host, port: target.port, path: req.url, method: req.method, headers: req.headers },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end("bad gateway: the internal service did not answer\n");
  });
  req.pipe(upstream);
}
