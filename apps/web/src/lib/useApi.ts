import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

/** GET a path, keep the result, reload on demand. */
export function useApi<T>(path: string | null, deps: unknown[] = []): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [n, setN] = useState(0);
  const reload = useCallback(() => setN((x) => x + 1), []);
  useEffect(() => {
    if (!path) { setLoading(false); return; }
    let alive = true;
    setLoading(true);
    api<T>(path)
      .then((d) => { if (alive) { setData(d); setError(null); } })
      .catch((e) => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [path, n, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, loading, reload };
}

export interface SessionRow { sessionId: string; title: string; projectId: string | null; projectRoot: string | null; runIds: string[]; pinned: boolean; createdAt: number; updatedAt: number; messageCount: number; lastMessage: string }
export interface Project { id: string; name: string; projectRoot: string | null; createdAt: number; userId: string; description?: string | null; updatedAt?: number }
export interface Artifact { artifactId: string; name: string; mimeType: string; size: number; kind: string; chatId?: string | null; projectId?: string | null; createdAt: number; previewable: boolean }
