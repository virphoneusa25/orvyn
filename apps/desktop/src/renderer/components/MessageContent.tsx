// apps/desktop/src/renderer/components/MessageContent.tsx
//
// Renders assistant/user messages as real content instead of a raw string:
// fenced code blocks become bordered panels with a language label, a copy
// button and an optional "Apply" action; inline `code`, **bold**, headings and
// bullets are styled. Deliberately dependency-free (no react-markdown) so it
// adds nothing to the bundle and can't break the packaged build.
import React, { useState } from "react";
import { IconCopy, IconCheck } from "./Icons";

interface Block {
  type: "code" | "text";
  content: string;
  lang?: string;
}

function parseBlocks(raw: string): Block[] {
  const blocks: Block[] = [];
  const fence = /```(\w+)?\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fence.exec(raw)) !== null) {
    if (match.index > lastIndex) {
      blocks.push({ type: "text", content: raw.slice(lastIndex, match.index) });
    }
    blocks.push({ type: "code", lang: match[1] || "text", content: match[2].replace(/\n$/, "") });
    lastIndex = match.index + match[0].length;
  }
  // An unterminated fence means the model is still streaming a code block —
  // render what we have so far as code rather than dumping backticks as prose.
  const rest = raw.slice(lastIndex);
  const openFence = rest.match(/```(\w+)?\n?([\s\S]*)$/);
  if (openFence) {
    const before = rest.slice(0, openFence.index);
    if (before.trim()) blocks.push({ type: "text", content: before });
    blocks.push({ type: "code", lang: openFence[1] || "text", content: openFence[2] });
  } else if (rest) {
    blocks.push({ type: "text", content: rest });
  }
  return blocks;
}

function CodeBlock({ code, lang, onApply }: { code: string; lang: string; onApply?: (c: string) => void }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        overflow: "hidden",
        margin: "10px 0",
        background: "var(--bg-app)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "5px 10px",
          background: "var(--bg-elevated)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{lang}</span>
        <div style={{ display: "flex", gap: 4 }}>
          {onApply && (
            <button onClick={() => onApply(code)} style={ghostBtn()}>
              Apply
            </button>
          )}
          <button onClick={copy} style={{ ...ghostBtn(), display: "flex", alignItems: "center", gap: 4 }}>
            {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      <pre
        className="selectable"
        style={{
          margin: 0,
          padding: "10px 12px",
          overflowX: "auto",
          fontFamily: "var(--font-mono)",
          fontSize: 12.5,
          lineHeight: 1.6,
          color: "var(--text)",
        }}
      >
        {code}
      </pre>
    </div>
  );
}

// Lightweight inline formatting: `code`, **bold**, headings, bullets.
function renderText(text: string, key: number) {
  const lines = text.split("\n");
  return (
    <div key={key} className="selectable" style={{ lineHeight: 1.65 }}>
      {lines.map((line, i) => {
        if (!line.trim()) return <div key={i} style={{ height: 8 }} />;

        const heading = line.match(/^(#{1,4})\s+(.*)$/);
        const bullet = line.match(/^[-*]\s+(.*)$/);
        const body = heading ? heading[2] : bullet ? bullet[1] : line;

        const parts: React.ReactNode[] = [];
        const inline = /(`[^`]+`|\*\*[^*]+\*\*)/g;
        let last = 0;
        let m: RegExpExecArray | null;
        while ((m = inline.exec(body)) !== null) {
          if (m.index > last) parts.push(body.slice(last, m.index));
          const tok = m[0];
          if (tok.startsWith("`")) {
            parts.push(
              <code
                key={`${i}-${m.index}`}
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  background: "var(--bg-elevated)",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  padding: "1px 5px",
                }}
              >
                {tok.slice(1, -1)}
              </code>
            );
          } else {
            parts.push(<strong key={`${i}-${m.index}`} style={{ fontWeight: 600 }}>{tok.slice(2, -2)}</strong>);
          }
          last = m.index + tok.length;
        }
        if (last < body.length) parts.push(body.slice(last));

        if (heading) {
          return (
            <div key={i} style={{ fontWeight: 600, fontSize: 14, margin: "10px 0 4px" }}>
              {parts}
            </div>
          );
        }
        if (bullet) {
          return (
            <div key={i} style={{ display: "flex", gap: 8, margin: "2px 0" }}>
              <span style={{ color: "var(--text-muted)" }}>•</span>
              <span>{parts}</span>
            </div>
          );
        }
        return <div key={i}>{parts}</div>;
      })}
    </div>
  );
}

export function MessageContent({
  content,
  onApply,
  streaming,
}: {
  content: string;
  onApply?: (code: string) => void;
  streaming?: boolean;
}) {
  const blocks = parseBlocks(content);
  return (
    <>
      {blocks.map((b, i) =>
        b.type === "code" ? (
          <CodeBlock key={i} code={b.content} lang={b.lang ?? "text"} onApply={onApply} />
        ) : (
          renderText(b.content, i)
        )
      )}
      {streaming && <span className="orvyn-caret" aria-hidden>▍</span>}
    </>
  );
}

function ghostBtn(): React.CSSProperties {
  return {
    background: "transparent",
    border: "1px solid var(--border-strong)",
    borderRadius: 4,
    color: "var(--text-secondary)",
    padding: "2px 7px",
    fontSize: 11,
  };
}
