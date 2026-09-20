import { DocumentsPanel } from "./DocumentsPanel";
// apps/desktop/src/renderer/components/ContextPanel.tsx
//
// The RIGHT dynamic context workspace. No chat lives here — the center
// WorkStream is the single conversation. This panel shows whatever secondary
// surface the active work makes useful: Plan, Files, Diff, Terminal, Review
// (Browser appears as an honest not-configured state until Playwright lands).
//
// Auto-follow picks the most relevant tab from the latest run event; a
// manual click pins the choice until the user resumes following.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { apiUrl, authHeaders } from "../connection";
import { matchesFile } from "../contextOpen";
import { AgentEvent } from "./AgentActivityList";
import { MissionPlan } from "./MissionPlan";
import { ReviewPanel } from "./ReviewPanel";
import { TerminalView, useTerminalSession } from "./BottomWorkPanel";
import { IconChevronRight } from "./Icons";

type CtxTab = "documents" | "plan" | "files" | "diff" | "terminal" | "browser" | "review";

const TAB_LABELS: Record<CtxTab, string> = {
  documents: "Docs",
  plan: "Plan",
  files: "Files",
  diff: "Diff",
  terminal: "Terminal",
  browser: "Browser",
  review: "Review",
};

/** Latest-event → suggested tab. Ordered by work phase. */
function suggestTab(events: AgentEvent[]): CtxTab | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i]!.type;
    if (t === "tool.completed" && events[i].data.tool === "create_document") return "documents";
    if (t === "run.completed" && events.some(e=>e.type === "tool.completed" && e.data.tool === "create_document")) return "documents";
    if (t === "review.started" || t === "review.passed" || t === "review.rejected" || t === "mission.completed" || t === "run.completed") return "review";
    if (t === "browser.started" || t === "image.generated") return "browser";
    if (t === "terminal.started" || t === "terminal.output") return "terminal";
    if (t === "file.edit") return "diff";
    if (t === "file.read") return "files";
    if (t === "plan.created" || t === "task.started" || t === "mission.created") return "plan";
  }
  return null;
}

export function ContextPanel({
  events,
  runStatus,
  projectRoot,
  onOpenFile,
}: {
  events: AgentEvent[];
  runStatus: string;
  projectRoot: string | null;
  onOpenFile: (path: string) => void;
}) {
  const [pinned, setPinned] = useState<CtxTab | null>(null);
  /** The file a row click asked to open (exact file → exact view). */
  const [focus, setFocus] = useState<{ path?: string; fileName?: string } | null>(null);
  const suggested = useMemo(() => suggestTab(events), [events]);
  const active: CtxTab | null = pinned ?? suggested;
  const [collapsed, setCollapsed] = useState(false);
  const term = useTerminalSession();

  // Center tool rows route the detail view: clicking "Edit session.ts" pins
  // Diff, a Terminal row pins Terminal… — manual selection always wins over
  // auto-follow until "Follow Activity" is pressed.
  useEffect(() => {
    const onCtxTab = (e: Event) => {
      const detail = (e as CustomEvent<{ tab?: CtxTab }>).detail;
      if (detail?.tab) {
        setPinned(detail.tab);
        setCollapsed(false);
      }
    };
    document.addEventListener("orvyn:context-tab", onCtxTab);
    // The ONE artifact-open path (spec Part H/I): rows carry the exact file;
    // the panel pins the tab AND focuses that file's contents/diff.
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<{ tab?: CtxTab; path?: string; fileName?: string }>).detail;
      if (!d?.tab) return;
      setPinned(d.tab);
      setCollapsed(false);
      setFocus(d.path || d.fileName ? { path: d.path, fileName: d.fileName } : null);
    };
    document.addEventListener("orvyn:context-open", onOpen);
    return () => {
      document.removeEventListener("orvyn:context-tab", onCtxTab);
      document.removeEventListener("orvyn:context-open", onOpen);
    };
  }, []);

  // Auto-expand when work starts (a tab becomes relevant); a user-pinned
  // collapse choice is honored until work starts again.
  const hasContext = active !== null;
  const wasContext = useRef(false);
  useEffect(() => {
    if (hasContext && !wasContext.current) setCollapsed(false);
    wasContext.current = hasContext;
  }, [hasContext]);

  if (collapsed) {
    return (
      <div
        style={{
          width: 26,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          paddingTop: 8,
          gap: 10,
        }}
      >
        <button title="Expand context panel" onClick={() => setCollapsed(false)} style={iconBtn()}>
          <IconChevronRight size={14} />
        </button>
        <span style={{ fontSize: 9, letterSpacing: 1.5, color: "var(--orvyn-text-muted)", writingMode: "vertical-rl" }}>
          CONTEXT
        </span>
      </div>
    );
  }

  return (
    <div
      style={{
        flex: 1,
        minWidth: 240,
        background: "var(--orvyn-surface-1)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      {/* Tab row + follow/pin + collapse */}
      <div style={{ display: "flex", alignItems: "center", borderBottom: "1px solid var(--orvyn-border-soft)", flexShrink: 0, height: 30, padding: "0 4px" }}>
        {(Object.keys(TAB_LABELS) as CtxTab[]).map((t) => {
          const isActive = active === t;
          return (
            <button
              key={t}
              onClick={() => setPinned(t)}
              title={isActive && pinned === t ? "Pinned — click Follow Activity to resume auto" : undefined}
              style={{
                background: "transparent",
                border: "none",
                borderBottom: isActive ? "2px solid var(--orvyn-purple)" : "2px solid transparent",
                color: isActive ? "var(--orvyn-text)" : "var(--orvyn-text-muted)",
                fontSize: 10.5,
                fontWeight: 600,
                padding: "0 8px",
                height: "100%",
                cursor: "pointer",
              }}
            >
              {TAB_LABELS[t]}
            </button>
          );
        })}
        <span style={{ marginLeft: "auto", display: "inline-flex", gap: 2 }}>
          {pinned && (
            <button title="Resume automatic context" onClick={() => setPinned(null)} style={{ ...iconBtn(), fontSize: 9.5, width: "auto", padding: "0 7px", color: "var(--orvyn-purple-hi)" }}>
              Follow Activity
            </button>
          )}
          <button title="Collapse" onClick={() => setCollapsed(true)} style={iconBtn()}>
            <IconChevronRight size={13} />
          </button>
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {!active && (
          <div style={{ padding: 24, fontSize: 11.5, color: "var(--orvyn-text-muted)", textAlign: "center", lineHeight: 1.7 }}>
            Context appears here as ORVYN works — plan, files, diffs, terminal and review.
            For plain conversation this panel stays out of the way.
          </div>
        )}
        {active === "plan" && (
          <div style={{ flex: 1, overflowY: "auto", padding: 10 }}>
            <MissionPlan events={events} status={runStatus} />
          </div>
        )}
        {active === "files" && <FilesView events={events} projectRoot={projectRoot} onOpenFile={onOpenFile} focus={focus} />}
        {active === "diff" && <DiffView events={events} focus={focus} />}
        {active === "terminal" && <TerminalView term={term} />}
        {active === "browser" && (
          <div style={{ padding: 24, fontSize: 11.5, color: "var(--orvyn-text-muted)", textAlign: "center", lineHeight: 1.7 }}>
            Browser verification needs Playwright (the backend's optional dependency). The browser
            agent tools already report this honestly — this tab goes live when it is installed.
          </div>
        )}
        {active === "documents" && <DocumentsPanel projectRoot={projectRoot} revision={events.filter(e=>e.type === "tool.completed" && e.data.tool === "create_document").length} />}
        {active === "review" && <ReviewPanel runId={events[0]?.runId} />}
      </div>
    </div>
  );
}

/** Touched files from run events, with a real content quick-view. */
function FilesView({ events, projectRoot, onOpenFile, focus }: { events: AgentEvent[]; projectRoot: string | null; onOpenFile: (path: string) => void; focus: { path?: string; fileName?: string } | null }) {
  const touched = useMemo(() => {
    const paths = new Set<string>();
    for (const e of events) {
      if (e.type === "file.read" || e.type === "file.edit") {
        const p = String(e.data.path ?? "");
        if (p) paths.add(p);
      }
    }
    return [...paths].slice(-8).reverse();
  }, [events]);

  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);

  useEffect(() => {
    setSelected((s) => (s && touched.includes(s) ? s : (touched[0] ?? null)));
  }, [touched]);

  // A row click names the exact file — select it (tolerant to separator and
  // path-rooting differences between event paths and row paths).
  useEffect(() => {
    if (!focus) return;
    const hit = touched.find((t) => matchesFile(t, focus));
    if (hit) setSelected(hit);
  }, [focus, touched]);

  useEffect(() => {
    if (!selected || !projectRoot) return;
    let alive = true;
    fetch(apiUrl(`/tools/read_file/execute`), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ args: { path: selected }, approved: true }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (alive) setContent(d.ok ? String(d.output).slice(0, 20000) : `Could not read: ${d.error ?? ""}`);
      })
      .catch(() => alive && setContent(null));
    return () => {
      alive = false;
    };
  }, [selected, projectRoot]);

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: 8, borderBottom: "1px solid var(--orvyn-border-soft)" }}>
        {touched.map((p) => (
          <button
            key={p}
            onClick={() => setSelected(p)}
            style={{
              background: selected === p ? "rgba(108,92,255,0.15)" : "transparent",
              border: `1px solid ${selected === p ? "var(--orvyn-purple)" : "var(--orvyn-border-soft)"}`,
              borderRadius: 5,
              color: "var(--orvyn-text-secondary)",
              fontSize: 10,
              fontFamily: "var(--font-mono)",
              padding: "2px 7px",
              cursor: "pointer",
            }}
          >
            {p}
          </button>
        ))}
        {touched.length === 0 && <span style={{ fontSize: 11, color: "var(--orvyn-text-muted)", padding: 4 }}>No files touched yet.</span>}
      </div>
      {selected && (
        <>
          <pre
            style={{
              flex: 1,
              minHeight: 0,
              overflow: "auto",
              margin: 0,
              padding: 10,
              fontFamily: "var(--font-mono)",
              fontSize: 10.5,
              lineHeight: 1.55,
              color: "var(--text-secondary)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {content ?? "…"}
          </pre>
          <div style={{ padding: "6px 10px", borderTop: "1px solid var(--orvyn-border-soft)", flexShrink: 0 }}>
            <button onClick={() => onOpenFile(selected)} style={{ ...ghost(), color: "var(--orvyn-purple-hi)" }}>
              Open in Code
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Real diffs — the previews the backend attaches to file.edit events. */
function DiffView({ events, focus }: { events: AgentEvent[]; focus: { path?: string; fileName?: string } | null }) {
  const edits = useMemo(() => {
    const list = events
      .filter((e) => e.type === "file.edit" && e.data.preview)
      .slice(-6)
      .reverse();
    // The clicked file's diff floats to the top so the right view answers
    // the click immediately.
    if (focus) {
      const hit = list.filter((e) => matchesFile(String((e.data.preview as { path?: string })?.path ?? ""), focus));
      const rest = list.filter((e) => !hit.includes(e));
      return [...hit, ...rest];
    }
    return list;
  }, [events, focus]);

  if (edits.length === 0) {
    return <div style={{ padding: 24, fontSize: 11.5, color: "var(--orvyn-text-muted)", textAlign: "center" }}>No changes yet.</div>;
  }

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: 10 }}>
      {edits.map((e) => {
        const p = e.data.preview as { path: string; additions: number; deletions: number; diff?: { type: string; content: string }[] };
        return (
          <div key={e.id} style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", gap: 8, fontSize: 11, alignItems: "center", marginBottom: 4 }}>
              <code style={{ fontFamily: "var(--font-mono)", color: "var(--orvyn-text)" }}>{p.path}</code>
              <span style={{ color: "var(--orvyn-green)" }}>+{p.additions}</span>
              <span style={{ color: "var(--orvyn-red)" }}>−{p.deletions}</span>
            </div>
            {p.diff && (
              <pre style={{ margin: 0, background: "var(--orvyn-bg)", border: "1px solid var(--orvyn-border-soft)", borderRadius: 6, padding: 8, fontSize: 10.5, lineHeight: 1.5, fontFamily: "var(--font-mono)", maxHeight: 220, overflow: "auto" }}>
                {p.diff.map((l, i) => (
                  <div
                    key={i}
                    style={{
                      color: l.type === "add" ? "var(--orvyn-green)" : l.type === "remove" ? "var(--orvyn-red)" : "var(--orvyn-text-muted)",
                      background: l.type === "add" ? "rgba(32,216,155,0.08)" : l.type === "remove" ? "rgba(242,95,117,0.08)" : undefined,
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {l.type === "add" ? "+ " : l.type === "remove" ? "− " : "  "}
                    {l.content}
                  </div>
                ))}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

function iconBtn(): React.CSSProperties {
  return {
    background: "transparent",
    border: "none",
    color: "var(--orvyn-text-muted)",
    width: 24,
    height: 24,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
  };
}

function ghost(): React.CSSProperties {
  return {
    background: "transparent",
    border: "1px solid var(--orvyn-border)",
    borderRadius: 5,
    fontSize: 11,
    padding: "3px 10px",
    cursor: "pointer",
  };
}
