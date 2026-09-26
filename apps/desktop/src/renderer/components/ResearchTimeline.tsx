// "Searched the web, read 5 pages": the research behind an answer, live.
// Each search (query · N results) and each page read (site icon · URL ·
// domain ↗) is a step on one line; while ORION works, "Still thinking… · 37s".

import React, { useEffect, useState } from "react";
import { researchSummary, type ResearchStep } from "../researchSteps";
import { openArtifactInContext } from "../contextOpen";

function Favicon({ domain }: { domain?: string }) {
  const [failed, setFailed] = useState(false);
  if (!domain || failed) {
    return <span className="rt__glyph rt__glyph--letter" aria-hidden="true">{(domain ?? "?").charAt(0).toUpperCase()}</span>;
  }
  return <img className="rt__glyph" src={`https://${domain}/favicon.ico`} width={16} height={16} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

const Globe = () => (
  <svg className="rt__glyph" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18" />
  </svg>
);

const OpenIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" /></svg>
);

function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  return <>{Math.max(0, Math.round((Date.now() - since) / 1000))}s</>;
}

export function ResearchTimeline({ steps, live, thinking, startedAt }: {
  steps: ResearchStep[];
  /** Research or the answer is still in progress. */
  live: boolean;
  /** Show "Still thinking…" (no answer text yet). */
  thinking?: boolean;
  startedAt?: number;
}) {
  const [open, setOpen] = useState<boolean | null>(null);
  if (!steps.length) return null;
  const expanded = open ?? live;
  return (
    <div className="rt" data-testid="research-timeline">
      <button className="rt__head" aria-expanded={expanded} onClick={() => setOpen(!expanded)} data-testid="research-summary">
        {researchSummary(steps, live)}
        <span className="rt__chev" aria-hidden="true">{expanded ? "▾" : "›"}</span>
      </button>
      {expanded && (
        <ol className="rt__steps">
          {steps.map((s) => (
            <li key={s.id} className={`rt__step rt__step--${s.status}`} data-testid="research-step" data-kind={s.kind}>
              <span className="rt__icon">{s.kind === "search" ? <Globe /> : <Favicon domain={s.domain} />}</span>
              <span className="rt__label" title={s.label}>{s.label}</span>
              <span className="rt__meta">
                {s.status === "running" ? <i className="rt__spin" aria-label="working" />
                  : s.status === "failed" ? "failed"
                  : s.kind === "search" ? `${s.results ?? 0} ${s.results === 1 ? "result" : "results"}`
                  : <>{s.domain}<button className="rt__open" title="Open in the Workbench Browser" onClick={() => s.url && openArtifactInContext({ tab: "browser", url: s.url })}><OpenIcon /></button></>}
              </span>
            </li>
          ))}
        </ol>
      )}
      {live && thinking && (
        <div className="rt__thinking" data-testid="research-thinking"><span className="rt__dots" aria-hidden="true"><i /><i /><i /></span>Still thinking… {startedAt ? <>· <Elapsed since={startedAt} /></> : null}</div>
      )}
    </div>
  );
}
