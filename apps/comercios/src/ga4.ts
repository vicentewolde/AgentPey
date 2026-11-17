/**
 * Google Analytics 4 connector: read sessions, purchases and revenue by
 * source for a date range through the GA4 Data API, and classify each source
 * with the same rules as the snippet. A store that hires AgentPey grants read
 * access to its property; the access token comes from that grant (OAuth or a
 * service account the store adds as a viewer).
 */
import { classifyVisit, type MeasureEvent, type Source } from "./medir.js";

export function runReportBody(startDate: string, endDate: string): Record<string, unknown> {
  return {
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: "sessionSource" }, { name: "sessionMedium" }],
    metrics: [{ name: "sessions" }, { name: "transactions" }, { name: "purchaseRevenue" }],
    limit: 10000,
  };
}

interface Ga4Row {
  dimensionValues?: { value?: string }[];
  metricValues?: { value?: string }[];
}

/** A GA4 `sessionSource` ("chatgpt.com", "perplexity", "google") as our source. */
export function sourceFromGa4(sessionSource: string): Source {
  const s = sessionSource.trim().toLowerCase();
  if (s === "" || s === "(direct)" || s === "(not set)") return "sin_ia";
  const asHost = /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? `https://${s}/` : undefined;
  const byHost = asHost === undefined ? "sin_ia" : classifyVisit("https://tienda.cl/", asHost);
  return byHost !== "sin_ia" ? byHost : classifyVisit(`https://tienda.cl/?utm_source=${encodeURIComponent(s)}`, undefined);
}

/** GA4 rows added up by our source. */
export function eventsFromGa4(report: { rows?: Ga4Row[] }): { source: Source; sessions: number; transactions: number; revenue: number }[] {
  const acc = new Map<Source, { sessions: number; transactions: number; revenue: number }>();
  for (const row of report.rows ?? []) {
    const source = sourceFromGa4(row.dimensionValues?.[0]?.value ?? "");
    const [sessions, transactions, revenue] = (row.metricValues ?? []).map((m) => Number(m.value ?? 0));
    const a = acc.get(source) ?? { sessions: 0, transactions: 0, revenue: 0 };
    a.sessions += sessions ?? 0;
    a.transactions += transactions ?? 0;
    a.revenue += revenue ?? 0;
    acc.set(source, a);
  }
  return [...acc.entries()].map(([source, a]) => ({ source, ...a }));
}

/** Expand GA4 aggregates into events so they feed the same summary as the snippet. */
export function ga4AsEvents(storeId: string, rows: ReturnType<typeof eventsFromGa4>, at: string): MeasureEvent[] {
  const out: MeasureEvent[] = [];
  for (const r of rows) {
    for (let i = 0; i < r.sessions; i++) out.push({ storeId, kind: "visita", source: r.source, at });
    const avg = r.transactions === 0 ? 0 : r.revenue / r.transactions;
    for (let i = 0; i < r.transactions; i++) out.push({ storeId, kind: "compra", source: r.source, at, total: Math.round(avg), orderId: `ga4-${r.source}-${i}` });
  }
  return out;
}

export async function fetchGa4Report(propertyId: string, accessToken: string, startDate: string, endDate: string): Promise<{ rows?: Ga4Row[] }> {
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify(runReportBody(startDate, endDate)),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GA4 respondió ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as { rows?: Ga4Row[] };
}
