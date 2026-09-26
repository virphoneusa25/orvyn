// Actions under one of ORION's answers: copy, read aloud, regenerate, share.

import React, { useEffect, useState } from "react";
import { onSpeechChange, shareMarkdown, speechAvailable, toggleSpeak } from "../answerTools";
import type { RunSource } from "../runSources";

const btn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 5, background: "transparent", border: "1px solid transparent",
  borderRadius: 6, padding: "3px 7px", fontSize: 11.5, color: "var(--text-muted, var(--orvyn-text-muted))", cursor: "pointer",
};

const Svg = ({ d }: { d: string }) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const ICON = {
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  speak: "M11 5L6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 010 7M19 5a10 10 0 010 14",
  stop: "M6 6h12v12H6z",
  regen: "M21 12a9 9 0 11-3-6.7L21 8M21 3v5h-5",
  share: "M4 12v8h16v-8M12 3v13M7 8l5-5 5 5",
};

export function AnswerActions({
  speakKey, text, question, sources, onRegenerate, showCopy = true, when,
}: {
  speakKey: string;
  text: string;
  question?: string;
  sources?: RunSource[];
  onRegenerate?: () => void;
  showCopy?: boolean;
  when?: number;
}) {
  const [speaking, setSpeaking] = useState<string | null>(null);
  const [done, setDone] = useState<"copy" | "share" | null>(null);
  useEffect(() => onSpeechChange(setSpeaking), []);
  if (!text.trim()) return null;
  const flash = (k: "copy" | "share") => { setDone(k); setTimeout(() => setDone(null), 1500); };
  const copy = async (value: string, k: "copy" | "share") => {
    try { await navigator.clipboard.writeText(value); flash(k); } catch { /* clipboard denied */ }
  };
  const isSpeaking = speaking === speakKey;
  return (
    <span className="answer-actions" data-testid="answer-actions" style={{ display: "inline-flex", alignItems: "center", gap: 2, flexWrap: "wrap" }}>
      {showCopy && (
        <button style={btn} title="Copy the answer" data-testid="answer-copy" onClick={() => void copy(text.trim(), "copy")}>
          <Svg d={ICON.copy} /> {done === "copy" ? "Copied" : "Copy"}
        </button>
      )}
      {speechAvailable() && (
        <button style={btn} title={isSpeaking ? "Stop reading" : "Read aloud"} data-testid="answer-speak" aria-pressed={isSpeaking} onClick={() => toggleSpeak(speakKey, text)}>
          <Svg d={isSpeaking ? ICON.stop : ICON.speak} /> {isSpeaking ? "Stop" : "Read aloud"}
        </button>
      )}
      {onRegenerate && (
        <button style={btn} title="Answer the same question again" data-testid="answer-regenerate" onClick={onRegenerate}>
          <Svg d={ICON.regen} /> Regenerate
        </button>
      )}
      <button style={btn} title="Copy the question and answer (with sources) as Markdown" data-testid="answer-share"
        onClick={() => void copy(shareMarkdown({ question, answer: text, sources, when }), "share")}>
        <Svg d={ICON.share} /> {done === "share" ? "Copied to share" : "Share"}
      </button>
    </span>
  );
}
