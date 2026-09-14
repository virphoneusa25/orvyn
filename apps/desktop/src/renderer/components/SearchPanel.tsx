import React, { useEffect, useState } from "react";
import { apiUrl, authHeaders } from "../connection";

interface IndexStats {
  status: "idle" | "indexing" | "ready" | "error";
  filesIndexed: number;
  chunksIndexed: number;
  tookMs?: number;
  lastIndexedAt?: string;
  error?: string;
}

interface SearchHit {
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
}


export function SearchPanel({
  workspaceRoot,
  workspaceKind,
}: {
  workspaceRoot: string | null;
  workspaceKind: "folder" | "default";
}) {
  const [stats, setStats] = useState<IndexStats | null>(null);
  const [building, setBuilding] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);

  async function refreshStats() {
    const res = await fetch(apiUrl("/index/status"), { headers: authHeaders() });
    const data = await res.json();
    setStats(data.stats);
  }

  useEffect(() => {
    refreshStats();
  }, []);

  async function handleBuild() {
    if (!workspaceRoot) return;
    setBuilding(true);
    try {
      const res = await fetch(apiUrl("/index/build"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ projectRoot: workspaceRoot }),
      });
      const data = await res.json();
      setStats(data.stats);
    } finally {
      setBuilding(false);
    }
  }

  async function handleSearch() {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const res = await fetch(apiUrl("/search/semantic"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ query, topK: 8 }),
      });
      const data = await res.json();
      setHits(data.hits ?? []);
    } finally {
      setSearching(false);
    }
  }

  if (!workspaceRoot) {
    return <div style={{ padding: 16, color: "#8b93a7", fontSize: 13 }}>Workspace is still starting…</div>;
  }

  return (
    <div style={{ padding: 16, color: "#c9d1e0", height: "100%", overflowY: "auto" }}>
      <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Codebase Search (RAG)</div>
      <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 12 }}>
        {workspaceKind === "default"
          ? "Indexes the built-in ORVYN workspace. Open a folder to search a real project."
          : "Lexical/bag-of-words similarity by default — works with zero external services. Swap in a real embedding model in Settings > AI Models for true semantic ranking."}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, fontSize: 12 }}>
        <span>
          Index: <strong>{stats?.status ?? "idle"}</strong>
          {stats?.status === "ready" && ` · ${stats.filesIndexed} files · ${stats.chunksIndexed} chunks · ${stats.tookMs}ms`}
          {stats?.status === "error" && ` · ${stats.error}`}
        </span>
        <button onClick={handleBuild} disabled={building} style={btnGhost()}>
          {building ? "Indexing…" : "Rebuild Index"}
        </button>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          placeholder="Search the codebase…"
          style={{ flex: 1, background: "#0f1420", border: "1px solid #1c2330", borderRadius: 6, color: "#e6e9f0", padding: "6px 10px", fontSize: 13 }}
        />
        <button onClick={handleSearch} disabled={searching || stats?.status !== "ready"} style={{ background: "#3b5bfd", border: "none", borderRadius: 6, color: "white", padding: "6px 14px", cursor: "pointer" }}>
          {searching ? "Searching…" : "Search"}
        </button>
      </div>

      {hits.map((hit, i) => (
        <div key={i} style={{ border: "1px solid #1c2330", borderRadius: 8, padding: 10, marginBottom: 10 }}>
          <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>
            {hit.path}:{hit.startLine}-{hit.endLine} · score {hit.score.toFixed(3)}
          </div>
          <pre style={{ margin: 0, fontSize: 12, whiteSpace: "pre-wrap", fontFamily: "monospace" }}>{hit.snippet}</pre>
        </div>
      ))}
    </div>
  );
}

function btnGhost(): React.CSSProperties {
  return { background: "transparent", border: "1px solid #2a3244", borderRadius: 6, color: "#c9d1e0", padding: "4px 10px", fontSize: 12, cursor: "pointer" };
}
