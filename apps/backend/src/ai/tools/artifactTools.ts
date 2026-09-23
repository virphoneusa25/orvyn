import type { AITool, ToolResult } from "../ToolTypes";
import type { ArtifactService } from "../../artifacts/ArtifactService";

function json(value: unknown): string {
  return JSON.stringify(value);
}

export function makeArtifactCreateTool(artifacts: ArtifactService): AITool {
  return {
    name: "artifact_create",
    description:
      "Create a downloadable file in ORVYN artifact storage. Use this for logos, PNGs, PDFs, and other deliverables when no local project folder is required. Files appear in Files → Generated or Run Artifacts and as chat download cards.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Filename with extension, e.g. virphone-logo.png" },
        content: { type: "string", description: "Text content, or omit when writing binary via generate_image" },
        kind: { type: "string", description: "generated | document | download | upload | run | file" },
        media_type: { type: "string" },
      },
      required: ["name"],
    },
    defaultPermission: "ask",
    async execute(args): Promise<ToolResult> {
      try {
        const rec = await artifacts.create({
          name: String(args.name ?? ""),
          content: args.content != null ? String(args.content) : "",
          kind: args.kind ? String(args.kind) : "file",
          mediaType: args.media_type ? String(args.media_type) : undefined,
        });
        return {
          ok: true,
          output: json({
            id: rec.id,
            name: rec.name,
            path: rec.path,
            kind: rec.kind,
            mediaType: rec.mediaType,
            downloadPath: `/artifacts/${rec.id}/download`,
            message: `Created ${rec.name}. Open it from Files or download from the chat card.`,
          }),
        };
      } catch (e: any) {
        return { ok: false, error: e.message };
      }
    },
  };
}

export function makeArtifactWriteTool(artifacts: ArtifactService): AITool {
  return {
    name: "artifact_write",
    description: "Overwrite an existing ORVYN artifact by id with new text or data.",
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
        const rec = await artifacts.write(String(args.id ?? ""), String(args.content ?? ""));
        return { ok: true, output: json({ id: rec.id, name: rec.name, path: rec.path, downloadPath: `/artifacts/${rec.id}/download` }) };
      } catch (e: any) {
        return { ok: false, error: e.message };
      }
    },
  };
}

export function makeArtifactListTool(artifacts: ArtifactService): AITool {
  return {
    name: "artifact_list",
    description: "List files in ORVYN artifact storage (generated images, documents, downloads, uploads). Works without a local project folder.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", description: "Optional filter: generated, document, download, upload, run, file" },
      },
    },
    defaultPermission: "allowed",
    async execute(args): Promise<ToolResult> {
      try {
        const items = artifacts.list({ kind: args.kind ? String(args.kind) : undefined });
        return {
          ok: true,
          output: json({
            artifacts: items.map((a) => ({
              id: a.id,
              name: a.name,
              path: a.path,
              kind: a.kind,
              mediaType: a.mediaType,
              downloadPath: `/artifacts/${a.id}/download`,
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
    name: "artifact_read",
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
        const textish = (record.mediaType ?? "").startsWith("text/") || /\.(md|txt|json|csv|html|svg)$/i.test(record.name);
        return {
          ok: true,
          output: json({
            id: record.id,
            name: record.name,
            path: record.path,
            kind: record.kind,
            mediaType: record.mediaType,
            bytes: bytes.length,
            downloadPath: `/artifacts/${record.id}/download`,
            content: textish ? bytes.toString("utf-8").slice(0, 20_000) : undefined,
            note: textish ? undefined : "Binary artifact. Use artifact_get_download or the Files pane.",
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
    description: "Delete an ORVYN artifact by id.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    defaultPermission: "ask",
    async execute(args): Promise<ToolResult> {
      try {
        await artifacts.delete(String(args.id ?? ""));
        return { ok: true, output: json({ deleted: String(args.id ?? "") }) };
      } catch (e: any) {
        return { ok: false, error: e.message };
      }
    },
  };
}

export function makeArtifactDownloadTool(artifacts: ArtifactService): AITool {
  return {
    name: "artifact_get_download",
    description: "Return a download URL and metadata for an ORVYN artifact so the user can save it.",
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
            id: record.id,
            name: filename,
            path: record.path,
            mediaType: record.mediaType,
            downloadPath: `/artifacts/${record.id}/download`,
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
  register(makeArtifactReadTool(artifacts));
  register(makeArtifactDeleteTool(artifacts));
  register(makeArtifactDownloadTool(artifacts));
}
