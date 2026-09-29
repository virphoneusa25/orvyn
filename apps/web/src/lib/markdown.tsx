
// A small, safe Markdown renderer for chat replies: builds React elements
// (never raw HTML), so nothing a model writes can run as code in the portal.

function inline(text: string, key: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\((https?:\/\/[^\s)]+)\))/g;
  let last = 0; let m: RegExpExecArray | null; let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<code key={k}>{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{m[2].slice(2, -2)}</strong>);
    else if (m[3]) out.push(<em key={k}>{m[3].slice(1, -1)}</em>);
    else if (m[4]) { const label = m[4].slice(1, m[4].indexOf("]")); out.push(<a key={k} href={m[5]} target="_blank" rel="noopener noreferrer">{label}</a>); }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0; let n = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const key = `b${n++}`;
    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) body.push(lines[i++]!);
      i++;
      blocks.push(<pre key={key}><code>{body.join("\n")}</code></pre>);
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { const Tag = (`h${h[1]!.length}`) as "h1" | "h2" | "h3"; blocks.push(<Tag key={key}>{inline(h[2]!, key)}</Tag>); i++; continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*[-*]\s+/, ""));
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
    while (i < lines.length && lines[i]!.trim() && !/^(```|#{1,3}\s|\s*[-*]\s+|\s*\d+[.)]\s+)/.test(lines[i]!)) para.push(lines[i++]!);
    blocks.push(<p key={key}>{para.flatMap((p, j) => (j ? [<br key={`${key}br${j}`} />, ...inline(p, `${key}-${j}`)] : inline(p, `${key}-${j}`)))}</p>);
  }
  return <>{blocks}</>;
}
