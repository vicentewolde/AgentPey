/**
 * Free audit requests from the Start-Up Chile page (`/`, `comercios.html`).
 *
 * A Chilean store asks for a free audit of how AI assistants describe it. The
 * request is checked here, stored in one small Postgres table and read by the
 * operator; nothing is sent anywhere. This lives apart from the Stellar code on
 * purpose: the page and this endpoint are for the Start-Up Chile application,
 * and must not touch the Fase 10 sprint.
 */
import { AgentPassError } from "@agentpass/core";
import { Pool } from "pg";
import { z } from "zod";

import { logError } from "./logging.js";

export const AUDIT_REQUEST_PATH = "/api/auditoria";

export const PLATFORMS = ["jumpseller", "bsale", "woocommerce", "vtex", "shopify", "otra"] as const;

const auditRequestSchema = z.object({
  nombre: z.string().trim().min(1).max(120),
  tienda: z.string().trim().min(1).max(200),
  plataforma: z.enum(PLATFORMS),
  correo: z.string().trim().max(200).pipe(z.email()),
  mensaje: z.string().trim().max(1000).optional().default(""),
});

export type AuditRequest = z.infer<typeof auditRequestSchema>;

export type ParsedAuditRequest =
  | { readonly kind: "ok"; readonly request: AuditRequest }
  | { readonly kind: "bot" }
  | { readonly kind: "invalid"; readonly fields: readonly string[] };

/**
 * `sitio_web` is a honeypot: hidden from people, filled by naive bots. A filled
 * one gets the same answer as a real request, so the bot learns nothing, and
 * nothing is stored.
 */
export function parseAuditRequest(body: Record<string, unknown>): ParsedAuditRequest {
  const trap = body["sitio_web"];
  if (typeof trap === "string" && trap.trim() !== "") return { kind: "bot" };
  const parsed = auditRequestSchema.safeParse(body);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "")))].filter((f) => f !== "");
    return { kind: "invalid", fields };
  }
  return { kind: "ok", request: parsed.data };
}

/** At most `maxPerWindow` requests per key (the client address) per window. A bound, not an identity check. */
export function createAuditRequestLimiter(options: { maxPerWindow: number; windowMs: number; clock?: () => number }) {
  const clock = options.clock ?? Date.now;
  const hits = new Map<string, number[]>();
  return {
    allow(key: string): boolean {
      const now = clock();
      const recent = (hits.get(key) ?? []).filter((at) => now - at < options.windowMs);
      if (recent.length >= options.maxPerWindow) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      // Keep the map from growing without end: drop keys whose hits are all old.
      if (hits.size > 10_000) {
        for (const [k, at] of hits) if (at.every((t) => now - t >= options.windowMs)) hits.delete(k);
      }
      return true;
    },
  };
}

export interface AuditRequestStore {
  save(request: AuditRequest): Promise<void>;
}

const CREATE_TABLE_SQL = `
  create table if not exists auditoria_solicitudes (
    id          bigserial   primary key,
    created_at  timestamptz not null default now(),
    nombre      text        not null,
    tienda      text        not null,
    plataforma  text        not null,
    correo      text        not null,
    mensaje     text        not null default ''
  )
`;

export async function createPostgresAuditRequestStore(options: { connectionString: string }): Promise<AuditRequestStore> {
  const postgresCa = process.env.POSTGRES_CA_CERT;
  const pool = new Pool({
    connectionString: options.connectionString,
    ssl: postgresCa === undefined || postgresCa === "" ? { rejectUnauthorized: false } : { ca: postgresCa, rejectUnauthorized: true },
  });
  pool.on("error", (error) => logError("[auditoria] idle Postgres client failed", error));
  try {
    await pool.query(CREATE_TABLE_SQL);
  } catch (error) {
    logError("[auditoria] could not reach or initialise Postgres", error);
    throw new AgentPassError("ConfigError", "could not initialise the audit request table", { cause: error });
  }
  return {
    async save(request) {
      await pool.query(
        "insert into auditoria_solicitudes (nombre, tienda, plataforma, correo, mensaje) values ($1, $2, $3, $4, $5)",
        [request.nombre, request.tienda, request.plataforma, request.correo, request.mensaje],
      );
    },
  };
}

/** What the endpoint answers. Pure, so the route is tested without a server or a database. */
export async function handleAuditRequest(
  deps: { store: () => Promise<AuditRequestStore>; limiter: { allow(key: string): boolean } },
  clientKey: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!deps.limiter.allow(clientKey)) {
    return { status: 429, body: { ok: false, code: "TooManyRequests", message: "Demasiadas solicitudes. Prueba de nuevo en una hora." } };
  }
  const parsed = parseAuditRequest(body);
  if (parsed.kind === "bot") return { status: 200, body: { ok: true } };
  if (parsed.kind === "invalid") {
    return { status: 400, body: { ok: false, code: "InvalidArguments", fields: parsed.fields } };
  }
  try {
    await (await deps.store()).save(parsed.request);
  } catch (error) {
    // The address and the message stay out of the log: only that a request failed.
    logError("[auditoria] could not store an audit request", error, { plataforma: parsed.request.plataforma });
    return { status: 503, body: { ok: false, code: "Unavailable", message: "No pudimos guardar tu solicitud. Escríbenos a vicente@agentpey.com." } };
  }
  return { status: 200, body: { ok: true } };
}
