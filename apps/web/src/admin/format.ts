export const fmtNum = (n: number | null | undefined) => Math.round(Number(n ?? 0)).toLocaleString("en-US");
export const fmtUsd = (n: number | null | undefined, digits = 2) => `$${Number(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
export const fmtUsd0 = (n: number | null | undefined) => `$${Math.round(Number(n ?? 0)).toLocaleString("en-US")}`;
export function fmtCompact(n: number): string {
  const v = Number(n ?? 0);
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e4) return `${Math.round(v / 1e3)}K`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}
export const fmtDate = (ts: number | null | undefined) => (ts ? new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");
export const fmtDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
export function fmtAgo(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24); if (d < 45) return `${d} day${d === 1 ? "" : "s"} ago`;
  return fmtDate(ts);
}
export function fmtIn(ts: number | null | undefined, now = Date.now()): { text: string; overdue: boolean; soon: boolean } {
  if (!ts) return { text: "", overdue: false, soon: false };
  const d = Math.round((ts - now) / 86_400_000);
  if (d < 0) return { text: `${-d} day${d === -1 ? "" : "s"} ago`, overdue: true, soon: false };
  return { text: d === 0 ? "today" : `in ${d} day${d === 1 ? "" : "s"}`, overdue: false, soon: d <= 14 };
}
export const STATUS_LABEL: Record<string, string> = { active: "Active", past_due: "Past Due", trial: "Trial", cancelled: "Cancelled", paused: "Paused" };
const LOGO = ["linear-gradient(135deg,#2563eb,#7c3aed)", "linear-gradient(135deg,#0ea5e9,#2563eb)", "linear-gradient(135deg,#f59e0b,#ea580c)", "linear-gradient(135deg,#10b981,#0e7490)", "linear-gradient(135deg,#8b5cf6,#d946ef)", "linear-gradient(135deg,#6366f1,#1e40af)"];
export function logoBg(seed: string): string { let h = 0; for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0; return LOGO[h % LOGO.length]!; }
export function initials(name: string): string { return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?"; }
export function domainOf(email: string | null | undefined, website?: string | null): string { if (website) return website.replace(/^https?:\/\//, "").replace(/\/$/, ""); return email ? email.split("@")[1] ?? "" : ""; }
export function rid(): string { const b = new Uint8Array(12); crypto.getRandomValues(b); return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""); }
