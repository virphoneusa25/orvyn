// Answer tools: read an answer aloud, and turn it into shareable Markdown.

import type { RunSource } from "./runSources";

/** Speech-friendly text: code blocks and links become short spoken hints. */
export function speakableText(markdown: string): string {
  return String(markdown ?? "")
    .replace(/```[\s\S]*?```/g, " (code block) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " (image) ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/[*_~>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The question and answer (and its sources) as Markdown, ready to paste anywhere. */
export function shareMarkdown(input: { question?: string; answer: string; sources?: RunSource[]; when?: number }): string {
  const parts: string[] = [];
  if (input.question?.trim()) parts.push(`**Question:** ${input.question.trim()}`, "");
  parts.push(`**ORION:**`, "", input.answer.trim());
  if (input.sources?.length) {
    parts.push("", "**Sources**", ...input.sources.map((s) => `- [${s.title || s.domain}](${s.url})`));
  }
  parts.push("", `— Shared from ORVYN${input.when ? ` · ${new Date(input.when).toLocaleString()}` : ""}`);
  return parts.join("\n");
}

// ── Read aloud (one voice at a time across the app) ──────────────────────────

type Listener = (speakingKey: string | null) => void;
let current: string | null = null;
const listeners = new Set<Listener>();
const notify = () => listeners.forEach((l) => l(current));

export function onSpeechChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function speechAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

export function stopSpeaking(): void {
  if (speechAvailable()) window.speechSynthesis.cancel();
  current = null;
  notify();
}

/** Reads `text` aloud; calling again for the same key stops it. */
export function toggleSpeak(key: string, markdown: string): void {
  if (!speechAvailable()) return;
  if (current === key) { stopSpeaking(); return; }
  window.speechSynthesis.cancel();
  const text = speakableText(markdown);
  if (!text) return;
  current = key;
  notify();
  // Long answers are spoken in sentence-sized pieces (some voices stop after ~15 s of one utterance).
  const pieces = text.match(/[^.!?]+[.!?]*\s*/g) ?? [text];
  pieces.forEach((piece, i) => {
    const u = new SpeechSynthesisUtterance(piece.trim());
    if (i === pieces.length - 1) u.onend = () => { if (current === key) { current = null; notify(); } };
    u.onerror = () => { if (current === key) { current = null; notify(); } };
    window.speechSynthesis.speak(u);
  });
}
