/** Customer project folders only — never ORVYN internals, fixtures, or hidden dirs. */
export function isCustomerProjectPath(folder: string): boolean {
  const n = folder.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  if (!n) return false;
  const segs = n.split("/").filter(Boolean);
  const last = segs[segs.length - 1] ?? "";
  if (last.startsWith(".")) return false;
  if (segs.includes(".orvyn") || segs.includes("node_modules") || segs.includes(".git")) return false;
  if (/@orvyn/.test(n) && /workspace/.test(n)) return false;
  if (/\b(fixtures?|__fixtures__|__tests__|orvyn-test|test-fixtures)\b/.test(n)) return false;
  if (last === "fixtures" || last.endsWith("-fixtures") || last === "fixture") return false;
  return true;
}

export function filterCustomerProjectPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (typeof p !== "string" || !p.trim()) continue;
    if (!isCustomerProjectPath(p)) continue;
    const key = p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}
