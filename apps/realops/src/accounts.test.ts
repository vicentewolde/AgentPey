import { describe, expect, it } from "vitest";

import {
  MAGIC_LINK_TTL_MS,
  SESSION_TTL_MS,
  aliasSchema,
  checkMagicLink,
  createMemoryStore,
  emailSchema,
  externalRefFor,
  hashToken,
  issueMagicLink,
  newSession,
  sessionIsLive,
  tokenMatches,
} from "./accounts.js";

const NOW = new Date("2026-09-12T12:00:00.000Z");

describe("externalRefFor", () => {
  /**
   * The privacy boundary of the whole pilot. A hash of an email is still an
   * identifier of that person and a dictionary reverses it; a random id cannot
   * be reversed because it never encoded anything.
   */
  it("is random, so the same email never produces the same reference twice", () => {
    const refs = new Set(Array.from({ length: 50 }, () => externalRefFor()));

    expect(refs.size).toBe(50);
    for (const ref of refs) expect(ref.startsWith("rop_")).toBe(true);
  });

  it("contains nothing that could be an email, a RUT or a phone number", () => {
    const ref = externalRefFor();

    expect(ref).not.toContain("@");
    // `external-ref.ts` refuses those shapes; this never has to be refused.
    expect(/^[A-Za-z0-9_]+$/.test(ref)).toBe(true);
  });
});

describe("magic links", () => {
  it("stores a hash, never the token itself", () => {
    const issued = issueMagicLink("rac_1", NOW);

    expect(issued.link.tokenHash).not.toBe(issued.token);
    expect(issued.link.tokenHash).toBe(hashToken(issued.token));
    expect(JSON.stringify(issued.link)).not.toContain(issued.token);
  });

  it("lasts fifteen minutes", () => {
    const issued = issueMagicLink("rac_1", NOW);

    expect(issued.link.expiresAt.getTime() - NOW.getTime()).toBe(MAGIC_LINK_TTL_MS);
  });

  it("keeps its three refusals distinct, because they mean different things", () => {
    const issued = issueMagicLink("rac_1", NOW);

    expect(checkMagicLink(undefined, NOW)).toEqual({ ok: false, reason: "unknown" });
    expect(checkMagicLink(issued.link, new Date(NOW.getTime() + MAGIC_LINK_TTL_MS + 1))).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(checkMagicLink({ ...issued.link, usedAt: NOW }, NOW)).toEqual({ ok: false, reason: "already-used" });
    expect(checkMagicLink(issued.link, NOW)).toEqual({ ok: true });
  });

  it("compares hashes in constant time and only when the lengths match", () => {
    const hash = hashToken("a");

    expect(tokenMatches(hash, hash)).toBe(true);
    expect(tokenMatches(hashToken("b"), hash)).toBe(false);
    expect(tokenMatches("short", hash)).toBe(false);
  });

  /** Redeeming has to be the write. Two clicks on one link cannot both win. */
  it("can only be redeemed once, even by two callers at the same time", async () => {
    const store = createMemoryStore();
    const account = await store.createAccount("vos@ejemplo.cl", "Vicente");
    const issued = issueMagicLink(account.id, NOW);
    await store.saveMagicLink(issued.link);

    const [first, second] = await Promise.all([
      store.redeemMagicLink(issued.link.tokenHash, NOW),
      store.redeemMagicLink(issued.link.tokenHash, NOW),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
  });
});

describe("sessions", () => {
  it("lasts seven days and expires rather than lingering", () => {
    const session = newSession("rac_1", NOW);

    expect(session.expiresAt.getTime() - NOW.getTime()).toBe(SESSION_TTL_MS);
    expect(sessionIsLive(session, NOW)).toBe(true);
    expect(sessionIsLive(session, new Date(NOW.getTime() + SESSION_TTL_MS))).toBe(false);
    expect(sessionIsLive(undefined, NOW)).toBe(false);
  });

  it("has an id long enough not to be guessed", () => {
    expect(newSession("rac_1", NOW).id.length).toBeGreaterThanOrEqual(40);
  });
});

describe("the account store", () => {
  it("finds an account by email case-insensitively", async () => {
    const store = createMemoryStore();
    const account = await store.createAccount("Vos@Ejemplo.CL", "Vicente");

    expect((await store.findAccountByEmail("vos@ejemplo.cl"))?.id).toBe(account.id);
  });

  it("erases the email on deletion but keeps the reference AgentPey knows", async () => {
    const store = createMemoryStore();
    const account = await store.createAccount("vos@ejemplo.cl", "Vicente");

    await store.forgetAccount(account.id);
    const after = await store.findAccount(account.id);

    expect(after?.email).toBeNull();
    expect(after?.externalRef).toBe(account.externalRef);
    expect(await store.findAccountByEmail("vos@ejemplo.cl")).toBeUndefined();
  });

  it("never returns another account's agent", async () => {
    const store = createMemoryStore();
    const mine = await store.createAccount("yo@ejemplo.cl", "Yo");
    const theirs = await store.createAccount("otro@ejemplo.cl", "Otro");
    await store.saveAgent({
      id: "rag_1",
      accountId: theirs.id,
      kind: "market_brief",
      label: "Suyo",
      permissions: { perTx: "0.30", perDay: "0.60", validForDays: 30 },
      tenantId: null,
      consentSessionId: null,
      mandateId: null,
      comercio: null,
      createdAt: NOW,
    });

    expect(await store.findAgent(mine.id, "rag_1")).toBeUndefined();
    expect(await store.findAgent(theirs.id, "rag_1")).toBeDefined();
  });
});

describe("input validation", () => {
  it("accepts an ordinary email and refuses what is not one", () => {
    expect(emailSchema.safeParse("vos@ejemplo.cl").success).toBe(true);
    expect(emailSchema.safeParse("sin-arroba").success).toBe(false);
    expect(emailSchema.safeParse("dos@@ejemplo.cl").success).toBe(false);
  });

  it("refuses an alias with control characters", () => {
    expect(aliasSchema.safeParse("Vicente").success).toBe(true);
    expect(aliasSchema.safeParse("Vicen\u0007te").success).toBe(false);
    expect(aliasSchema.safeParse("Linea\nNueva").success).toBe(false);
  });
});
