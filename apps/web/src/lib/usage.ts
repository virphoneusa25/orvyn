import type { DayPoint } from "../components/UsageChart";

export interface StatsDay { day: string; credits: number; tokens: number; models: Record<string, { credits: number; tokens: number }>; tools: Record<string, { credits: number; tokens: number }> }
export interface Stats { days: StatsDay[]; tasks: Record<string, number>; activity: { totalTokens: number; currentStreakDays: number; longestStreakDays: number } }

/** The last n days (UTC, like the ledger), model work vs files & images, zero-filled. */
export function dailyPoints(stats: Stats | null, n = 7, now = Date.now()): DayPoint[] {
  const byDay = new Map((stats?.days ?? []).map((d) => [d.day, d]));
  const out: DayPoint[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now - i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    const row = byDay.get(key);
    const model = (row?.tools.model?.credits ?? 0) + (row?.tools.search?.credits ?? 0) + (row?.tools.compute?.credits ?? 0);
    const other = Math.max(0, (row?.credits ?? 0) - model);
    out.push({ label: n <= 7 ? d.toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" }) : d.toLocaleDateString(undefined, { month: "numeric", day: "numeric", timeZone: "UTC" }), a: model, b: other });
  }
  return out;
}
