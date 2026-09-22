import React, { useEffect, useMemo, useRef, useState } from "react";
import { apiUrl, authHeaders, getConnectionConfig, isCloudBackend } from "../connection";
import {
  buildAddMenuItems,
  filterAddMenuItems,
  moveHighlight,
  rememberRecentRef,
  composerTriggerKey,
  type AddMenuItem,
  type AddMenuSnapshot,
  type McpInfo,
  type PluginInfo,
  type SkillInfo,
} from "../addMenuModel";
import { getWorkspaceSnapshot, readEditorSelection } from "../workspaceSnapshot";
import { type Attachment } from "./AttachmentBar";
import {
  IconCheck,
  IconFile,
  IconFolder,
  IconGit,
  IconGlobe,
  IconPaperclip,
  IconPlus,
  IconSearch,
  IconServer,
  IconSparkles,
  IconTerminal,
  IconWrench,
} from "./Icons";

export interface ComposerChip {
  id: string;
  label: string;
  kind: AddMenuItem["kind"];
  path?: string;
  attachment?: Attachment;
  note?: string;
}

export function AddMenu({
  open,
  onOpenChange,
  selected,
  onSelectedChange,
  onOpenTerminal,
  onNavigate,
  projectRoot,
  anchorRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selected: ComposerChip[];
  onSelectedChange: (chips: ComposerChip[]) => void;
  onOpenTerminal?: () => void;
  onNavigate?: (view: string) => void;
  projectRoot: string | null;
  anchorRef: React.RefObject<HTMLElement | null>;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [mcp, setMcp] = useState<McpInfo[]>([]);
  const [caps, setCaps] = useState({ sshHostCount: 0, githubConnected: false, browserAvailable: false });
  const [pos, setPos] = useState({ top: 0, left: 0, width: 360, place: "above" as "above" | "below" });

  useEffect(() => {
    if (!open) return;
    const ws = getWorkspaceSnapshot();
    const suffix = (projectRoot || ws.root) ? `?projectRoot=${encodeURIComponent(projectRoot || ws.root || "")}` : "";
    const headers = authHeaders();
    void Promise.all([
      fetch(apiUrl("/skills"), { headers }).then((r) => (r.ok ? r.json() : { skills: [] })).catch(() => ({ skills: [] })),
      fetch(apiUrl("/agent/skills"), { headers }).then((r) => (r.ok ? r.json() : { skills: [] })).catch(() => ({ skills: [] })),
      fetch(apiUrl(`/mcp/servers${suffix}`), { headers }).then((r) => (r.ok ? r.json() : { servers: [] })).catch(() => ({ servers: [] })),
      fetch(apiUrl("/mcp/statuses"), { headers }).then((r) => (r.ok ? r.json() : { servers: [] })).catch(() => ({ servers: [] })),
      fetch(apiUrl(`/tools${suffix}`), { headers }).then((r) => (r.ok ? r.json() : { tools: [] })).catch(() => ({ tools: [] })),
      fetch(apiUrl(`/runtime/capabilities${suffix}`), { headers }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    ]).then(([skillsA, skillsB, mcpServers, mcpStatus, tools, runtimeRaw]) => {
      const runtime = runtimeRaw as { sshHostCount?: number; githubConnected?: boolean };
      const skillRows: SkillInfo[] = [
        ...((skillsA.skills ?? skillsA.items ?? []) as { id?: string; name?: string; title?: string; description?: string }[]),
        ...((skillsB.skills ?? skillsB.items ?? []) as { id?: string; name?: string; title?: string; description?: string }[]),
      ]
        .filter((s) => s && (s.id || s.name || s.title))
        .map((s) => ({
          id: String(s.id ?? s.name ?? s.title),
          name: String(s.name ?? s.title ?? s.id),
          description: String(s.description ?? "Installed skill"),
        }));
      const seen = new Set<string>();
      setSkills(skillRows.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true))));

      const servers: McpInfo[] = ([...(mcpStatus.servers ?? []), ...(mcpServers.servers ?? [])] as { id?: string; name?: string; state?: string; toolCount?: number }[])
        .filter((s) => s?.id || s?.name)
        .map((s) => ({
          id: String(s.id ?? s.name),
          name: String(s.name ?? s.id),
          state: String(s.state ?? "DISCONNECTED"),
          toolCount: Number(s.toolCount ?? 0) || undefined,
        }));
      const mcpSeen = new Set<string>();
      setMcp(servers.filter((s) => (mcpSeen.has(s.id) ? false : (mcpSeen.add(s.id), true))));

      const toolRows = (tools.tools ?? []) as { name?: string; description?: string }[];
      const plug: PluginInfo[] = [];
      if (toolRows.some((t) => String(t.name).startsWith("browser_"))) {
        plug.push({ id: "browser-runtime", name: "Browser automation", description: "Built-in browser tools", connected: true });
      }
      if (toolRows.some((t) => /git_/i.test(String(t.name)))) {
        plug.push({ id: "git-tools", name: "Git", description: "Repository status and diffs", connected: true });
      }
      setPlugins(plug);
      setCaps({
        sshHostCount: Number(runtime.sshHostCount ?? 0) || 0,
        githubConnected: runtime.githubConnected === true,
        browserAvailable: toolRows.some((t) => String(t.name).startsWith("browser_")),
      });
    });
  }, [open, projectRoot]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setHighlight(0);
      return;
    }
    function place() {
      const btn = anchorRef.current?.getBoundingClientRect();
      const width = Math.min(420, Math.max(320, window.innerWidth - 24));
      const maxH = Math.min(520, window.innerHeight * 0.55);
      const left = btn ? Math.min(Math.max(8, btn.left), window.innerWidth - width - 8) : 8;
      const spaceAbove = btn ? btn.top - 8 : 200;
      const placeAbove = spaceAbove >= 220;
      const top = placeAbove
        ? Math.max(8, (btn?.top ?? 240) - maxH - 8)
        : Math.min(window.innerHeight - maxH - 8, (btn?.bottom ?? 40) + 8);
      setPos({ top, left, width, place: placeAbove ? "above" : "below" });
    }
    place();
    window.addEventListener("resize", place);
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onOpenChange(false);
    }
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open, anchorRef, onOpenChange]);

  const snapshot: AddMenuSnapshot = useMemo(() => {
    const ws = getWorkspaceSnapshot();
    const cloud = isCloudBackend(getConnectionConfig().backendUrl);
    return {
      workspaceRoot: projectRoot ?? ws.root,
      workspaceName: ws.name,
      workspaceKind: ws.kind,
      localMode: !cloud,
      cloudMode: cloud,
      openTabs: ws.openTabs,
      recents: ws.recents,
      selection: readEditorSelection(),
      skills,
      plugins,
      mcp,
      sshHostCount: caps.sshHostCount,
      githubConnected: caps.githubConnected,
      browserAvailable: caps.browserAvailable,
      selectedIds: selected.map((s) => s.id),
    };
  }, [projectRoot, skills, plugins, mcp, caps, selected, open]);

  const items = useMemo(() => filterAddMenuItems(buildAddMenuItems(snapshot), query), [snapshot, query]);
  const actionable = items.filter((i) => !i.disabled);

  useEffect(() => {
    if (highlight >= actionable.length) setHighlight(0);
  }, [actionable.length, highlight]);

  async function activate(item: AddMenuItem) {
    if (item.disabled || item.empty) return;
    if (item.kind === "navigate" && item.view) {
      onNavigate?.(item.view);
      onOpenChange(false);
      return;
    }
    if (item.kind === "attachments") {
      await pickAttachments();
      rememberRecentRef(item.id);
      return;
    }
    if (item.kind === "file") {
      await pickAttachments();
      return;
    }
    if (item.kind === "folder") {
      await pickWorkspaceFolder();
      return;
    }
    if (item.kind === "terminal") {
      onOpenTerminal?.();
    }
    if (selected.some((s) => s.id === item.id)) {
      onSelectedChange(selected.filter((s) => s.id !== item.id));
      return;
    }
    rememberRecentRef(item.id);
    onSelectedChange([
      ...selected,
      {
        id: item.id,
        label: item.name,
        kind: item.kind,
        path: item.path,
        note: item.description,
      },
    ]);
  }

  async function pickAttachments() {
    try {
      const picked = await window.orvyn.attachments.pick();
      const next = [...selected];
      for (const p of picked ?? []) {
        const id = `att:${p.sourcePath ?? p.path}`;
        if (next.some((s) => s.id === id)) continue;
        const attachment: Attachment = p.kind === "image"
          ? { kind: "image", name: p.path, b64: (p.dataUrl ?? "").split(",")[1], mediaType: p.mime }
          : { kind: "file", name: p.path, content: p.content };
        next.push({ id, label: p.path, kind: "attachments", attachment });
      }
      onSelectedChange(next);
    } catch {
      /* canceled */
    }
  }

  async function pickWorkspaceFolder() {
    try {
      const folder = await window.orvyn.attachments.pickFolder?.();
      if (!folder || "error" in folder) return;
      const id = `ctx:folder:${folder.path}`;
      if (selected.some((s) => s.id === id)) return;
      onSelectedChange([
        ...selected,
        { id, label: folder.name, kind: "folder", path: folder.path, note: `Folder ${folder.path}` },
      ]);
    } catch {
      /* canceled */
    }
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onOpenChange(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((i) => moveHighlight(i, 1, actionable.length));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((i) => moveHighlight(i, -1, actionable.length));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const item = actionable[highlight];
      if (item) void activate(item);
    }
  }

  if (!open) return null;

  const sections: { id: AddMenuItem["section"]; label: string }[] = [
    { id: "recent", label: "RECENT" },
    { id: "add", label: "ADD" },
    { id: "context", label: "CONTEXT" },
    { id: "skills", label: "SKILLS" },
    { id: "plugins", label: "PLUGINS" },
    { id: "tools", label: "TOOLS" },
  ];

  return (
    <div
      ref={panelRef}
      role="listbox"
      className="orvyn-add-menu"
      onKeyDown={onKey}
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        width: pos.width,
        maxHeight: Math.min(520, window.innerHeight * 0.55),
        zIndex: 850,
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-strong)",
        borderRadius: 10,
        boxShadow: "var(--orvyn-shadow)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--orvyn-border-soft)", display: "flex", alignItems: "center", gap: 8 }}>
        <IconSearch size={13} />
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setHighlight(0);
          }}
          onKeyDown={onKey}
          placeholder="Search plugins, skills, files, and context"
          style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "var(--orvyn-text)", fontSize: 12.5 }}
        />
      </div>
      <div style={{ overflowY: "auto", padding: 6, minHeight: 0 }}>
        {sections.map((sec) => {
          const rows = items.filter((i) => i.section === sec.id);
          if (rows.length === 0) return null;
          return (
            <div key={sec.id}>
              <div style={{ fontSize: 9.5, letterSpacing: 0.8, color: "var(--orvyn-text-muted)", padding: "8px 8px 4px" }}>{sec.label}</div>
              {rows.map((item) => {
                const idx = actionable.indexOf(item);
                const active = idx === highlight;
                return (
                  <button
                    key={item.id}
                    type="button"
                    disabled={item.disabled}
                    onMouseEnter={() => {
                      if (idx >= 0) setHighlight(idx);
                    }}
                    onClick={() => void activate(item)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      width: "100%",
                      textAlign: "left",
                      background: active ? "rgba(108,92,255,0.16)" : "transparent",
                      border: "none",
                      borderRadius: 7,
                      color: item.disabled ? "var(--orvyn-text-muted)" : "var(--orvyn-text)",
                      padding: "7px 8px",
                      cursor: item.disabled ? "default" : "pointer",
                    }}
                  >
                    <span style={{ color: iconColor(item.kind), display: "inline-flex" }}>{rowIcon(item)}</span>
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: "block", fontSize: 12.5, fontWeight: 550 }}>{item.name}</span>
                      <span style={{ display: "block", fontSize: 11, color: "var(--orvyn-text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {item.description}
                      </span>
                    </span>
                    {item.selected && (
                      <span style={{ color: "var(--orvyn-cyan)" }}>
                        <IconCheck size={13} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ComposerChips({
  chips,
  onRemove,
}: {
  chips: ComposerChip[];
  onRemove: (id: string) => void;
}) {
  if (chips.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
      {chips.map((c) => (
        <span
          key={c.id}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            background: "var(--orvyn-surface-2)",
            border: "1px solid var(--orvyn-border-soft)",
            borderRadius: 999,
            padding: "2px 8px 2px 8px",
            fontSize: 11,
            color: "var(--orvyn-text-secondary)",
          }}
        >
          {rowIcon({ kind: c.kind } as AddMenuItem)}
          {c.label}
          <button
            type="button"
            aria-label={`Remove ${c.label}`}
            onClick={() => onRemove(c.id)}
            style={{ background: "transparent", border: "none", color: "var(--orvyn-text-muted)", cursor: "pointer", padding: 0, lineHeight: 1 }}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

export function attachmentsFromChips(chips: ComposerChip[]): Attachment[] {
  return chips.filter((c) => c.attachment).map((c) => c.attachment!) ;
}

export function contextNoteFromChips(chips: ComposerChip[]): string {
  if (chips.length === 0) return "";
  return `Added context · ${chips.map((c) => c.label).slice(0, 6).join(" + ")}`;
}

function rowIcon(item: Pick<AddMenuItem, "kind">): React.ReactNode {
  switch (item.kind) {
    case "attachments":
      return <IconPaperclip size={14} />;
    case "folder":
    case "workspace":
      return <IconFolder size={14} />;
    case "browser":
      return <IconGlobe size={14} />;
    case "terminal":
      return <IconTerminal size={14} />;
    case "git":
      return <IconGit size={14} />;
    case "server":
      return <IconServer size={14} />;
    case "skill":
      return <IconSparkles size={14} />;
    case "plugin":
    case "mcp":
      return <IconWrench size={14} />;
    default:
      return <IconFile size={14} />;
  }
}

function iconColor(kind: AddMenuItem["kind"]): string {
  if (kind === "browser") return "#5eead4";
  if (kind === "skill") return "#c4b5fd";
  if (kind === "mcp" || kind === "plugin") return "#93c5fd";
  if (kind === "terminal") return "#86efac";
  if (kind === "attachments") return "#fbbf24";
  return "var(--orvyn-text-muted)";
}

export { composerTriggerKey };

export function AddPlusButton({
  open,
  onClick,
  buttonRef,
}: {
  open: boolean;
  onClick: () => void;
  buttonRef: React.RefObject<HTMLButtonElement | null>;
}) {
  return (
    <button
      ref={buttonRef as React.RefObject<HTMLButtonElement>}
      type="button"
      className={open ? "ov-icon-btn is-active" : "ov-icon-btn"}
      aria-label="Add attachments, context, skills, or plugins"
      aria-expanded={open}
      title="Add attachments, context, skills, or plugins"
      onClick={onClick}
      style={
        open
          ? { background: "rgba(108,92,255,0.18)", borderColor: "var(--orvyn-purple)", color: "var(--orvyn-text)" }
          : undefined
      }
    >
      <IconPlus size={16} />
    </button>
  );
}
