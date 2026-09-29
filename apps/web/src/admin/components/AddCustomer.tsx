import { useState } from "react";
import { api } from "../../lib/api";
import { navigate } from "../../lib/router";
import { useStore } from "../../lib/store";
import { Modal } from "../../components/Bits";
import { invalidate } from "../query";

/** Invite a customer: ORVYN creates the account and emails them a link to set their own password (no password is ever chosen or seen by staff). */
export function AddCustomerModal({ onClose }: { onClose: () => void }) {
  const { toast } = useStore();
  const [f, setF] = useState({ email: "", name: "", organization: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ customer: { id: string }; emailed: boolean }>("/admin/customers", { method: "POST", body: f });
      invalidate("/admin/customers"); invalidate("/admin/dashboard");
      toast(r.emailed ? "Customer created — they've been emailed a link to set their password." : "Customer created. Email isn't configured, so send them to Forgot password to set one.");
      onClose();
      navigate(`/admin/customers/${r.customer.id}`);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal title="Add customer" onClose={onClose}>
      <p className="muted" style={{ marginTop: 0 }}>Creates an ORVYN account on the Free plan and emails the customer a link to set their password.</p>
      <div className="a-field"><label htmlFor="ac-email">Email</label><input id="ac-email" className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} data-testid="ac-email" /></div>
      <div className="a-field"><label htmlFor="ac-name">Contact name</label><input id="ac-name" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
      <div className="a-field"><label htmlFor="ac-org">Organization name (optional)</label><input id="ac-org" className="input" value={f.organization} onChange={(e) => setF({ ...f, organization: e.target.value })} /></div>
      {error ? <div className="error" role="alert">{error}</div> : null}
      <div className="modal__actions"><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn--primary" disabled={busy || !/^\S+@\S+\.\S+$/.test(f.email)} onClick={() => void submit()} data-testid="ac-submit">{busy ? "Creating…" : "Create customer"}</button></div>
    </Modal>
  );
}
