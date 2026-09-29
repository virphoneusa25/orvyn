export function ago(ts: number | undefined | null, now = Date.now()): string {
  if (!ts) return "";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function num(n: number | undefined | null): string {
  return Math.round(Number(n ?? 0)).toLocaleString("en-US");
}

export function pct(used: number, limit: number): number {
  if (!(limit > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
}

export function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

export function date(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function bytes(n: number | undefined): string {
  const v = Number(n ?? 0);
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

export function firstName(name: string | null | undefined, email?: string): string {
  const n = (name ?? "").trim();
  if (n) return n.split(/\s+/)[0]!;
  return (email ?? "").split("@")[0] || "there";
}
