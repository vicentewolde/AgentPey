import type { DueWebhookDelivery } from "@agentpey/directory";
import { verifyWebhookSignature } from "@agentpey/partner-api";
import { describe, expect, it } from "vitest";

import {
  drainWebhooks,
  webhookBackoffMs,
  MAX_WEBHOOK_ATTEMPTS,
  type WebhookDrainDirectory,
} from "./webhook-drain.js";

const NOW = new Date("2026-09-20T12:00:00.000Z");
const SECRET = "whsec_test";

function dueDelivery(overrides: Partial<DueWebhookDelivery> = {}): DueWebhookDelivery {
  return {
    id: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV:whe_1",
    endpointId: "whe_1",
    partnerId: "ptn_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    url: "https://partner.example/hooks",
    secret: SECRET,
    event: {
      id: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      type: "payment.settled",
      created_at: "2026-09-20T11:59:00.000Z",
      data: { purchase_id: "pur_01ARZ3NDEKTSV4RRFFQ69G5FAV", tenant_id: "ptn_x:y" },
    },
    attempts: 1,
    ...overrides,
  };
}

interface RecordingDirectory extends WebhookDrainDirectory {
  readonly delivered: string[];
  readonly failed: Array<{ id: string; lastError: string; giveUp: boolean; nextAttemptAt?: Date }>;
}

function recordingDirectory(due: readonly DueWebhookDelivery[]): RecordingDirectory {
  const delivered: string[] = [];
  const failed: RecordingDirectory["failed"] = [];
  return {
    delivered,
    failed,
    claimDueWebhookDeliveries: async () => due,
    markWebhookDelivered: async (id) => {
      delivered.push(id);
    },
    markWebhookFailed: async (input) => {
      failed.push({
        id: input.id,
        lastError: input.lastError,
        giveUp: input.giveUp,
        ...(input.nextAttemptAt === undefined ? {} : { nextAttemptAt: input.nextAttemptAt }),
      });
    },
  };
}

/** Public-resolving DNS, so the URL policy is not what a test is measuring unless it says so. */
const publicDns = async () => ["93.184.216.34"];

describe("drainWebhooks", () => {
  it("delivers a due event, signed with that endpoint's own secret, and marks it delivered", async () => {
    let seen: { body: string; signature: string } | undefined;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen = {
        body: String(init?.body),
        signature: String((init?.headers as Record<string, string>)["agentpay-signature"]),
      };
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const directory = recordingDirectory([dueDelivery()]);
    const summary = await drainWebhooks({ directory, resolveHost: publicDns, fetchImpl, now: () => NOW });

    expect(summary).toEqual({ claimed: 1, delivered: 1, retrying: 0, gaveUp: 0 });
    expect(directory.delivered).toEqual(["evt_01ARZ3NDEKTSV4RRFFQ69G5FAV:whe_1"]);
    // The partner has to be able to prove the body came from us, with the
    // secret only they and this process hold.
    expect(verifyWebhookSignature(SECRET, seen!.signature, seen!.body)).toEqual({ ok: true });
    expect(JSON.parse(seen!.body)).toEqual(dueDelivery().event);
  });

  it("sends the event thin — ids only, nothing a misdirected delivery could leak", async () => {
    let body: unknown;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    await drainWebhooks({ directory: recordingDirectory([dueDelivery()]), resolveHost: publicDns, fetchImpl, now: () => NOW });

    expect(body).toEqual({
      id: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      type: "payment.settled",
      created_at: "2026-09-20T11:59:00.000Z",
      data: { purchase_id: "pur_01ARZ3NDEKTSV4RRFFQ69G5FAV", tenant_id: "ptn_x:y" },
    });
  });

  it("schedules a retry with backoff when the endpoint is unwell", async () => {
    const fetchImpl = (async () => new Response("later", { status: 503 })) as typeof fetch;
    const directory = recordingDirectory([dueDelivery({ attempts: 2 })]);

    const summary = await drainWebhooks({ directory, resolveHost: publicDns, fetchImpl, now: () => NOW });

    expect(summary).toMatchObject({ delivered: 0, retrying: 1, gaveUp: 0 });
    expect(directory.failed[0]).toMatchObject({ giveUp: false, lastError: "HTTP 503" });
    expect(directory.failed[0]?.nextAttemptAt).toEqual(new Date(NOW.getTime() + webhookBackoffMs(2)));
  });

  it("gives up immediately on a 4xx — the endpoint read it and said no", async () => {
    const fetchImpl = (async () => new Response("no thanks", { status: 400 })) as typeof fetch;
    const directory = recordingDirectory([dueDelivery()]);

    const summary = await drainWebhooks({ directory, resolveHost: publicDns, fetchImpl, now: () => NOW });

    expect(summary).toMatchObject({ gaveUp: 1, retrying: 0 });
    expect(directory.failed[0]).toMatchObject({ giveUp: true });
    expect(directory.failed[0]?.nextAttemptAt).toBeUndefined();
  });

  it("gives up once the attempts run out", async () => {
    const fetchImpl = (async () => new Response("later", { status: 503 })) as typeof fetch;
    const directory = recordingDirectory([dueDelivery({ attempts: MAX_WEBHOOK_ATTEMPTS })]);

    const summary = await drainWebhooks({ directory, resolveHost: publicDns, fetchImpl, now: () => NOW });

    expect(summary).toMatchObject({ gaveUp: 1 });
    expect(directory.failed[0]).toMatchObject({ giveUp: true });
  });

  it("refuses to send to a host that now resolves inward, and never calls fetch", async () => {
    // The attack a registration-time check cannot see: the name passed every
    // shape check when it was registered, and its owner repointed it
    // afterwards.
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const directory = recordingDirectory([dueDelivery()]);

    const summary = await drainWebhooks({
      directory,
      resolveHost: async () => ["169.254.169.254"],
      fetchImpl,
      now: () => NOW,
    });

    expect(calls).toBe(0);
    expect(summary).toMatchObject({ gaveUp: 1 });
    // Permanent, not a retry: a name that has gone private will not come back
    // in two hours, and retrying is two hours of probing our own network.
    expect(directory.failed[0]).toMatchObject({ giveUp: true });
    expect(directory.failed[0]?.lastError).toContain("WebhookUrlNotAllowed");
  });

  it("keeps going when one delivery fails, so a broken endpoint cannot stall the batch", async () => {
    const fetchImpl = (async (url: string | URL | Request) =>
      String(url).includes("broken") ? new Response("no", { status: 500 }) : new Response(null, { status: 200 })) as typeof fetch;

    const directory = recordingDirectory([
      dueDelivery({ id: "a", url: "https://broken.example/hooks" }),
      dueDelivery({ id: "b" }),
      dueDelivery({ id: "c" }),
    ]);

    const summary = await drainWebhooks({ directory, resolveHost: publicDns, fetchImpl, now: () => NOW });

    expect(summary).toEqual({ claimed: 3, delivered: 2, retrying: 1, gaveUp: 0 });
    expect(directory.delivered).toEqual(["b", "c"]);
  });

  it("does not throw when a delivery blows up unexpectedly — the lease already covers the retry", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("something nobody anticipated");
    }) as typeof fetch;
    const directory: WebhookDrainDirectory = {
      claimDueWebhookDeliveries: async () => [dueDelivery()],
      markWebhookDelivered: async () => undefined,
      markWebhookFailed: async () => {
        throw new Error("the directory is down too");
      },
    };

    await expect(
      drainWebhooks({ directory, resolveHost: publicDns, fetchImpl, now: () => NOW }),
    ).resolves.toMatchObject({ claimed: 1, retrying: 1 });
  });

  it("does nothing, cheaply, when nothing is due", async () => {
    const fetchImpl = (async () => expect.unreachable("nothing was due")) as typeof fetch;
    await expect(
      drainWebhooks({ directory: recordingDirectory([]), resolveHost: publicDns, fetchImpl }),
    ).resolves.toEqual({ claimed: 0, delivered: 0, retrying: 0, gaveUp: 0 });
  });
});

describe("webhookBackoffMs", () => {
  it("grows, and stops growing", () => {
    expect(webhookBackoffMs(1)).toBe(60_000); // 1 minute
    expect(webhookBackoffMs(2)).toBe(3 * 60_000);
    expect(webhookBackoffMs(3)).toBe(9 * 60_000);
    expect(webhookBackoffMs(6)).toBe(135 * 60_000);
    expect(webhookBackoffMs(99)).toBe(135 * 60_000);
  });

  it("never returns less than the two-minute lease for an attempt that will be retried", () => {
    // If backoff were shorter than the lease, the lease would be what governs
    // the schedule, which is not what it is for.
    for (let attempts = 1; attempts < MAX_WEBHOOK_ATTEMPTS; attempts += 1) {
      expect(webhookBackoffMs(attempts)).toBeGreaterThanOrEqual(60_000);
    }
  });
});
