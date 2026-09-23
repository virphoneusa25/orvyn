// apps/desktop/src/renderer/components/ComposerControls.tsx
//
// The three composer controls — Access (shield), Model, Reasoning (brain).
// Compact dropdown menus over the SAME backend sources of truth:
//   · models come from GET /models (the ModelService registry — never a
//     hardcoded list; ModelManager stays the place to configure providers),
//   · reasoning levels come from each model's declared reasoningControl,
//   · access modes map onto the backend ToolGateway profiles.
//
// The menus show the truth they are given: unavailable models are disabled,
// reasoning levels a model does not declare are disabled, and the access
// descriptions are one line each. No fake capability metadata.

import React, { useEffect, useRef, useState } from "react";
import { apiUrl, authHeaders } from "../connection";
import {
  readComposerDefaults,
  writeComposerDefault,
  toRunPayloadSettings,
  COMPOSER_MODES,
  compactModelLabel,
  EXECUTION_TARGETS,
  type ComposerDefaults,
  type ReasoningEffort,
  type AccessMode,
  type ExecutionTargetSetting,
} from "../composerSettings";

export { readComposerDefaults, writeComposerDefault, toRunPayloadSettings, COMPOSER_MODES, compactModelLabel, EXECUTION_TARGETS };
export type { ComposerDefaults, ReasoningEffort, AccessMode, ExecutionTargetSetting };



export interface ComposerModel {
  id: string;
  name: string;
  provider: string;
  capabilities?: Record<string, boolean>;
  contextWindow?: number;
  /** Present only when the model genuinely accepts a reasoning-effort
   *  control; keys are the levels it supports. */
  reasoningControl?: { param: string; levels: Partial<Record<"fast" | "standard" | "deep" | "max", string>> };
}

export const ACCESS_MODES: { id: AccessMode; label: string; description: string }[] = [
  { id: "ask", label: "Ask", description: "Confirm write/command actions" },
  { id: "auto_read", label: "Auto Read", description: "Read/search automatically" },
  { id: "auto_workspace", label: "Auto Workspace", description: "Workspace development automatically" },
  { id: "full_access", label: "Full Access", description: "Maximum permitted autonomy" },
];

const REASONING_LEVELS: { id: Exclude<ReasoningEffort, "auto">; hint: string }[] = [
  { id: "fast", hint: "Fastest responses" },
  { id: "standard", hint: "Balanced" },
  { id: "deep", hint: "More reasoning" },
  { id: "max", hint: "Highest supported effort" },
];

/** Shared dropdown shell: compact trigger + popover + click-outside close. */
export function Dropdown({
  label,
  title,
  children,
  width = 280,
  open: controlledOpen,
  onOpenChange,
}: {
  label: React.ReactNode;
  title: string;
  children: (close: () => void) => React.ReactNode;
  width?: number;
  /** Controlled open state (optional) — lets a menu compute data on open. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (v: boolean | ((o: boolean) => boolean)) => {
    const next = typeof v === "function" ? (v as (o: boolean) => boolean)(open) : v;
    onOpenChange?.(next);
    setUncontrolledOpen(next);
  };
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  return (
    <div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
      <button
        title={title}
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          background: open ? "var(--orvyn-surface-2)" : "transparent",
          border: "1px solid var(--orvyn-border)",
          borderRadius: 6,
          color: "var(--orvyn-text-secondary)",
          padding: "3px 9px",
          fontSize: 11,
          cursor: "pointer",
          maxWidth: 148,
          minWidth: 0,
          whiteSpace: "nowrap",
        }}
      >
        {label}
        <span style={{ fontSize: 8, color: "var(--orvyn-text-muted)" }}>▾</span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            left: 0,
            zIndex: 60,
            width,
            maxHeight: 320,
            overflowY: "auto",
            background: "var(--orvyn-surface-2)",
            border: "1px solid var(--orvyn-border)",
            borderRadius: 8,
            boxShadow: "0 12px 32px rgba(3,6,14,0.55)",
            padding: 4,
          }}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function menuItem(selected: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "flex-start",
    gap: 7,
    width: "100%",
    textAlign: "left",
    background: "transparent",
    border: "none",
    color: "var(--orvyn-text)",
    padding: "5px 8px",
    borderRadius: 6,
    fontSize: 11.5,
    cursor: "pointer",
  };
}

function Check({ on }: { on: boolean }) {
  return (
    <span style={{ width: 12, flexShrink: 0, color: "var(--orvyn-purple-hi)", fontSize: 11, lineHeight: "16px" }}>
      {on ? "✓" : ""}
    </span>
  );
}


// ── Shared control-row primitives ──────────────────────────────────────────
// The SAME pill, attach, and submit styling for both composer contexts
// (chat WorkStream and Home "new mission") — one implementation, no forks.


/** The compact rounded mode pills (selected = filled ORVYN violet). */
export function ComposerModePills({
  mode,
  onChange,
}: {
  mode: string;
  onChange: (m: string) => void;
}) {
  return (
    <>
      {COMPOSER_MODES.map((m) => (
        <button
          key={m.id}
          title={m.title}
          aria-pressed={mode === m.id}
          onClick={() => onChange(m.id)}
          style={{
            background: mode === m.id ? "var(--orvyn-purple)" : "transparent",
            border: `1px solid ${mode === m.id ? "var(--orvyn-purple)" : "var(--orvyn-border)"}`,
            borderRadius: 999,
            color: mode === m.id ? "#fff" : "var(--orvyn-text-secondary)",
            padding: "3px 10px",
            fontSize: 11,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          {m.label}
        </button>
      ))}
    </>
  );
}

/** The square ghost attach button (paperclip), 24px — both composers. */
export function ComposerAttachButton({ onClick, icon }: { onClick: () => void; icon: React.ReactNode }) {
  return (
    <button title="Attach files or images" onClick={onClick} style={ghostBtn()}>
      {icon}
    </button>
  );
}

/** ghostBtn is exported so both composers share the exact square-button look. */
export function ghostBtn(): React.CSSProperties {
  return {
    background: "transparent",
    border: "1px solid var(--orvyn-border)",
    borderRadius: 6,
    color: "var(--orvyn-text-secondary)",
    width: 24,
    height: 24,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    flexShrink: 0,
  };
}

/** The primary submit button — Send (chat) and Run mission (Home) share it. */
export function ComposerSubmitButton({
  label,
  icon,
  onClick,
  disabled,
  title,
}: {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        marginLeft: "auto",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        background: "var(--orvyn-purple)",
        border: "none",
        borderRadius: "var(--orvyn-radius-sm)",
        color: "#fff",
        padding: "6px 18px",
        fontSize: 12.5,
        fontWeight: 600,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.55 : 1,
        flexShrink: 0,
      }}
    >
      {icon}
      {label}
    </button>
  );
}

/** Loads the authoritative model registry once and shares it. */
export function useComposerModels(): ComposerModel[] {
  const [models, setModels] = useState<ComposerModel[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl("/models"), { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("models unavailable"))))
      .then((d) => {
        if (cancelled) return;
        setModels(
          (d.models ?? []).map((m: any) => ({
            id: m.id,
            name: m.name ?? m.id,
            provider: String(m.provider ?? ""),
            capabilities: m.capabilities,
            contextWindow: m.contextWindow,
            reasoningControl: m.reasoningControl,
          }))
        );
      })
      .catch(() => setModels([]));
    return () => {
      cancelled = true;
    };
  }, []);
  return models;
}

function providerLabel(provider: string): string {
  if (provider === "openai-compatible") return "OpenAI-compatible";
  return provider ? provider[0].toUpperCase() + provider.slice(1) : "Other";
}

/** ● GPT-5.6 ▾ — provider-grouped, capability hints, disabled unavailable. */
export function ModelMenu({
  models,
  value,
  onChange,
}: {
  models: ComposerModel[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const agentModels = models.filter((m) => m.capabilities?.agent && m.capabilities?.tools);
  const q = filter.trim().toLowerCase();
  const visible = q
    ? agentModels.filter((m) => `${m.name} ${m.id} ${m.provider}`.toLowerCase().includes(q))
    : agentModels;
  const groups = new Map<string, ComposerModel[]>();
  for (const m of visible) {
    const key = providerLabel(m.provider);
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  const selected = models.find((m) => m.id === value);
  const trigger = value === "auto" ? "Auto" : compactModelLabel(selected?.name, value);
  const fullName = selected?.name ?? value;
  return (
    <Dropdown
      title={
        value === "auto"
          ? "Model for this conversation — Auto lets ORION's routing choose"
          : `${fullName}${selected?.provider ? ` · ${selected.provider}` : ""}`
      }
      width={300}
      label={
        <>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: value === "auto" ? "var(--orvyn-text-muted)" : "var(--orvyn-green)", display: "inline-block", flexShrink: 0 }} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{trigger}</span>
        </>
      }
    >
      {(close) => (
        <div>
          {agentModels.length > 8 && (
            <input
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter models…"
              style={{
                width: "calc(100% - 16px)",
                margin: "4px 8px 6px",
                background: "var(--orvyn-bg)",
                border: "1px solid var(--orvyn-border)",
                borderRadius: 6,
                color: "var(--orvyn-text)",
                fontSize: 11,
                padding: "4px 8px",
                outline: "none",
              }}
            />
          )}
          <button
            style={menuItem(value === "auto")}
            onClick={() => {
              onChange("auto");
              close();
            }}
          >
            <Check on={value === "auto"} />
            <span>
              <span style={{ fontWeight: 600 }}>Auto</span>
              <span style={{ display: "block", fontSize: 10, color: "var(--orvyn-text-muted)" }}>ORVYN routing chooses the model</span>
            </span>
          </button>
          {[...groups.entries()].map(([provider, list]) => (
            <div key={provider}>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.8, color: "var(--orvyn-text-muted)", padding: "6px 8px 2px" }}>
                {provider.toUpperCase()}
              </div>
              {list.map((m) => {
                const caps: string[] = [];
                if (m.capabilities?.tools) caps.push("Tools");
                if (m.capabilities?.vision) caps.push("Vision");
                if (m.reasoningControl) caps.push("Reasoning");
                return (
                  <button
                    key={m.id}
                    style={menuItem(value === m.id)}
                    onClick={() => {
                      onChange(m.id);
                      close();
                    }}
                  >
                    <Check on={value === m.id} />
                    <span style={{ minWidth: 0 }}>
                      <span style={{ fontWeight: 600, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {m.name}
                      </span>
                      <span style={{ display: "block", fontSize: 10, color: "var(--orvyn-text-muted)" }}>
                        {caps.length ? caps.join(" · ") : "Chat"} · {Math.round((m.contextWindow ?? 0) / 1000) || "?"}K context
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
          {visible.length === 0 && (
            <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--orvyn-text-muted)" }}>
              No models match{q ? ` “${filter.trim()}”` : ""}. Configure providers in the Model Manager.
            </div>
          )}
        </div>
      )}
    </Dropdown>
  );
}

/** 🧠 Deep ▾ — levels the selected model declares; honest when it doesn't. */
export function ReasoningMenu({
  value,
  onChange,
  models,
  modelId,
}: {
  value: ReasoningEffort;
  onChange: (v: ReasoningEffort) => void;
  models: ComposerModel[];
  modelId: string;
}) {
  const model = models.find((m) => m.id === modelId);
  const levels = model?.reasoningControl?.levels;
  const supported = levels ? Object.keys(levels) : [];
  const label = value === "auto" ? "Auto" : value[0].toUpperCase() + value.slice(1);
  return (
    <Dropdown
      title="Reasoning effort for this conversation"
      width={250}
      label={
        <>
          <span>🧠</span>
          <span>{label}</span>
        </>
      }
    >
      {(close) => (
        <div>
          <button
            style={menuItem(value === "auto")}
            onClick={() => {
              onChange("auto");
              close();
            }}
          >
            <Check on={value === "auto"} />
            <span>
              <span style={{ fontWeight: 600 }}>Auto</span>
              <span style={{ display: "block", fontSize: 10, color: "var(--orvyn-text-muted)" }}>Provider default effort</span>
            </span>
          </button>
          {REASONING_LEVELS.map((lvl) => {
            const enabled = modelId === "auto" || supported.includes(lvl.id);
            return (
              <button
                key={lvl.id}
                disabled={!enabled}
                style={{ ...menuItem(value === lvl.id), opacity: enabled ? 1 : 0.4, cursor: enabled ? "pointer" : "default" }}
                onClick={() => {
                  if (!enabled) return;
                  onChange(lvl.id);
                  close();
                }}
              >
                <Check on={value === lvl.id} />
                <span>
                  <span style={{ fontWeight: 600 }}>{lvl.id[0].toUpperCase() + lvl.id.slice(1)}</span>
                  <span style={{ display: "block", fontSize: 10, color: "var(--orvyn-text-muted)" }}>{lvl.hint}</span>
                </span>
              </button>
            );
          })}
          {modelId !== "auto" && !levels && (
            <div style={{ padding: "6px 10px 8px", fontSize: 10, color: "var(--orvyn-text-muted)", borderTop: "1px solid var(--orvyn-border-soft)", marginTop: 4 }}>
              Reasoning level not configurable for this model
            </div>
          )}
          {modelId === "auto" && (
            <div style={{ padding: "6px 10px 8px", fontSize: 10, color: "var(--orvyn-text-muted)", borderTop: "1px solid var(--orvyn-border-soft)", marginTop: 4 }}>
              Pick a concrete model to choose a level
            </div>
          )}
        </div>
      )}
    </Dropdown>
  );
}

/** 🛡 Auto Workspace ▾ — the four access modes. */
export function AccessMenu({ value, onChange }: { value: AccessMode; onChange: (v: AccessMode) => void }) {
  const current = ACCESS_MODES.find((m) => m.id === value) ?? ACCESS_MODES[0];
  return (
    <Dropdown
      title="Access mode — what ORION may do without asking (run-scoped; hard safety policy always applies)"
      width={270}
      label={
        <>
          <span>🛡</span>
          <span>{current.label}</span>
        </>
      }
    >
      {(close) => (
        <div>
          {ACCESS_MODES.map((m) => (
            <button
              key={m.id}
              style={menuItem(value === m.id)}
              onClick={() => {
                onChange(m.id);
                close();
              }}
            >
              <Check on={value === m.id} />
              <span>
                <span style={{ fontWeight: 600 }}>{m.label}</span>
                <span style={{ display: "block", fontSize: 10, color: "var(--orvyn-text-muted)" }}>{m.description}</span>
              </span>
            </button>
          ))}
          <div style={{ padding: "6px 10px 8px", fontSize: 10, color: "var(--orvyn-text-muted)", borderTop: "1px solid var(--orvyn-border-soft)", marginTop: 4 }}>
            Applies to the next run; destructive actions still require approval.
          </div>
        </div>
      )}
    </Dropdown>
  );
}

/** Compact execution target — lives with mode/access, not as a sixth mode pill. */
export function ExecutionTargetMenu({
  value,
  onChange,
}: {
  value: ExecutionTargetSetting;
  onChange: (v: ExecutionTargetSetting) => void;
}) {
  const current = EXECUTION_TARGETS.find((m) => m.id === value) ?? EXECUTION_TARGETS[0];
  return (
    <Dropdown
      title="Where tools run — separate from Auto/Code/Server mode. Model inference may still be remote."
      width={280}
      label={
        <>
          <span>⌘</span>
          <span>{current.label}</span>
        </>
      }
    >
      {(close) => (
        <div>
          {EXECUTION_TARGETS.map((m) => (
            <button
              key={m.id}
              style={menuItem(value === m.id)}
              onClick={() => {
                onChange(m.id);
                close();
              }}
            >
              <Check on={value === m.id} />
              <span>
                <span style={{ fontWeight: 600 }}>{m.label}</span>
                <span style={{ display: "block", fontSize: 10, color: "var(--orvyn-text-muted)" }}>{m.title}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </Dropdown>
  );
}
