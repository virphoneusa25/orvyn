import React, { useMemo, useState } from "react";
import { TerminalView, useTerminalSession } from "../BottomWorkPanel";
import { extractOrionCommands, type WorkspaceEvent } from "../../agentWorkspaceModel";
import { emptyBody, emptyTitle, ghostBtn } from "./workspaceChrome";

export function TerminalInspector({
  events,
  environmentLabel,
  environment,
}: {
  events: WorkspaceEvent[];
  environmentLabel?: string;
  environment?: "local" | "sandbox" | "cloud";
}) {
  const term = useTerminalSession();
  const commands = useMemo(() => extractOrionCommands(events), [events]);
  const [session, setSession] = useState<"orion" | "local">("orion");
  const [cleared, setCleared] = useState(false);
  const active = commands[commands.length - 1];
  const title = environmentLabel || (environment === "cloud" ? "Terminal · Cloud Worker" : environment === "sandbox" ? "Terminal · Sandbox" : "Terminal · Local");

  const showLocal = session === "local" || (!active && term.sessionId);

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderBottom: "1px solid var(--orvyn-border-soft)" }}>
        <span style={{ fontSize: 12, fontWeight: 650, color: "var(--orvyn-text)" }}>{title}</span>
        <select
          value={showLocal && !active ? "local" : session}
          onChange={(e) => setSession(e.target.value as "orion" | "local")}
          style={{
            background: "var(--orvyn-surface-2)",
            border: "1px solid var(--orvyn-border-soft)",
            color: "var(--orvyn-text)",
            borderRadius: 6,
            fontSize: 11,
            padding: "3px 6px",
          }}
        >
          {active && <option value="orion">Terminal 1 · ORION</option>}
          {environment !== "cloud" && environment !== "sandbox" && <option value="local">This environment</option>}
        </select>
        {active && (
          <span style={{ fontSize: 11.5, color: "var(--orvyn-text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {active.command} · {active.running ? "Running…" : "Done"}
          </span>
        )}
        <span style={{ marginLeft: "auto", display: "inline-flex", gap: 6 }}>
          {!term.sessionId && <button style={ghostBtn()} onClick={() => void term.start()}>New</button>}
          {term.sessionId && <button style={ghostBtn()} onClick={() => void term.start()}>Split</button>}
          <button style={ghostBtn()} onClick={() => setCleared(true)}>Clear</button>
        </span>
      </div>
      {session === "orion" && active ? (
        <pre
          style={{
            flex: 1,
            overflow: "auto",
            margin: 0,
            padding: 10,
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            lineHeight: 1.55,
            color: "var(--orvyn-text-secondary)",
            whiteSpace: "pre-wrap",
          }}
        >
          {cleared ? "" : active.output || (active.running ? "Running…" : "No output captured.")}
        </pre>
      ) : term.sessionId || term.busy ? (
        <TerminalView term={term} />
      ) : (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 20, textAlign: "center", gap: 10 }}>
          <div style={emptyTitle()}>No active command</div>
          <div style={emptyBody()}>ORION’s process output for this environment appears here. Start a shell only for the current execution target.</div>
          <button style={ghostBtn()} onClick={() => void term.start()}>
            {environment === "cloud" ? "Start Cloud Session" : environment === "sandbox" ? "Start Sandbox" : "Start Local Terminal"}
          </button>
        </div>
      )}
    </div>
  );
}
