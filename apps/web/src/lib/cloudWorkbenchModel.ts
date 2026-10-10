import type { AgentProgressEvent } from "./agentProgress";

export type WorkspaceTab = "Browser" | "Desktop" | "Code" | "Files" | "Changes" | "Terminal";
export type WorkspaceConnection = "idle" | "connecting" | "live" | "ended" | "error";

export function remoteInputAllowed(connection: WorkspaceConnection, owner: string | null, pictureReady: boolean, writable: boolean): boolean {
  return connection === "live" && owner === "user" && pictureReady && writable;
}

/** Follow facts from the current run; selecting a tab manually disables following. */
export function latestWorkspaceTab(events: AgentProgressEvent[]): WorkspaceTab | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    const tool = String(event.data?.tool ?? event.data?.name ?? "");
    if (event.type === "desktop.target") return event.data?.surface === "desktop" ? "Desktop" : "Browser";
    if (event.type.startsWith("terminal.")) return "Terminal";
    if (event.type === "file.edit" || event.type === "file.created") return "Changes";
    if (event.type === "tool.started") {
      if (tool.startsWith("browser_")) return "Browser";
      if (tool.startsWith("desktop_") || tool.startsWith("computer_")) return "Desktop";
      if (["write_file", "create_file", "apply_patch", "edit_file", "delete_file", "move_file"].includes(tool)) return "Changes";
      if (tool === "read_file") return "Code";
      if (tool === "list_directory") return "Files";
    }
  }
  return undefined;
}

/** Desktop streams have named base64 frame events, unlike the JSON browser stream. */
export function consumeDesktopFrames(buffer: string): { frames: { event: string; data: string }[]; rest: string } {
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? "";
  return {
    rest,
    frames: parts.flatMap((frame) => {
      const lines = frame.split(/\r?\n/);
      const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "message";
      const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
      return data ? [{ event, data }] : [];
    }),
  };
}

export function terminalTranscript(events: AgentProgressEvent[]): string {
  return events.flatMap((event) => {
    const data = event.data ?? {};
    if (event.type === "terminal.started") return [`$ ${String(data.command ?? "")}\n`];
    if (event.type === "terminal.output") return [String(data.data ?? "")];
    if (event.type === "terminal.completed") return [`\n[${data.exitOk === false ? "Command failed" : "Command finished"}]\n`];
    return [];
  }).join("").slice(-100_000);
}
