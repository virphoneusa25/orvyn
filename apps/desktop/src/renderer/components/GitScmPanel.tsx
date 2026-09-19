// apps/desktop/src/renderer/components/GitScmPanel.tsx
//
// Source Control view: live git status/diff/branches through the same gateway
// tools the agents use, plus the Checkpoint Engine (snapshot / restore /
// compare). Commit is an explicit user action here, so it executes with
// approved=true. There is deliberately NO push button — ORVYN never pushes.

import React, { useCallback, useEffect, useState } from "react";
import { apiUrl, authHeaders } from "../connection";

interface Checkpoint {
  id: string;
  createdAt: number;
  note?: string;
  missionId?: string;
  gitHead: string | null;
  files: string[];
}

async function runTool(name: string, args: Record<string, unknown> = {}, approved = false): Promise<{ ok: boolean; output?: string; error?: string }> {
  const res = await fetch(apiUrl(`/tools/${name}/execute`), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ args, approved }),
  });
  return res.json();
}

export function GitScmPanel({ projectRoot }: { projectRoot: string | null }) {
  const [status, setStatus] = useState<string>("");
  const [branches, setBranches] = useState<string>("");
  const [diff, setDiff] = useState<string>("");
  const [showDiff, setShowDiff] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [compareResult, setCompareResult] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectRoot) return;
    try {
      // Ensure tools are registered for this root before executing them.
      await fetch(apiUrl(`/tools?projectRoot=${encodeURIComponent(projectRoot)}`), { headers: authHeaders() });
      const [s, b, cps] = await Promise.all([
        runTool("git_status"),
        runTool("git_branch"),
        fetch(apiUrl(`/checkpoints?projectRoot=${encodeURIComponent(projectRoot)}`), { headers: authHeaders() }).then((r) => r.json()),
      ]);
      setStatus(s.ok ? s.output ?? "" : `git error: ${s.error}`);
      setBranches(b.ok ? b.output ?? "" : "");
      setCheckpoints(cps.checkpoints ?? []);
    } catch (err: any) {
      setStatus(`Backend unreachable: ${err.message}`);
    }
  }, [projectRoot]);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  async function loadDiff() {
    const d = await runTool("git_diff");
    setDiff(d.ok ? d.output ?? "" : `git error: ${d.error}`);
    setShowDiff(true);
  }

  async function commit() {
    if (!message.trim() || busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const r = await runTool("git_commit", { message: message.trim() }, true);
      setFeedback(r.ok ? r.output ?? "Committed." : `Commit failed: ${r.error}`);
      if (r.ok) setMessage("");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function createCheckpoint() {
    if (!projectRoot || busy) return;
    setBusy(true);
    try {
      await fetch(apiUrl("/checkpoints"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ projectRoot, note: "manual checkpoint" }),
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function restoreCheckpoint(id: string) {
    if (!projectRoot || busy) return;
    if (!window.confirm(`Restore checkpoint ${id}? This overwrites current versions of its snapshotted files.`)) return;
    setBusy(true);
    try {
      const r = await fetch(apiUrl(`/checkpoints/${id}/restore`), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ projectRoot }),
      }).then((x) => x.json());
      setFeedback(`Restored ${r.restored?.length ?? 0} file(s) from ${id}.`);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function compareCheckpoint(id: string) {
    if (!projectRoot) return;
    const r = await fetch(apiUrl(`/checkpoints/${id}/compare?projectRoot=${encodeURIComponent(projectRoot)}`), {
      headers: authHeaders(),
    }).then((x) => x.json());
    setCompareResult(
      `${id} — changed since snapshot: ${r.changed?.length ?? 0}, unchanged: ${r.same?.length ?? 0}, missing: ${r.missing?.length ?? 0}` +
        (r.changed?.length ? `\nchanged:\n${r.changed.map((f: string) => `  ${f}`).join("\n")}` : "")
    );
  }

  if (!projectRoot) {
    return <div style={{ padding: 16, color: "var(--text-muted)", fontSize: 13 }}>Open a folder to use Source Control.</div>;
  }

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: 16, color: "var(--text)" }}>
      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Source Control</div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 14 }}>
        Commits stay local — ORVYN never pushes to a remote.
      </div>

      <Section title="Changes (git status)">
        <Mono>{status || "(clean)"}</Mono>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <SmallBtn onClick={() => void loadDiff()}>{showDiff ? "Refresh diff" : "Show diff"}</SmallBtn>
          <SmallBtn onClick={() => void refresh()}>Refresh</SmallBtn>
        </div>
        {showDiff && <Mono style={{ marginTop: 8, maxHeight: 240, overflowY: "auto" }}>{diff || "(no unstaged changes)"}</Mono>}
      </Section>

      <Section title="Commit">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Commit message…"
          rows={2}
          style={{
            width: "100%",
            boxSizing: "border-box",
            background: "var(--bg-app)",
            color: "var(--text)",
            border: "1px solid var(--border-strong)",
            borderRadius: 6,
            padding: 8,
            fontSize: 12,
            resize: "vertical",
          }}
        />
        <div style={{ marginTop: 6 }}>
          <SmallBtn disabled={!message.trim() || busy} onClick={() => void commit()}>
            Commit all changes
          </SmallBtn>
        </div>
        {feedback && <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 6, whiteSpace: "pre-wrap" }}>{feedback}</div>}
      </Section>

      <Section title="Branches">
        <Mono>{branches || "(no branches)"}</Mono>
      </Section>

      <Section title="Checkpoints">
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>
          Snapshots of dirty files. Missions create one automatically before agents write.
        </div>
        <SmallBtn disabled={busy} onClick={() => void createCheckpoint()}>
          Create checkpoint now
        </SmallBtn>
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          {checkpoints.length === 0 && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>No checkpoints yet.</div>}
          {checkpoints.map((cp) => (
            <div key={cp.id} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px", background: "var(--bg-panel)" }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>
                {cp.id}
                <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>
                  {" "}
                  · {new Date(cp.createdAt).toLocaleString()} · {cp.files.length} file(s)
                </span>
              </div>
              {cp.note && <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{cp.note}</div>}
              <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                <SmallBtn onClick={() => void compareCheckpoint(cp.id)}>Compare</SmallBtn>
                <SmallBtn disabled={busy} onClick={() => void restoreCheckpoint(cp.id)}>
                  Restore
                </SmallBtn>
              </div>
            </div>
          ))}
        </div>
        {compareResult && <Mono style={{ marginTop: 8 }}>{compareResult}</Mono>}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: 6 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function Mono({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <pre
      style={{
        margin: 0,
        fontFamily: "JetBrains Mono, Consolas, monospace",
        fontSize: 11.5,
        lineHeight: 1.6,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        color: "var(--text-secondary)",
        background: "var(--bg-app)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: 8,
        ...style,
      }}
    >
      {children}
    </pre>
  );
}

function SmallBtn({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: "transparent",
        border: "1px solid var(--border-strong)",
        color: disabled ? "var(--text-muted)" : "var(--text)",
        borderRadius: 6,
        padding: "3px 10px",
        fontSize: 11.5,
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {children}
    </button>
  );
}
