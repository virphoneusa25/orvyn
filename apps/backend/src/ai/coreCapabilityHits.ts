// Core ORVYN tools that already cover ChatGPT-style cloud chat work.
// Capability search must name these instead of offering an MCP install card.

import { builtinImageGenerateHit, looksLikeImageRequest } from "./imageIntent";

export function looksLikeDocumentRequest(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;
  return (
    /\b(create|generate|make|write|export|produce|draft)\b/i.test(t) &&
    /\b(pdf|docx|xlsx|pptx|csv|spreadsheet|powerpoint|excel|word\s+doc(?:ument)?)\b/i.test(t)
  );
}

export function looksLikeZipRequest(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;
  return /\b(create|generate|make|export|zip)\b/i.test(t) && /\b(zip|archive)\b/i.test(t);
}

/** Picture, PDF, spreadsheet, or zip — Cloud can do these without a user project folder. */
export function looksLikeCloudArtifactRequest(text: string): boolean {
  return looksLikeImageRequest(text) || looksLikeDocumentRequest(text) || looksLikeZipRequest(text);
}

export function builtinDocumentHit(query: string): boolean {
  return /\b(pdf|docx|xlsx|pptx|spreadsheet|powerpoint|create_document|word document)\b/i.test(query);
}

export function builtinZipHit(query: string): boolean {
  return /\b(create_zip|\bzip\b|zip archive)\b/i.test(query);
}

export function builtinCodeInterpreterHit(query: string): boolean {
  return /\b(code interpreter|run (this |the )?code|execute (a |the )?script|write_file|edit_file|apply_patch|list_directory|search_grep|run_terminal|python interpreter)\b/i.test(query)
    || /\b(python|node|javascript)\b.{0,40}\b(script|program|code)\b/i.test(query);
}

export function builtinWebHit(query: string): boolean {
  return /\b(web_search|fetch_url|search the web|web search|browse the web)\b/i.test(query);
}

export function builtinCoreHitLines(query: string): string[] {
  const lines: string[] = [];
  if (builtinImageGenerateHit(query)) {
    lines.push("- [orvyn] generate_image · ORVYN — Core text-to-image tool. Call generate_image; do not install an MCP image server.");
  }
  if (builtinDocumentHit(query)) {
    lines.push("- [orvyn] create_document · ORVYN — Core PDF/DOCX/XLSX/PPTX/CSV tool. Call create_document; do not install an MCP document server.");
  }
  if (builtinZipHit(query)) {
    lines.push("- [orvyn] create_zip · ORVYN — Core ZIP archive tool. Call create_zip.");
  }
  if (builtinCodeInterpreterHit(query)) {
    lines.push("- [orvyn] terminal · ORVYN — Write files with write_file / edit_file and run them with terminal. This is the code interpreter; do not install a filesystem or Python MCP server.");
  }
  if (builtinWebHit(query)) {
    lines.push("- [orvyn] web_search · ORVYN — Core web_search and fetch_url. Do not install an MCP search server.");
  }
  return lines;
}

/** When a core tool already does the job, marketplace install cards stay off. */
export function coreCapabilityCovers(query: string): boolean {
  return builtinCoreHitLines(query).length > 0;
}
