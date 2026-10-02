import type { AgentProgressEvent } from "./agentProgress";

export interface FileRef { artifactId: string; name: string; mimeType: string }

const FILE_PRODUCING_TOOLS = new Set([
  "generate_image",
  "create_document",
  "create_zip",
  "artifact_create",
  "artifact_write",
]);

/** Office/PDF drops are parsed on the server before the model sees them. */
export function extractableDocument(name: string): boolean {
  return /\.(docx|pdf|xlsx|pptx)$/i.test(name);
}

export function wrapFileForModel(name: string, content: string): string {
  if (/--- START FILE: /.test(content) && /--- END FILE/.test(content)) return content;
  return `--- START FILE: ${name} ---\n${content}\n--- END FILE: ${name} ---`;
}

export function artifactsFromEvents(events: AgentProgressEvent[]): FileRef[] {
  const out: FileRef[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.type !== "artifact.created" && event.type !== "image.generated") continue;
    const data = event.data ?? {};
    const artifactId = String(data.artifactId ?? data.id ?? "");
    if (!artifactId || seen.has(artifactId)) continue;
    seen.add(artifactId);
    out.push({
      artifactId,
      name: String(data.name ?? data.filename ?? "file"),
      mimeType: String(data.mimeType ?? data.mediaType ?? ""),
    });
  }
  return out;
}

/** File-producing tools that have started but have not persisted an artifact yet. */
export function generatingFilesFromEvents(events: AgentProgressEvent[]): { name: string }[] {
  const names = new Map<string, string>();
  const done = new Set<string>();
  for (const event of events) {
    const data = event.data ?? {};
    const callId = String(data.callId ?? "");
    const tool = String(data.tool ?? data.name ?? "");
    const args = (data.args ?? data.input) as Record<string, unknown> | undefined;
    const named = args ? String(args.name ?? args.path ?? "") : "";
    if (event.type === "tool.started" && FILE_PRODUCING_TOOLS.has(tool) && callId) {
      names.set(callId, named || tool.replace(/_/g, " "));
    }
    if (event.type === "tool.input" && callId && names.has(callId) && named) names.set(callId, named);
    if ((event.type === "tool.completed" || event.type === "tool.failed") && callId) done.add(callId);
    if (event.type === "artifact.created" || event.type === "image.generated") {
      if (callId) done.add(callId);
      else {
        const first = [...names.keys()].find((id) => !done.has(id));
        if (first) done.add(first);
      }
    }
  }
  const readyNames = new Set(artifactsFromEvents(events).map((f) => f.name.toLowerCase()));
  return [...names.entries()]
    .filter(([id, name]) => !done.has(id) && !readyNames.has(name.toLowerCase()))
    .map(([, name]) => ({ name: name.split(/[\\/]/).pop() || name }));
}
