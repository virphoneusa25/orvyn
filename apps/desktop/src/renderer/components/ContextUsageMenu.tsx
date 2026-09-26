// apps/desktop/src/renderer/components/ContextUsageMenu.tsx
//
// The compact "◔ 44%" context/usage trigger + popover, shared by the chat
// and Home composers. Every number shown is backend/provider-reported:
// context totals + breakdown come from usage.updated (pre-request
// accounting in the runtime), the quota row comes from GET /usage, and the
// cache row only appears when the provider actually reports cached tokens.

import React, { useEffect, useState } from "react";
import { apiUrl, authHeaders } from "../connection";
import { Dropdown } from "./ComposerControls";
import {
  contextPercent,
  severityOf,
  contextWarning,
  exceedsLimit,
  categoryShares,
  quotaFromServer,
  formatPercent,
  type ContextBreakdown,
  type ContextUsage,
  type UsageQuota,
} from "../contextUsage";

const ROWS: { key: keyof ContextBreakdown; label: string; color: string }[] = [
  { key: "messages", label: "Messages", color: "#3b82f6" },
  { key: "toolDefinitions", label: "System tools", color: "#60a5fa" },
  { key: "systemPrompt", label: "System prompt", color: "#a78bfa" },
  { key: "skills", label: "Skills", color: "#34d399" },
  { key: "mcpTools", label: "MCP tools", color: "#2dd4bf" },
  { key: "meta", label: "Meta context", color: "#6b7280" },
];

function percentLabel(share: number): string {
  const n = share * 100;
  if (Math.abs(n - Math.round(n)) < 0.05) return `${Math.round(n)}%`;
  return `${n.toFixed(1)}%`;
}

function headerTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

/** The live context numbers the popover renders: the active (or most
 *  recent) run's usage event plus the selected model's registry window. */
export interface ComposerContextState {
  usage?: {
    contextTokens?: number;
    contextWindow?: number;
    contextBreakdown?: Record<string, number>;
    cacheHitRate?: number;
  } | null;
  /** Selected model's registry contextWindow (limit before any run). */
  modelContextWindow?: number;
}

/** Fetches the real server quota once per popover open (no polling). */
function useQuota(open: boolean): { quota: UsageQuota | null; cycleTokens: number | null; unavailable: boolean } {
  const [state, setState] = useState<{ quota: UsageQuota | null; cycleTokens: number | null; unavailable: boolean }>({
    quota: null,
    cycleTokens: null,
    unavailable: false,
  });
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch(apiUrl("/usage"), { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("usage unavailable"))))
      .then((d) => {
        if (cancelled) return;
        const totals = d?.totals ?? {};
        setState({
          quota: quotaFromServer(d?.quota),
          cycleTokens: Number(totals.promptTokens ?? 0) + Number(totals.completionTokens ?? 0) || null,
          unavailable: false,
        });
      })
      .catch(() => {
        if (!cancelled) setState({ quota: null, cycleTokens: null, unavailable: true });
      });
    return () => {
      cancelled = true;
    };
  }, [open]);
  return state;
}

interface CreditWindow {
  remaining: number | null;
  resetAt: number | null;
}

function useCreditWindows(open: boolean): { fiveHour: CreditWindow; weekly: CreditWindow; credits: CreditWindow } {
  const empty: CreditWindow = { remaining: null, resetAt: null };
  const [windows, setWindows] = useState({ fiveHour: empty, weekly: empty, credits: empty });
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch(apiUrl("/billing"), { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        if (cancelled) return;
        const w = d?.wallet?.windows;
        const read = (row?: { used?: number; limit?: number; resetAt?: number }): CreditWindow => {
          const limit = Number(row?.limit ?? 0);
          return {
            remaining: limit > 0 ? Math.max(0, Math.min(1, (limit - Number(row?.used ?? 0)) / limit)) : null,
            resetAt: Number(row?.resetAt) > 0 ? Number(row?.resetAt) : null,
          };
        };
        setWindows({
          fiveHour: read(w?.fiveHour),
          weekly: read(w?.sevenDay),
          credits: read(w?.cycle),
        });
      })
      .catch(() => {
        if (!cancelled) setWindows({ fiveHour: empty, weekly: empty, credits: empty });
      });
    return () => { cancelled = true; };
  }, [open]);
  return windows;
}

function resetLabel(at: number | null, kind: "time" | "date"): string {
  if (!at) return "Reset —";
  const d = new Date(at);
  if (kind === "time") return `Reset ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  return `Reset ${d.toLocaleDateString([], { month: "short", day: "numeric" })}`;
}

export function ContextUsageMenu({ state }: { state: ComposerContextState }) {
  const [open, setOpen] = useState(false);
  const quotaState = useQuota(open);
  const creditWindows = useCreditWindows(open);
  const limit = state.usage?.contextWindow ?? state.modelContextWindow ?? 0;
  const usage: ContextUsage | null = state.usage?.contextTokens
    ? {
        totalUsed: state.usage.contextTokens,
        contextLimit: limit,
        categories: state.usage.contextBreakdown,
        cacheHitRate: state.usage.cacheHitRate,
      }
    : null;
  const percent = contextPercent(usage);
  const severity = severityOf(percent);
  const warning = contextWarning(percent);
  const shares = open ? categoryShares(usage) : [];
  const overNewLimit = open ? exceedsLimit(usage, state.modelContextWindow ?? limit) : false;

  return (
    <Dropdown
      title="Context usage — tokens in the next model request, and what remains of your quotas"
      width={360}
      maxHeight={520}
      open={open}
      onOpenChange={setOpen}
      label={
        <>
          <span>◔</span>
          <span>{percent !== null ? formatPercent(percent, 0) : "Context"}</span>
        </>
      }
    >
      {(close) => {
        const byKey = new Map(shares.map((c) => [c.key, c.share]));
        const five = creditWindows.fiveHour.remaining ?? (quotaState.quota ? (quotaState.quota.remaining ?? 0) / (quotaState.quota.limit ?? 1) : null);
        return (
        <div style={{ padding: "8px 10px 10px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 650 }} title="Tokens currently included in the next model request.">
              Context usage
              <span style={{ width: 14, height: 14, borderRadius: "50%", border: "1px solid #66708a", color: "#8b95ad", fontSize: 9, display: "inline-grid", placeItems: "center" }}>i</span>
            </span>
            <span style={{ fontSize: 12, color: "#c5d0e4", fontVariantNumeric: "tabular-nums" }}>
              {headerTokens(usage?.totalUsed ?? 0)}/{limit > 0 ? headerTokens(limit) : "—"}
              {percent !== null ? ` (${percentLabel(percent)})` : ""}
            </span>
          </div>
          <div style={{ height: 6, borderRadius: 99, background: "#1c2638", overflow: "hidden", margin: "10px 0 12px" }}>
            <div style={{ width: `${Math.round((percent ?? 0) * 100)}%`, height: "100%", borderRadius: 99, background: "linear-gradient(90deg, #3b82f6, #22d3ee 55%, #a78bfa)" }} />
          </div>
          {warning && (
            <div style={{ fontSize: 11, color: severity === "critical" ? "#f87171" : "#fbbf24", marginTop: -6, marginBottom: 8 }}>{warning}</div>
          )}
          {overNewLimit && (
            <div style={{ fontSize: 11, color: "#fbbf24", marginBottom: 8 }}>Current context exceeds this model's window — the next run will compact it.</div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {ROWS.map((row) => (
              <div key={row.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12.5 }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "#d5deef" }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: row.color, flexShrink: 0 }} />
                  {row.label}
                </span>
                <span style={{ color: "#c5d0e4", fontVariantNumeric: "tabular-nums" }}>{percentLabel(byKey.get(row.key) ?? 0)}</span>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, paddingTop: 10, borderTop: "1px solid #1c2638", fontSize: 12.5 }}>
            <span style={{ color: "#9aa6bd" }}>Average cache hit rate</span>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>{typeof usage?.cacheHitRate === "number" ? percentLabel(usage.cacheHitRate) : "—"}</span>
          </div>
          <div style={{ borderTop: "1px solid #1c2638", marginTop: 10, paddingTop: 10 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 650 }}>Usage remaining</span>
              <button
                onClick={() => {
                  close();
                  document.dispatchEvent(new CustomEvent("orvyn:nav", { detail: "usage" }));
                }}
                style={{ background: "transparent", border: "none", color: "#9aa6bd", fontSize: 12, cursor: "pointer", padding: 0 }}
              >
                More &gt;
              </button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              <RemainCard label="5 hours" hint={resetLabel(creditWindows.fiveHour.resetAt, "time")} value={five} color="#3b82f6" />
              <RemainCard label="Weekly" hint={resetLabel(creditWindows.weekly.resetAt, "date")} value={creditWindows.weekly.remaining} color="#3b82f6" />
              <RemainCard label="MCP Credits" hint={resetLabel(creditWindows.credits.resetAt, "date")} value={creditWindows.credits.remaining} color="#8b5cf6" />
            </div>
          </div>
        </div>
        );
      }}
    </Dropdown>
  );
}

function RemainCard({ label, hint, value, color }: { label: string; hint: string; value: number | null; color: string }) {
  const shown = value === null ? "—" : percentLabel(value);
  const width = value === null ? 0 : Math.round(value * 100);
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 650 }}>{label}</div>
      <div style={{ fontSize: 10.5, color: "#8b95ad", marginTop: 1 }}>{hint}</div>
      <div style={{ fontSize: 18, fontWeight: 700, margin: "6px 0 6px", fontVariantNumeric: "tabular-nums" }}>{shown}</div>
      <div style={{ height: 4, borderRadius: 99, background: "#1c2638", overflow: "hidden" }}>
        <div style={{ width: `${width}%`, height: "100%", borderRadius: 99, background: color }} />
      </div>
    </div>
  );
}
