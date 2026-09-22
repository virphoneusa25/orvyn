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
  formatTokens,
  formatPercent,
  type ContextUsage,
  type UsageQuota,
} from "../contextUsage";

const SEVERITY_COLOR: Record<string, string> = {
  normal: "var(--orvyn-purple)",
  elevated: "var(--orvyn-yellow)",
  warning: "var(--orvyn-yellow)",
  critical: "var(--orvyn-red)",
};

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

export function ContextUsageMenu({ state }: { state: ComposerContextState }) {
  const [open, setOpen] = useState(false);
  const quotaState = useQuota(open);
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
      title="Context window and usage — tokens in the next model request, and what remains of your quotas"
      width={400}
      open={open}
      onOpenChange={setOpen}
      label={
        <>
          <span>◔</span>
          <span>{percent !== null ? formatPercent(percent, 0) : "Context"}</span>
        </>
      }
    >
      {(close) => (
        <div style={{ padding: "4px 2px", maxHeight: 360, overflowY: "auto" }}>
          {/* ── Section 1: context window ── */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "2px 8px 6px" }}>
            <span
              style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4 }}
              title="Tokens currently included in the next model request."
            >
              Context window
            </span>
            <span style={{ fontSize: 10.5, fontFamily: "var(--font-mono)", color: "var(--orvyn-text-secondary)" }}>
              {formatTokens(usage?.totalUsed ?? 0)} / {formatTokens(limit || null)}
              {percent !== null ? ` (${formatPercent(percent)})` : ""}
            </span>
          </div>
          <div style={{ height: 6, borderRadius: 3, background: "var(--orvyn-border-soft)", overflow: "hidden", margin: "0 8px 4px" }}>
            <div
              style={{
                width: `${Math.round((percent ?? 0) * 100)}%`,
                height: "100%",
                background: SEVERITY_COLOR[severity],
                transition: "width 240ms ease",
                borderRadius: 3,
              }}
            />
          </div>
          {warning && (
            <div style={{ fontSize: 10.5, color: severity === "critical" ? "var(--orvyn-red)" : "var(--orvyn-yellow)", padding: "2px 8px 6px" }}>
              {warning}
            </div>
          )}
          {overNewLimit && (
            <div style={{ fontSize: 10.5, color: "var(--orvyn-yellow)", padding: "2px 8px 6px" }}>
              Current context exceeds this model's window — the next run will compact it.
            </div>
          )}
          {shares.length > 0 && (
            <div style={{ padding: "2px 8px 4px" }}>
              {shares.map((c) => (
                <div
                  key={c.key}
                  style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, lineHeight: 1.8 }}
                  title={
                    c.key === "toolDefinitions"
                      ? "Tool definitions available to ORION."
                      : c.key === "projectContext"
                        ? "Retrieved code and project intelligence."
                        : c.key === "mcpTools"
                          ? "Tool schemas from connected MCP servers."
                          : undefined
                  }
                >
                  <span style={{ color: "var(--orvyn-text-secondary)" }}>{c.label}</span>
                  <span style={{ fontFamily: "var(--font-mono)", color: "var(--orvyn-text-muted)" }}>
                    {formatTokens(c.tokens)} · {formatPercent(c.share)}
                  </span>
                </div>
              ))}
            </div>
          )}
          {usage === null && (
            <div style={{ fontSize: 10.5, color: "var(--orvyn-text-muted)", padding: "2px 8px 6px" }}>
              No run yet — the context meter starts with the first model turn.
            </div>
          )}
          {typeof usage?.cacheHitRate === "number" && (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 10.5,
                padding: "4px 8px",
                borderTop: "1px solid var(--orvyn-border-soft)",
              }}
              title="Portion of reusable prompt tokens served from provider cache."
            >
              <span style={{ color: "var(--orvyn-text-secondary)" }}>Average cache hit rate</span>
              <span style={{ fontFamily: "var(--font-mono)" }}>{formatPercent(usage.cacheHitRate)}</span>
            </div>
          )}

          {/* ── Section 2: usage remaining ── */}
          <div style={{ borderTop: "1px solid var(--orvyn-border-soft)", marginTop: 4, padding: "6px 8px 2px" }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, marginBottom: 4 }}>Usage remaining</div>
            {quotaState.quota ? (
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5 }}>
                  <span style={{ color: "var(--orvyn-text-secondary)" }}>{quotaState.quota.label}</span>
                  <span style={{ fontFamily: "var(--font-mono)" }}>
                    {formatPercent((quotaState.quota.remaining ?? 0) / (quotaState.quota.limit ?? 1), 0)} remaining
                    {quotaState.quota.resetAt ? ` · resets ${new Date(quotaState.quota.resetAt).toLocaleDateString()}` : ""}
                  </span>
                </div>
                <div style={{ height: 4, borderRadius: 2, background: "var(--orvyn-border-soft)", overflow: "hidden", margin: "3px 0 4px" }}>
                  <div
                    style={{
                      width: `${Math.round(((quotaState.quota.remaining ?? 0) / (quotaState.quota.limit ?? 1)) * 100)}%`,
                      height: "100%",
                      background: "var(--orvyn-purple)",
                    }}
                  />
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 10.5, color: "var(--orvyn-text-muted)" }}>
                {quotaState.unavailable ? "Usage service unavailable" : "Usage tracking available · no quota limit configured"}
              </div>
            )}
            {quotaState.cycleTokens !== null && (
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, marginTop: 2 }}>
                <span style={{ color: "var(--orvyn-text-secondary)" }}>Tokens this cycle</span>
                <span style={{ fontFamily: "var(--font-mono)", color: "var(--orvyn-text-muted)" }}>{formatTokens(quotaState.cycleTokens)}</span>
              </div>
            )}
            <button
              onClick={() => {
                close();
                document.dispatchEvent(new CustomEvent("orvyn:nav", { detail: "usage" }));
              }}
              style={{ background: "transparent", border: "none", color: "var(--orvyn-purple-hi)", fontSize: 10.5, cursor: "pointer", padding: "4px 0 2px" }}
            >
              More →
            </button>
          </div>
        </div>
      )}
    </Dropdown>
  );
}
