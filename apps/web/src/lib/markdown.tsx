import { useState } from "react";

// A small, safe Markdown renderer for chat replies: builds React elements
// (never raw HTML), so nothing a model writes can run as code in the portal.

function inline(text: string, key: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
  let last = 0; let m: RegExpExecArray | null; let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<code key={k}>{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{m[2].slice(2, -2)}</strong>);
    else if (m[3]) out.push(<strong key={k}>{m[3].slice(2, -2)}</strong>);
    else if (m[4]) out.push(<em key={k}>{m[4].slice(1, -1)}</em>);
    else if (m[5]) { const label = m[5].slice(1, m[5].indexOf("]")); out.push(<a key={k} href={m[6]} target="_blank" rel="noopener noreferrer">{label}</a>); }
    else if (m[7]) out.push(<a key={k} href={m[7]} target="_blank" rel="noopener noreferrer">{m[7]}</a>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <div className="codeblock__bar">
        <span>{lang || "code"}</span>
        <button className="btn btn--sm btn--ghost" onClick={() => { void navigator.clipboard?.writeText(code).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }); }} aria-label="Copy code">{copied ? "Copied" : "Copy"}</button>
      </div>
      <pre><code>{code}</code></pre>
    </>
  );
}

const BLOCK = /^(```|#{1,4}\s|\s*[-*+]\s+|\s*\d+[.)]\s+|>\s?|\|.*\||(-{3,}|\*{3,})\s*$)/;

export function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0; let n = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const key = `b${n++}`;
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) body.push(lines[i++]!);
      i++;
      blocks.push(<CodeBlock key={key} lang={lang} code={body.join("\n")} />);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { const Tag = (`h${Math.min(3, h[1]!.length)}`) as "h1" | "h2" | "h3"; blocks.push(<Tag key={key}>{inline(h[2]!, key)}</Tag>); i++; continue; }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { blocks.push(<hr key={key} />); i++; continue; }
    if (/^>\s?/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) q.push(lines[i++]!.replace(/^>\s?/, ""));
      blocks.push(<blockquote key={key}>{inline(q.join(" "), key)}</blockquote>);
      continue;
    }
    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1]!)) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i]!)) rows.push(cells(lines[i++]!));
      blocks.push(<table key={key}><thead><tr>{head.map((c, j) => <th key={j}>{inline(c, `${key}h${j}`)}</th>)}</tr></thead><tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, j) => <td key={j}>{inline(c, `${key}r${ri}${j}`)}</td>)}</tr>)}</tbody></table>);
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*[-*+]\s+/, ""));
      blocks.push(<ul key={key}>{items.map((t, j) => <li key={j}>{inline(t, `${key}-${j}`)}</li>)}</ul>);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*\d+[.)]\s+/, ""));
      blocks.push(<ol key={key}>{items.map((t, j) => <li key={j}>{inline(t, `${key}-${j}`)}</li>)}</ol>);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !BLOCK.test(lines[i]!)) para.push(lines[i++]!);
    if (!para.length) { para.push(lines[i++]!); }
    blocks.push(<p key={key}>{para.flatMap((p, j) => (j ? [<br key={`${key}br${j}`} />, ...inline(p, `${key}-${j}`)] : inline(p, `${key}-${j}`)))}</p>);
  }
  return <>{blocks}{streaming ? <span className="orvyn-caret" aria-hidden>▍</span> : null}</>;
}
