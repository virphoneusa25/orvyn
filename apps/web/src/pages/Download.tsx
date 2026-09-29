import { useApi } from "../lib/useApi";
import { Icon } from "../components/Icons";
import { Orb } from "../components/Orb";

interface Links { windows: string | null; mac: string | null; linux: string | null; version: string | null }

function guess(): "windows" | "mac" | "linux" {
  const ua = navigator.userAgent;
  return /Mac/i.test(ua) ? "mac" : /Linux/i.test(ua) && !/Android/i.test(ua) ? "linux" : "windows";
}

export function Download() {
  const { data } = useApi<Links>("/downloads/desktop");
  const os = guess();
  const items: { id: "windows" | "mac" | "linux"; label: string }[] = [{ id: "windows", label: "Windows" }, { id: "mac", label: "macOS" }, { id: "linux", label: "Linux" }];
  return (
    <>
      <section className="hero" style={{ minHeight: 220 }}>
        <div className="hero__stars" />
        <div className="hero__orb" style={{ width: 240, height: 240 }}><Orb /></div>
        <p className="hero__hello">ORVYN Desktop{data?.version ? ` · ${data.version}` : ""}</p>
        <h1><span className="g1">Build on your</span><br /><span className="g2">own computer</span></h1>
        <p>Missions that write code, run apps and work in your folders — with the same account, projects and credits as ORVYN Cloud.</p>
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
      <section className="card card--pad" style={{ marginTop: 16 }}>
        <div className="card__head"><h3>Getting started</h3></div>
        <ol style={{ margin: 0, paddingLeft: 20, color: "var(--text-2)", display: "grid", gap: 6 }}>
          <li>Download and install ORVYN Desktop.</li>
          <li>Sign in with this same account — your projects, credits and plan are already there.</li>
          <li>Open a project and start a mission.</li>
        </ol>
      </section>
    </>
  );
}
