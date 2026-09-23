// Allowlisted Official MCP Registry fetch for the desktop process.
// Renderer CORS cannot be trusted from file://; main has no such restriction.

export const OFFICIAL_REGISTRY_ORIGIN = "https://registry.modelcontextprotocol.io";

export function officialRegistryRequestUrl(query = "", limit = 24, cursor?: string): string {
  const url = new URL("/v0.1/servers", OFFICIAL_REGISTRY_ORIGIN);
  url.searchParams.set("version", "latest");
  url.searchParams.set("limit", String(Math.min(Math.max(Number(limit) || 24, 1), 50)));
  if (query.trim()) url.searchParams.set("search", query.trim().slice(0, 200));
  if (cursor?.trim()) url.searchParams.set("cursor", cursor.trim().slice(0, 400));
  return url.toString();
}

export function isOfficialRegistryUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === OFFICIAL_REGISTRY_ORIGIN && parsed.pathname.startsWith("/v0.1/servers");
  } catch {
    return false;
  }
}

export async function fetchOfficialRegistry(
  query = "",
  limit = 24,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; status: number; body: unknown; error?: string }> {
  const url = officialRegistryRequestUrl(query, limit);
  try {
    const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
    const text = await res.text();
    const trimmed = (text ?? "").trim();
    if (trimmed.startsWith("<")) {
      return { ok: false, status: res.status, body: {}, error: `Official registry returned HTML (HTTP ${res.status})` };
    }
    try {
      const body = trimmed ? JSON.parse(trimmed) : {};
      if (res.ok) return { ok: true, status: res.status, body };
      return { ok: false, status: res.status, body, error: (body as { error?: string })?.error || `Official registry HTTP ${res.status}` };
    } catch {
      return { ok: false, status: res.status, body: {}, error: `Official registry returned non-JSON (HTTP ${res.status})` };
    }
  } catch (err: any) {
    return { ok: false, status: 0, body: {}, error: String(err?.message ?? err).slice(0, 180) };
  }
}
