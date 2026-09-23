import type { AITool, ToolResult } from "../ToolTypes";
import type { ArtifactService } from "../../artifacts/ArtifactService";
import { errorArtifactPayload, successArtifactPayload } from "../../artifacts/artifactContract";

function json(value: unknown): string {
  return JSON.stringify(value);
}

export function makeArtifactCreateTool(artifacts: ArtifactService): AITool {
  return {
    name: "artifact_create",
    description:
      "Create a downloadable file in ORVYN artifact storage. Use this for logos, PNGs, PDFs, text, HTML, JSON, and other deliverables when no local project folder is required. Success only after bytes are persisted. Files appear in Files → Generated and as a chat card.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Filename with extension, e.g. virphone-logo.png or test-output.txt" },
        content: { type: "string", description: "Text content (required unless generating binary via generate_image)" },
        kind: { type: "string", description: "generated | document | download | upload | run | file" },
        media_type: { type: "string" },
      },
      required: ["name", "content"],
    },
    defaultPermission: "ask",
    async execute(args): Promise<ToolResult> {
      try {
        const rec = await artifacts.persistArtifact({
          name: String(args.name ?? ""),
          content: args.content != null ? String(args.content) : "",
          kind: args.kind ? String(args.kind) : "generated",
          mediaType: args.media_type ? String(args.media_type) : undefined,
          sourceTool: "artifact_create",
        });
        if (!rec.artifactId) throw new Error("Persistence returned no artifactId.");
        const art = artifacts.toToolResult(rec);
        return {
          ok: true,
          artifacts: [art],
          output: json({
            ...successArtifactPayload(art),
            kind: rec.kind,
            message: `Persisted ${rec.name} as artifact ${rec.artifactId}.`,
          }),
        };
      } catch (e: any) {
        return { ok: false, error: e.message, output: json(errorArtifactPayload("ARTIFACT_CREATE_FAILED", e.message)) };
      }
    },
  };
}

export function makeArtifactWriteTool(artifacts: ArtifactService): AITool {
  return {
    name: "artifact_write",
    description: "Overwrite an existing ORVYN artifact by id with new text or data. Success only after the new bytes are persisted.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        content: { type: "string" },
      },
      required: ["id", "content"],
    },
    defaultPermission: "ask",
    async execute(args): Promise<ToolResult> {
      try {
        const rec = await artifacts.writeArtifact(String(args.id ?? ""), String(args.content ?? ""));
        if (!rec.artifactId) throw new Error("Write returned no artifactId.");
        const art = artifacts.toToolResult(rec);
        return { ok: true, artifacts: [art], output: json(successArtifactPayload(art)) };
      } catch (e: any) {
        return { ok: false, error: e.message, output: json(errorArtifactPayload("ARTIFACT_WRITE_FAILED", e.message)) };
      }
    },
  };
}

export function makeArtifactListTool(artifacts: ArtifactService): AITool {
  return {
    name: "artifact_list",
    description: "List files in ORVYN artifact storage (generated images, documents, downloads, uploads). Use an explicit query — do not dump the whole library into context. Works without a local project folder.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", description: "Optional filter: generated, document, download, upload, run, file" },
        query: { type: "string", description: "Optional name/mime/run search" },
      },
    },
    defaultPermission: "allowed",
    async execute(args): Promise<ToolResult> {
      try {
        const items = args.query
          ? artifacts.search(String(args.query))
          : artifacts.listArtifacts({ kind: args.kind ? String(args.kind) : undefined });
        return {
          ok: true,
          output: json({
            artifacts: items.slice(0, 40).map((a) => ({
              artifactId: a.artifactId,
              name: a.name,
              kind: a.kind,
              mimeType: a.mimeType,
              size: a.size,
              downloadUrl: `/artifacts/${a.artifactId}/download`,
              createdAt: a.createdAt,
            })),
          }),
        };
      } catch (e: any) {
        return { ok: false, error: e.message };
      }
    },
  };
}

export function makeArtifactReadTool(artifacts: ArtifactService): AITool {
  return {
    name: "artifact_get",
    description: "Read an ORVYN artifact by id. Text is returned as UTF-8; binary files report size and media type.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    defaultPermission: "allowed",
    async execute(args): Promise<ToolResult> {
      try {
        const { record, bytes } = await artifacts.read(String(args.id ?? ""));
        const textish = record.mimeType.startsWith("text/") || /\.(md|txt|json|csv|html|svg)$/i.test(record.name);
        return {
          ok: true,
          output: json({
            artifactId: record.artifactId,
            name: record.name,
            kind: record.kind,
            mimeType: record.mimeType,
            size: bytes.length,
            sha256: record.sha256,
            downloadUrl: `/artifacts/${record.artifactId}/download`,
            content: textish ? bytes.toString("utf-8").slice(0, 20_000) : undefined,
            note: textish ? undefined : "Binary artifact. Use artifact_download or the Files pane.",
          }),
        };
      } catch (e: any) {
        return { ok: false, error: e.message };
      }
    },
  };
}

export function makeArtifactDeleteTool(artifacts: ArtifactService): AITool {
  return {
    name: "artifact_delete",
    description: "Delete an ORVYN artifact by id. Requires confirmation from the user.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    defaultPermission: "ask",
    async execute(args): Promise<ToolResult> {
      try {
        await artifacts.deleteArtifact(String(args.id ?? ""));
        return { ok: true, output: json({ deleted: String(args.id ?? "") }) };
      } catch (e: any) {
        return { ok: false, error: e.message };
      }
    },
  };
}

export function makeArtifactDownloadTool(artifacts: ArtifactService): AITool {
  return {
    name: "artifact_download",
    description: "Return a download URL and metadata for an ORVYN artifact so the user can save it. Does not delete the artifact.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    defaultPermission: "allowed",
    async execute(args): Promise<ToolResult> {
      try {
        const { record, filename } = await artifacts.getDownload(String(args.id ?? ""));
        return {
          ok: true,
          output: json({
            artifactId: record.artifactId,
            name: filename,
            mimeType: record.mimeType,
            size: record.size,
            sha256: record.sha256,
            downloadUrl: `/artifacts/${record.artifactId}/download`,
          }),
        };
      } catch (e: any) {
        return { ok: false, error: e.message };
      }
    },
  };
}

export function registerArtifactTools(register: (tool: AITool) => void, artifacts: ArtifactService): void {
  register(makeArtifactCreateTool(artifacts));
  register(makeArtifactWriteTool(artifacts));
  register(makeArtifactListTool(artifacts));
  const get = makeArtifactReadTool(artifacts);
  register(get);
  register({ ...get, name: "artifact_read" });
  register(makeArtifactDeleteTool(artifacts));
  const download = makeArtifactDownloadTool(artifacts);
  register(download);
  register({ ...download, name: "artifact_get_download" });
}
