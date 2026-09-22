import React, { useMemo, useState } from "react";
import { TerminalView, useTerminalSession } from "../BottomWorkPanel";
import { extractOrionCommands, type WorkspaceEvent } from "../../agentWorkspaceModel";
import { emptyBody, emptyTitle, ghostBtn } from "./workspaceChrome";

export function TerminalInspector({ events }: { events: WorkspaceEvent[] }) {
  const term = useTerminalSession();
  const commands = useMemo(() => extractOrionCommands(events), [events]);
  const [session, setSession] = useState<"orion" | "local">("orion");
  const active = commands[commands.length - 1];

  const showLocal = session === "local" || (!active && term.sessionId);

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderBottom: "1px solid var(--orvyn-border-soft)" }}>
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
          {active && <option value="orion">ORION</option>}
          <option value="local">Local</option>
        </select>
        {active && (
          <span style={{ fontSize: 11.5, color: "var(--orvyn-text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {active.command} · {active.running ? "Running…" : "Done"}
          </span>
        )}
        <span style={{ marginLeft: "auto" }}>
          {!term.sessionId && <button style={ghostBtn()} onClick={() => void term.start()}>Start local</button>}
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
          {active.output || (active.running ? "Running…" : "No output captured.")}
        </pre>
      ) : term.sessionId || term.busy ? (
        <TerminalView term={term} />
      ) : (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 20, textAlign: "center", gap: 8 }}>
          <div style={emptyTitle()}>No active command</div>
          <div style={emptyBody()}>Commands ORION runs will appear here. Local shell uses the same PTY as the bottom terminal.</div>
        </div>
      )}
    </div>
  );
}
