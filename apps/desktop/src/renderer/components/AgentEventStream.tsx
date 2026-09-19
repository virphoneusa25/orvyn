import React, { useEffect, useRef, useState } from "react";
import { AgentComposer, Attachment } from "./AgentComposer";
import { AgentActivityList, liveActivityLabel, RunFooter } from "./AgentActivityList";
import { LiveActivity, MissionPlan } from "./MissionPlan";
import { isRunFinished, RunUsage, useAgentRun } from "../useAgentRun";
import { apiUrl, authHeaders } from "../connection";
import appIcon from "../assets/icon.png";
import { looksLikeImageRequest, stripImagePrefix, requestGeneratedImages } from "../imageIntent";
import { MessageContent } from "./MessageContent";

export function AgentEventStream({ projectRoot, attachRunId }: { projectRoot: string | null; attachRunId?: string | null }) {
  const [mode, setMode] = useState<string>("agent");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [instruction, setInstruction] = useState("");
  const [forceImage, setForceImage] = useState(false);
  const [imageNote, setImageNote] = useState<string | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const run = useAgentRun(projectRoot, { attachRunId });
  const live = liveActivityLabel(run.events);
  // "cancelling" counts as busy: the run is still winding down, so neither
  // sending nor a second Stop should be possible.
  const busy = run.status === "running" || run.status === "awaiting_approval" || run.status === "cancelling";

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [run.events.length, imageNote]);

  async function start(opts?: { forceImage?: boolean }) {
    const text = instruction.trim();
    if (!text) return;
    const slash = text.match(/^\/image\b/i);
    if (opts?.forceImage || forceImage || slash || looksLikeImageRequest(text)) {
      setForceImage(false);
      setImageBusy(true);
      try {
        const markdown = await requestGeneratedImages(stripImagePrefix(text), projectRoot, apiUrl, authHeaders);
        setImageNote(markdown);
        setInstruction("");
      } catch (err: any) {
        setImageNote(`Image generation failed: ${err.message}`);
      } finally {
        setImageBusy(false);
      }
      return;
    }
    const ok = await run.start({ instruction: text, mode, attachments });
    if (ok) setInstruction("");
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minWidth: 0, overflow: "hidden", color: "var(--text)", position: "relative" }}>
      <div
        ref={scrollerRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 120);
        }}
        style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: 12, minWidth: 0 }}
      >
        {run.error && (
          <div
            style={{
              background: "rgba(240,84,106,0.10)",
              border: "1px solid var(--danger)",
              borderRadius: "var(--radius)",
              padding: 10,
              fontSize: 12,
              marginBottom: 10,
            }}
          >
            {run.error}
          </div>
        )}
        {imageNote && (
          <div style={{ marginBottom: 12 }}>
            <MessageContent content={imageNote} />
          </div>
        )}
        {run.events.length === 0 && run.status === "idle" && !imageNote && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              padding: "36px 16px",
              textAlign: "center",
            }}
          >
            <img src={appIcon} alt="" width={34} height={34} style={{ borderRadius: 9, opacity: 0.9 }} />
            <div style={{ fontSize: 13, fontWeight: 600 }}>Astra is ready to work</div>
            <div style={{ fontSize: 11.5, color: "var(--text-muted)", maxWidth: 300, lineHeight: 1.6 }}>
              Describe a task below — Astra plans it, specialized agents execute through the permission-checked tool
              gateway, and every step streams here live.
            </div>
          </div>
        )}
        <AgentActivityList events={run.events} status={run.status} onApprove={run.approve} />
        <RunFooter events={run.events} runId={run.runId} finished={isRunFinished(run.status)} />
        <div ref={bottomRef} />
      </div>

      {/* The mockup's right-rail cards, fed by the same real event stream:
          mission steps from the Task Engine, activity from every tool call. */}
      <div style={{ flexShrink: 0, borderBottom: "1px solid var(--border)", maxHeight: "45%", overflowY: "auto", padding: "0 12px 8px" }}>
        <MissionPlan events={run.events} status={run.status} />
        <LiveActivity events={run.events} />
      </div>

      {!atBottom && (
        <button
          onClick={() => scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight, behavior: "smooth" })}
          style={{
            position: "absolute",
            bottom: 130,
            right: 18,
            width: 30,
            height: 30,
            borderRadius: "50%",
            border: "1px solid var(--border-strong)",
            background: "var(--bg-elevated)",
            color: "var(--text-secondary)",
            cursor: "pointer",
            fontSize: 14,
            lineHeight: 1,
            boxShadow: "0 2px 8px rgba(0,0,0,0.35)",
          }}
          title="Scroll to bottom"
        >
          ↓
        </button>
      )}

      {live && busy && (
        <div
          style={{
            padding: "6px 12px",
            fontSize: 11.5,
            color: "var(--accent)",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-elevated)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {live}
        </div>
      )}

      {run.usage && <UsageMeter usage={run.usage} />}

      <div
        style={{
          fontSize: 11,
          color: "var(--text-muted)",
          padding: "6px 10px 0",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          minWidth: 0,
        }}
        title={run.availableTools.map((t) => `${t.name}=${t.permission}`).join(" · ")}
      >
        {run.availableTools.length > 0
          ? `Tools: ${run.availableTools.map((t) => t.name).join(", ")}`
          : projectRoot
            ? "Tools not registered yet — start a run or reopen the folder"
            : "Workspace starting…"}
        {run.status !== "idle" && ` · ${run.status}`}
      </div>

      <AgentComposer
        hideModeDescription
        value={instruction}
        onChange={setInstruction}
        onSubmit={() => void start()}
        mode={mode}
        onModeChange={setMode}
        attachments={attachments}
        onAttachmentsChange={setAttachments}
        busy={busy}
        onStop={() => void run.stop()}
        disabled={!projectRoot || imageBusy || busy}
        placeholder={forceImage ? "Describe the image to generate…" : undefined}
        onSkill={(id) => {
          if (id === "image") {
            setForceImage(true);
            if (instruction.trim()) void start({ forceImage: true });
          }
        }}
      />
    </div>
  );
}

/**
 * Tokens spent and how full the context is. The context bar is the useful half:
 * it is the difference between an agent that is about to compact and one that
 * has plenty of room, which otherwise only shows up as unexplained slowdown.
 */
function UsageMeter({ usage }: { usage: RunUsage }) {
  const total = usage.promptTokens + usage.completionTokens;
  const pct = usage.contextBudget > 0 ? Math.min(100, (usage.contextTokens / usage.contextBudget) * 100) : 0;
  const hot = pct >= 80;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "5px 10px",
        borderTop: "1px solid var(--border)",
        fontSize: 11,
        color: "var(--text-muted)",
        minWidth: 0,
      }}
      title={[
        `Prompt tokens: ${usage.promptTokens.toLocaleString()}`,
        `Completion tokens: ${usage.completionTokens.toLocaleString()}`,
        `Model turns: ${usage.turns}`,
        usage.modelId ? `Model: ${usage.modelId}` : "",
        `Context: ~${usage.contextTokens.toLocaleString()} / ${usage.contextBudget.toLocaleString()} tokens`,
      ]
        .filter(Boolean)
        .join("\n")}
    >
      <span style={{ flexShrink: 0 }}>{total.toLocaleString()} tokens</span>
      <span style={{ flexShrink: 0, opacity: 0.6 }}>{usage.turns} turns</span>
      {usage.contextBudget > 0 && (
        <>
          <span
            style={{
              flex: 1,
              minWidth: 40,
              height: 4,
              borderRadius: 2,
              background: "var(--border)",
              overflow: "hidden",
            }}
          >
            <span
              style={{
                display: "block",
                width: `${pct}%`,
                height: "100%",
                background: hot ? "var(--warning)" : "var(--accent)",
              }}
            />
          </span>
          <span style={{ flexShrink: 0, color: hot ? "var(--warning)" : "var(--text-muted)" }}>
            {Math.round(pct)}% context
          </span>
        </>
      )}
    </div>
  );
}
