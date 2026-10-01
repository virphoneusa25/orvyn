import { useApi } from "../lib/useApi";
import { Icon } from "../components/Icons";
import { Orb } from "../components/Orb";

interface Links {
  windows: string | null;
  mac: string | null;
  linux: string | null;
  version: string | null;
  notes?: string | null;
  installations?: { platform: string; version: string; channel: string; current: boolean }[];
}

function guess(): "windows" | "mac" | "linux" {
  const ua = navigator.userAgent;
  return /Mac/i.test(ua) ? "mac" : /Linux/i.test(ua) && !/Android/i.test(ua) ? "linux" : "windows";
}

function platformLabel(p: string): string {
  return p === "darwin" ? "macOS" : p === "linux" ? "Linux" : "Windows";
}

export function Download() {
  const { data } = useApi<Links>("/downloads/desktop");
  const os = guess();
  const items: { id: "windows" | "mac" | "linux"; label: string }[] = [{ id: "windows", label: "Windows" }, { id: "mac", label: "macOS" }, { id: "linux", label: "Linux" }];
  return (
    <div className="page">
      <section className="home-hero" style={{ paddingBottom: 24 }}>
        <div className="home-hero__orb"><Orb /></div>
        <p className="home-hero__hello">ORVYN Desktop{data?.version ? ` · Latest Stable ${data.version}` : ""}</p>
        <h1>Build on <span className="g">your own computer</span></h1>
        <p className="muted" style={{ maxWidth: 560, margin: "10px auto 0" }}>Missions that write code, run apps and work in your folders — with the same account, projects and credits as ORVYN Cloud.</p>
      </section>
      <div className="three" style={{ marginTop: 16 }}>
        {items.map((it) => {
          const url = data?.[it.id] ?? null;
          return (
            <section key={it.id} className={`card card--pad${it.id === os ? " plan is-current" : ""}`} data-testid={`download-${it.id}`}>
              <div className="card__head"><Icon.monitor size={24} /><h3>{it.label}</h3>{it.id === os ? <span className="tag tag--violet">Your system</span> : null}</div>
              {url ? <a className="btn btn--primary" href={url} rel="noopener"><Icon.download size={18} /> Download for {it.label}</a>
                : <button className="btn" disabled>Coming soon</button>}
            </section>
          );
        })}
      </div>
      {data?.notes ? (
        <section className="card card--pad" style={{ marginTop: 16 }}>
          <div className="card__head"><h3>Release notes</h3></div>
          <p className="muted" style={{ whiteSpace: "pre-wrap" }}>{data.notes}</p>
        </section>
      ) : null}
      {data?.installations?.length ? (
        <section className="card card--pad" style={{ marginTop: 16 }}>
          <div className="card__head"><h3>Your signed-in Desktop installations</h3></div>
          <p className="muted">Inventory from privacy-safe update telemetry. This is not remote management.</p>
          <ul style={{ margin: "8px 0 0", paddingLeft: 18, color: "var(--text-2)" }}>
            {data.installations.map((i, idx) => (
              <li key={`${i.platform}-${i.version}-${idx}`}>
                {platformLabel(i.platform)} · ORVYN {i.version} · {i.current ? "Current" : "Update available"}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="card card--pad" style={{ marginTop: 16 }}>
        <div className="card__head"><h3>Getting started</h3></div>
        <ol style={{ margin: 0, paddingLeft: 20, color: "var(--text-2)", display: "grid", gap: 6 }}>
          <li>Download and install ORVYN Desktop.</li>
          <li>Sign in with this same account — your projects, credits and plan are already there.</li>
          <li>Open a project and start a mission.</li>
        </ol>
      </section>
    </div>
  );
}
