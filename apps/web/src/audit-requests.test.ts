import { describe, expect, it } from "vitest";

import { createAuditRequestLimiter, handleAuditRequest, parseAuditRequest, type AuditRequest } from "./audit-requests.js";

const valid = { nombre: "Ana", tienda: "tienda.cl", plataforma: "jumpseller", correo: "ana@tienda.cl" };

function memoryStore() {
  const saved: AuditRequest[] = [];
  return { saved, store: async () => ({ save: async (r: AuditRequest) => void saved.push(r) }) };
}

describe("free audit requests (Start-Up Chile page)", () => {
  it("accepts a complete request and trims it", () => {
    const parsed = parseAuditRequest({ ...valid, nombre: "  Ana  " });
    expect(parsed).toEqual({ kind: "ok", request: { ...valid, mensaje: "" } });
  });

  it("names the fields that are wrong", () => {
    const parsed = parseAuditRequest({ ...valid, correo: "no-es-correo", plataforma: "amazon" });
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind === "invalid") expect([...parsed.fields].sort()).toEqual(["correo", "plataforma"]);
  });

  it("treats a filled honeypot as a bot: answers ok and stores nothing", async () => {
    const { saved, store } = memoryStore();
    const limiter = createAuditRequestLimiter({ maxPerWindow: 5, windowMs: 1000 });
    const answer = await handleAuditRequest({ store, limiter }, "1.2.3.4", { ...valid, sitio_web: "spam.example" });
    expect(answer).toEqual({ status: 200, body: { ok: true } });
    expect(saved).toHaveLength(0);
  });

  it("stores a valid request", async () => {
    const { saved, store } = memoryStore();
    const limiter = createAuditRequestLimiter({ maxPerWindow: 5, windowMs: 1000 });
    const answer = await handleAuditRequest({ store, limiter }, "1.2.3.4", valid);
    expect(answer.status).toBe(200);
    expect(saved).toEqual([{ ...valid, mensaje: "" }]);
  });

  it("caps requests per address and lets them through again after the window", async () => {
    let now = 0;
    const limiter = createAuditRequestLimiter({ maxPerWindow: 2, windowMs: 1000, clock: () => now });
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("a")).toBe(false);
    expect(limiter.allow("b")).toBe(true);
    now = 1000;
    expect(limiter.allow("a")).toBe(true);
  });

  it("answers 503 without leaking the request when the database fails", async () => {
    const limiter = createAuditRequestLimiter({ maxPerWindow: 5, windowMs: 1000 });
    const store = async () => ({ save: async () => { throw new Error("db down"); } });
    const answer = await handleAuditRequest({ store, limiter }, "1.2.3.4", valid);
    expect(answer.status).toBe(503);
    expect(JSON.stringify(answer.body)).not.toContain("ana@tienda.cl");
  });
});
