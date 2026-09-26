// "Sources" under ORION's answer: the sites it searched and read, like a chat
// assistant shows them. Stacked site icons + a count; click to list them, and
// click a source to open it in the Workbench Browser.

import React, { useState } from "react";
import { collectSources, sourceDomains, type RunSource } from "../runSources";
import { openArtifactInContext } from "../contextOpen";

function SiteIcon({ domain, size = 16 }: { domain: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const letter = domain.replace(/^www\./, "").charAt(0).toUpperCase() || "?";
  if (failed) {
    return <span className="sources__letter" style={{ width: size, height: size, fontSize: size * 0.6 }} aria-hidden="true">{letter}</span>;
  }
  return (
    <img className="sources__icon" src={`https://${domain}/favicon.ico`} width={size} height={size} alt="" aria-hidden="true"
      referrerPolicy="no-referrer" loading="lazy" onError={() => setFailed(true)} />
  );
}

function SourceRow({ source }: { source: RunSource }) {
  return (
    <button className="sources__row" data-testid="source-row" data-url={source.url} title={source.url}
      onClick={() => openArtifactInContext({ tab: "browser", url: source.url })}>
      <SiteIcon domain={source.domain} />
      <span className="sources__text">
        <span className="sources__title">{source.title}</span>
        <span className="sources__domain">{source.domain}</span>
        {source.snippet && <span className="sources__snippet">{source.snippet}</span>}
      </span>
    </button>
  );
}

export function SourcesBar({ events, sources: given }: { events?: { type: string; data?: Record<string, any> }[]; sources?: RunSource[] }) {
  const [open, setOpen] = useState(false);
  const sources = given ?? collectSources(events ?? []);
  if (!sources.length) return null;
  const read = sources.filter((s) => s.kind === "read");
  const found = sources.filter((s) => s.kind === "search");
  const queries = [...new Set(found.map((s) => s.query).filter(Boolean))] as string[];
  return (
    <>
      <button className="sources__chip" data-testid="sources-chip" aria-expanded={open} onClick={() => setOpen(!open)}
        title={`${sources.length} ${sources.length === 1 ? "source" : "sources"}`}>
        <span className="sources__stack">
          {sourceDomains(sources).map((d) => <SiteIcon key={d} domain={d} />)}
        </span>
        Sources
        <span className="sources__count">{sources.length}</span>
      </button>
      {open && (
        <div className="sources__panel" data-testid="sources-panel">
          {read.length > 0 && <>
            <div className="sources__heading">Read</div>
            {read.map((s) => <SourceRow key={s.url} source={s} />)}
          </>}
          {found.length > 0 && <>
            <div className="sources__heading">Found in search{queries.length ? ` · ${queries.map((q) => `“${q}”`).join(", ")}` : ""}</div>
            {found.map((s) => <SourceRow key={s.url} source={s} />)}
          </>}
        </div>
      )}
    </>
  );
}
