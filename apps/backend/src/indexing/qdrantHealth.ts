// Truthful Qdrant probe — never report healthy from configuration alone.

export interface QdrantHealth {
  status: "healthy" | "unhealthy" | "not_configured";
  reachable: boolean;
  version?: string;
  collections?: number;
  detail?: string;
}

export async function probeQdrant(url = process.env.ORVYN_QDRANT_URL): Promise<QdrantHealth> {
  if (!url?.trim()) {
    return { status: "not_configured", reachable: false, detail: "ORVYN_QDRANT_URL is not set" };
  }
  const base = url.replace(/\/$/, "");
  try {
    const ready = await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(3000) });
    if (!ready.ok) {
      return { status: "unhealthy", reachable: false, detail: `readyz ${ready.status}` };
    }
    let version: string | undefined;
    let collections: number | undefined;
    try {
      const info = await fetch(`${base}/`, { signal: AbortSignal.timeout(3000) });
      if (info.ok) {
        const body = (await info.json()) as { version?: string; title?: string };
        version = body.version ?? body.title;
      }
    } catch {
      /* version is optional */
    }
    try {
      const cols = await fetch(`${base}/collections`, { signal: AbortSignal.timeout(3000) });
      if (cols.ok) {
        const body = (await cols.json()) as { result?: { collections?: unknown[] } };
        collections = body.result?.collections?.length ?? 0;
      }
    } catch {
      /* collection count is optional */
    }
    return { status: "healthy", reachable: true, version, collections };
  } catch (err: any) {
    return { status: "unhealthy", reachable: false, detail: err?.message ?? "unreachable" };
  }
}
