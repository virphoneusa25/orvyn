import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { ago } from "../lib/format";
import { navigate } from "../lib/router";
import type { Artifact, Project, SessionRow } from "../lib/useApi";
import { Icon } from "./Icons";
import { usePreview } from "./Preview";

interface Item { id: string; group: string; label: string; hint?: string; icon: React.ReactNode; run: () => void }

const PAGES: [string, string, keyof typeof Icon][] = [
  ["Home", "/", "home"], ["New chat", "/chats", "plus"], ["Chats", "/chats", "chat"], ["Projects", "/projects", "folder"], ["New project", "/projects?new=1", "plus"],
  ["Files", "/files", "file"], ["Usage", "/usage", "usage"], ["Billing", "/billing", "billing"], ["Buy credits", "/billing#credits", "coins"],
  ["Settings", "/settings", "settings"], ["Team", "/settings/team", "users"], ["API keys", "/settings/api-keys", "key"], ["Help", "/help", "help"], ["Download Desktop", "/download", "download"],
];

/** Ctrl/⌘ K: jump to any chat, project, file or page. Searches what this account can see, in the browser. */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [data, setData] = useState<{ sessions: SessionRow[]; projects: Project[]; files: Artifact[] } | null>(null);
  const preview = usePreview();
  const list = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api<{ sessions: SessionRow[] }>("/sessions").catch(() => ({ sessions: [] })),
      api<{ projects: Project[] }>("/projects").catch(() => ({ projects: [] })),
      api<{ artifacts: Artifact[] }>("/artifacts").catch(() => ({ artifacts: [] })),
    ]).then(([s, p, f]) => { if (alive) setData({ sessions: s.sessions, projects: p.projects, files: f.artifacts.filter((a) => a.kind !== "run") }); });
    return () => { alive = false; };
  }, []);

  const items = useMemo<Item[]>(() => {
    const needle = q.trim().toLowerCase();
    const hit = (...t: (string | null | undefined)[]) => !needle || t.some((x) => (x ?? "").toLowerCase().includes(needle));
    const go = (to: string) => () => { onClose(); navigate(to); };
    const out: Item[] = [];
    const chats = [...(data?.sessions ?? [])].sort((a, b) => b.updatedAt - a.updatedAt).filter((s) => hit(s.title, s.lastMessage)).slice(0, needle ? 8 : 5);
    for (const s of chats) out.push({ id: `c${s.sessionId}`, group: "Chats", label: s.title || "Conversation", hint: ago(s.updatedAt), icon: <Icon.chat size={17} />, run: go(s.projectId ? `/projects/${s.projectId}/chats/${s.sessionId}` : `/chats/${s.sessionId}`) });
    for (const p of (data?.projects ?? []).filter((p) => hit(p.name, p.description)).slice(0, needle ? 6 : 4)) out.push({ id: `p${p.id}`, group: "Projects", label: p.name, hint: p.description ?? undefined, icon: <Icon.folder size={17} />, run: go(`/projects/${p.id}`) });
    for (const f of (data?.files ?? []).filter((f) => hit(f.name)).sort((a, b) => b.createdAt - a.createdAt).slice(0, needle ? 6 : 3)) out.push({ id: `f${f.artifactId}`, group: "Files", label: f.name, hint: ago(f.createdAt), icon: <Icon.file size={17} />, run: () => { onClose(); preview(f); } });
    for (const [label, to, icon] of PAGES.filter(([l]) => hit(l))) {
      const I = Icon[icon] as (p: { size?: number }) => JSX.Element;
      out.push({ id: `g${label}`, group: "Go to", label, icon: <I size={17} />, run: go(to) });
    }
    if (needle) out.unshift({ id: "ask", group: "Ask ORVYN", label: `Ask “${q.trim()}”`, icon: <Icon.spark size={17} />, run: () => { onClose(); navigate(`/chats?q=${encodeURIComponent(q.trim())}`); } });
    return out;
  }, [q, data, onClose, preview]);

  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => { list.current?.querySelector<HTMLElement>(".is-on")?.scrollIntoView({ block: "nearest" }); }, [sel]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setSel((n) => Math.min(items.length - 1, n + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((n) => Math.max(0, n - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); items[sel]?.run(); }
  };

  let lastGroup = "";
  return (
    <div className="palette-wrap" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} role="dialog" aria-modal="true" aria-label="Search">
      <div className="palette" data-testid="palette">
        <div className="palette__input">
          <Icon.search size={19} />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Search or jump to…" aria-label="Search everything" data-testid="palette-input" />
          <kbd className="kbd">Esc</kbd>
        </div>
        <div className="palette__list" ref={list} role="listbox">
          {!data ? <div className="palette__empty">Loading…</div> : !items.length ? <div className="palette__empty">Nothing matches “{q}”.</div> : items.map((it, i) => {
            const head = it.group !== lastGroup ? (lastGroup = it.group) : null;
            return (
              <div key={it.id}>
                {head ? <div className="palette__group">{head}</div> : null}
                <button className={`palette__item${i === sel ? " is-on" : ""}`} role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={it.run} data-testid="palette-item">
                  {it.icon}<span>{it.label}</span>{it.hint ? <small>{it.hint.slice(0, 40)}</small> : null}
                </button>
              </div>
            );
          })}
        </div>
        <div className="palette__foot"><span>↑↓ to move</span><span>↵ to open</span><span>Esc to close</span></div>
      </div>
    </div>
  );
}
