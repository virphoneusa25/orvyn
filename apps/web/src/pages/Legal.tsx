import { useMemo, useState } from "react";
import { api } from "../lib/api";
import { useApi } from "../lib/useApi";
import { useStore } from "../lib/store";
import { Markdown } from "../lib/markdown";
import { PageHead } from "../components/Bits";

interface LegalDocument {
  id: string;
  title: string;
  requiredForAcceptance: boolean;
  content: string;
}

interface LegalBundle {
  version: string;
  requiredDocuments: string[];
  documents: LegalDocument[];
  accepted: boolean;
  acceptance: { version: string; source: string; acceptedAt: number } | null;
}

function LegalDocuments({
  bundle,
  compact = false,
}: {
  bundle: LegalBundle;
  compact?: boolean;
}) {
  const [open, setOpen] = useState<string>(bundle.documents.find((d) => d.requiredForAcceptance)?.id ?? bundle.documents[0]?.id ?? "");
  const current = useMemo(() => bundle.documents.find((d) => d.id === open) ?? bundle.documents[0], [bundle.documents, open]);
  return (
    <div className={compact ? "" : "legal-layout"} data-testid="legal-documents">
      <div className="legal-list" style={{ display: "grid", gap: 8, marginBottom: 12 }}>
        {bundle.documents.map((doc) => (
          <button
            key={doc.id}
            className={`btn ${open === doc.id ? "btn--primary" : ""}`}
            style={{ justifyContent: "space-between", textAlign: "left" }}
            onClick={() => setOpen(doc.id)}
          >
            <span>{doc.title}</span>
            {doc.requiredForAcceptance ? <span className="tag tag--violet">Required</span> : null}
          </button>
        ))}
      </div>
      {current ? (
        <article className="card card--pad markdown" style={{ maxHeight: compact ? 420 : 560, overflowY: "auto" }}>
          <Markdown text={current.content} />
        </article>
      ) : null}
    </div>
  );
}

export function LegalSettingsPanel() {
  const q = useApi<LegalBundle>("/auth/legal");
  const { refresh, toast } = useStore();
  const [busy, setBusy] = useState(false);
  const accept = async () => {
    if (!q.data) return;
    setBusy(true);
    try {
      await api("/auth/legal/accept", { method: "POST", body: { version: q.data.version, source: "web-settings" } });
      toast("Legal acceptance updated.");
      q.reload();
      await refresh();
    } catch (err: any) {
      toast(err.message);
    } finally {
      setBusy(false);
    }
  };
  if (q.loading) return <div className="card card--pad"><div className="skeleton" style={{ height: 120 }} /></div>;
  if (!q.data) return <div className="card card--pad"><b>Legal documents unavailable.</b><p className="muted">Retry in a moment.</p></div>;
  return (
    <>
      <section className="card card--pad settings__section">
        <div className="spread" style={{ alignItems: "flex-start" }}>
          <div>
            <h2 style={{ fontSize: 16, margin: 0 }}>Legal & Privacy</h2>
            <p className="muted" style={{ margin: "4px 0 0" }}>Current ORVYN legal bundle: {q.data.version}</p>
          </div>
          {q.data.accepted ? <span className="tag tag--green">Accepted</span> : <span className="tag tag--amber">Action required</span>}
        </div>
        <p className="muted">
          {q.data.acceptance
            ? `Accepted on ${new Date(q.data.acceptance.acceptedAt).toLocaleString()} via ${q.data.acceptance.source}.`
            : "This account has not accepted the current legal bundle."}
        </p>
        {!q.data.accepted ? <button className="btn btn--primary" disabled={busy} onClick={() => void accept()}>{busy ? "Recording…" : "Accept current legal terms"}</button> : null}
      </section>
      <LegalDocuments bundle={q.data} compact />
    </>
  );
}

export function LegalAcceptanceGate() {
  const q = useApi<LegalBundle>("/auth/legal");
  const { refresh, signOut } = useStore();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!q.data) return <div className="auth"><div className="card auth__card"><div className="muted">Loading legal terms…</div></div></div>;
  const accept = async () => {
    if (!confirmed) return;
    setBusy(true); setError(null);
    try {
      await api("/auth/legal/accept", { method: "POST", body: { version: q.data!.version, source: "web-gate" } });
      await refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth" data-testid="legal-acceptance-gate">
      <div className="card" style={{ width: "min(920px, calc(100vw - 32px))", maxHeight: "calc(100vh - 32px)", overflow: "auto", padding: 24 }}>
        <PageHead title="Review ORVYN legal terms" sub={`Version ${q.data.version} must be accepted before continuing.`} />
        <LegalDocuments bundle={q.data} />
        <label className="terms" style={{ marginTop: 14 }}>
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          <span>I agree to the ORVYN Software License Agreement and Acceptable Use Policy, and acknowledge the Privacy Policy and AI & Agent Disclosure.</span>
        </label>
        {error ? <div className="error" role="alert">{error}</div> : null}
        <div className="row" style={{ justifyContent: "space-between", marginTop: 14 }}>
          <button className="linkbtn" onClick={() => void signOut()}>Sign out</button>
          <button className="btn btn--primary btn--big" disabled={!confirmed || busy} onClick={() => void accept()}>{busy ? "Recording acceptance…" : "Accept and continue"}</button>
        </div>
      </div>
    </div>
  );
}
