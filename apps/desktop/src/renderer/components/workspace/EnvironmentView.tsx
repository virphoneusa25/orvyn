import React from "react";
import type { WorkbenchEnvironment } from "../../workbenchEnvironment";
import { environmentSummary } from "../../workbenchEnvironment";
import { emptyBody } from "./workspaceChrome";

export function EnvironmentView({
  environment,
  projectRoot,
  runId,
  ports,
}: {
  environment: WorkbenchEnvironment;
  projectRoot: string | null;
  runId?: string | null;
  ports: Array<{ port: number; command?: string; status: string }>;
}) {
  const info = environmentSummary(environment, { projectRoot, runId });
  return (
    <div data-testid="workbench-environment" style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 650 }}>{info.label} environment</div>
        <div style={emptyBody()}>Runtime details for the current execution target. Secret values are never shown.</div>
      </div>
      <Row label="Type" value={info.label} />
      <Row label="Working directory" value={info.workingDirectory} />
      <Row label="Runtime" value={info.runtime} />
      <Row label="Install" value={info.installScript} />
      <Row label="Start" value={info.startScript} />
      <Row label="Limits" value={info.limits} />
      <Row label="Variables" value="Set for this environment — values are never shown" />
      <Row label="Run" value={runId || "No active run"} />
      <div>
        <div style={{ fontSize: 11, color: "var(--orvyn-text-muted)", marginBottom: 6 }}>Ports</div>
        {ports.length === 0 ? (
          <div style={emptyBody()}>No listening services detected.</div>
        ) : (
          ports.map((p) => (
            <div key={p.port} style={{ fontSize: 12, fontFamily: "var(--font-mono)", padding: "4px 0" }}>
              :{p.port} · {p.command || "service"} · {p.status}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, letterSpacing: 0.6, color: "var(--orvyn-text-muted)" }}>{label.toUpperCase()}</div>
      <div style={{ fontSize: 12.5, marginTop: 3, wordBreak: "break-all" }}>{value}</div>
    </div>
  );
}
