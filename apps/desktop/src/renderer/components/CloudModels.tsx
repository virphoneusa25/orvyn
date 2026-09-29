import React, { useCallback, useEffect, useState } from "react";
import { apiUrl, authHeaders } from "../connection";

// ORVYN Cloud: ORVYN's models by name (fixed, not editable), then the
// customer's own models (their API, their key), which they can add, test,
// edit, remove and set as the default in place of ORVYN's routing.

interface OrvynModel { id: string; name: string; description: string; available: boolean; kind: "orvyn" }
interface UserModel {
  id: string; name: string; kind: "user"; endpoint: string; apiModelId?: string; hasApiKey: boolean;
  contextWindow: number; capabilities: { tools?: boolean; vision?: boolean };
}
interface Form { id?: string; name: string; endpoint: string; apiModelId: string; apiKey: string; tools: boolean; vision: boolean; contextWindow: string }

const EMPTY: Form = { name: "", endpoint: "", apiModelId: "", apiKey: "", tools: true, vision: false, contextWindow: "128000" };

async function call(path: string, method = "GET", body?: unknown): Promise<any> {
  const r = await fetch(apiUrl(path), { method, headers: { "Content-Type": "application/json", ...authHeaders() }, body: body === undefined ? undefined : JSON.stringify(body) });
  const d = r.status === 204 ? {} : await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
  return d;
}

export function CloudModels() {
  const [orvyn, setOrvyn] = useState<OrvynModel[]>([]);
  const [mine, setMine] = useState<UserModel[]>([]);
  const [preferred, setPreferred] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tests, setTests] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const d = await call("/models");
      setOrvyn((d.models ?? []).filter((m: any) => m.kind === "orvyn"));
      setMine((d.models ?? []).filter((m: any) => m.kind === "user"));
      setPreferred(d.preferredModelId ?? null);
    } catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save() {
    if (!form) return;
    setBusy(true); setError(null);
    try {
      const body = { name: form.name, endpoint: form.endpoint, apiModelId: form.apiModelId, ...(form.apiKey ? { apiKey: form.apiKey } : {}), contextWindow: Number(form.contextWindow) || 128000, capabilities: { tools: form.tools, vision: form.vision } };
      if (form.id) await call(`/models/${encodeURIComponent(form.id)}`, "PUT", body);
      else await call("/models", "POST", body);
      setForm(null);
      await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  async function remove(id: string) {
    setBusy(true); setError(null);
    try { await call(`/models/${encodeURIComponent(id)}`, "DELETE"); await load(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  async function test(id: string) {
    setTests((t) => ({ ...t, [id]: "Testing…" }));
    try {
      const d = await call(`/models/${encodeURIComponent(id)}/test`, "POST", {});
      setTests((t) => ({ ...t, [id]: d.ok ? `Working · ${d.latencyMs} ms` : `Failed: ${d.error ?? "no answer"}` }));
    } catch (e: any) { setTests((t) => ({ ...t, [id]: `Failed: ${e.message}` })); }
  }

  async function setDefault(id: string | null) {
    setBusy(true); setError(null);
    try { const d = await call("/models/preferred", "PUT", { modelId: id }); setPreferred(d.preferredModelId ?? null); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "20px 24px", color: "var(--orvyn-text)" }} data-testid="cloud-models">
      <div style={{ fontSize: 20, fontWeight: 700 }}>AI Models</div>
      <div style={{ fontSize: 13, color: "var(--orvyn-text-muted)", margin: "4px 0 18px" }}>
        ORVYN picks the right model for each task. You can also connect your own model and use it instead.
      </div>
      {error && <div role="alert" style={{ color: "#e06c75", fontSize: 12, marginBottom: 12 }}>{error}</div>}

      <div style={section}>ORVYN models</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 10, marginBottom: 26 }}>
        {orvyn.map((m) => (
          <div key={m.id} style={card} data-testid={`orvyn-model-${m.id}`}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: m.available ? "var(--orvyn-green, #3fb950)" : "var(--orvyn-text-muted)" }} />
              <span style={{ fontWeight: 650 }}>{m.name}</span>
              {preferred === null && m.id === "auto" ? <span style={badge}>Default</span> : null}
            </div>
            <div style={{ fontSize: 12, color: "var(--orvyn-text-muted)", marginTop: 6 }}>{m.available ? m.description : "Not available right now"}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={section}>Your models</div>
        {!form && <button style={primary} onClick={() => setForm({ ...EMPTY })}>+ Connect your model</button>}
      </div>
      <div style={{ fontSize: 12, color: "var(--orvyn-text-muted)", marginBottom: 12 }}>
        Any OpenAI-compatible API (OpenAI, OpenRouter, Together, Groq, your own server with a public https address). Calls to your model use your provider account, not ORVYN credits.
      </div>

      {form && (
        <div style={{ ...card, marginBottom: 14 }} data-testid="user-model-form">
          <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: "8px 12px", alignItems: "center", fontSize: 13 }}>
            <label htmlFor="um-name">Name</label>
            <input id="um-name" style={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="My Llama" />
            <label htmlFor="um-endpoint">API address</label>
            <input id="um-endpoint" style={input} value={form.endpoint} onChange={(e) => setForm({ ...form, endpoint: e.target.value })} placeholder="https://api.openai.com/v1" />
            <label htmlFor="um-model">Model name</label>
            <input id="um-model" style={input} value={form.apiModelId} onChange={(e) => setForm({ ...form, apiModelId: e.target.value })} placeholder="gpt-4o, llama-3.3-70b-instruct…" />
            <label htmlFor="um-key">API key</label>
            <input id="um-key" style={input} type="password" autoComplete="off" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder={form.id ? "Leave empty to keep the saved key" : "Stored encrypted; never shown again"} />
            <label htmlFor="um-ctx">Context window</label>
            <input id="um-ctx" style={input} value={form.contextWindow} onChange={(e) => setForm({ ...form, contextWindow: e.target.value.replace(/[^0-9]/g, "") })} />
            <span />
            <span style={{ display: "flex", gap: 16 }}>
              <label><input type="checkbox" checked={form.tools} onChange={(e) => setForm({ ...form, tools: e.target.checked })} /> Can call tools (needed for tasks)</label>
              <label><input type="checkbox" checked={form.vision} onChange={(e) => setForm({ ...form, vision: e.target.checked })} /> Understands images</label>
            </span>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button style={primary} disabled={busy} onClick={() => void save()}>{form.id ? "Save" : "Connect"}</button>
            <button style={ghost} disabled={busy} onClick={() => { setForm(null); setError(null); }}>Cancel</button>
          </div>
        </div>
      )}

      {mine.length === 0 && !form ? <div style={{ fontSize: 12, color: "var(--orvyn-text-muted)" }}>You haven't connected a model.</div> : null}
      {mine.map((m) => (
        <div key={m.id} style={{ ...card, marginBottom: 10, display: "flex", alignItems: "center", gap: 12 }} data-testid={`user-model-${m.id}`}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontWeight: 650 }}>{m.name}</span>
              {preferred === m.id ? <span style={badge}>Default</span> : null}
            </div>
            <div style={{ fontSize: 12, color: "var(--orvyn-text-muted)", marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {m.apiModelId} · {m.endpoint} · {m.hasApiKey ? "key saved" : "no key"}{m.capabilities.tools ? " · tools" : ""}{m.capabilities.vision ? " · images" : ""}
            </div>
            {tests[m.id] ? <div style={{ fontSize: 12, marginTop: 4 }}>{tests[m.id]}</div> : null}
          </div>
          {preferred === m.id
            ? <button style={ghost} disabled={busy} onClick={() => void setDefault(null)}>Use ORVYN Auto</button>
            : <button style={ghost} disabled={busy} onClick={() => void setDefault(m.id)} title="Used whenever Auto is selected">Use by default</button>}
          <button style={ghost} onClick={() => void test(m.id)}>Test</button>
          <button style={ghost} onClick={() => setForm({ id: m.id, name: m.name, endpoint: m.endpoint, apiModelId: m.apiModelId ?? "", apiKey: "", tools: m.capabilities.tools !== false, vision: m.capabilities.vision === true, contextWindow: String(m.contextWindow ?? 128000) })}>Edit</button>
          <button style={{ ...ghost, color: "#e06c75" }} disabled={busy} onClick={() => void remove(m.id)}>Remove</button>
        </div>
      ))}
    </div>
  );
}

const section: React.CSSProperties = { fontSize: 11, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--orvyn-text-muted)", marginBottom: 8, fontWeight: 650 };
const card: React.CSSProperties = { padding: "12px 14px", border: "1px solid var(--orvyn-border-soft)", borderRadius: 10, background: "var(--orvyn-surface-2)" };
const badge: React.CSSProperties = { fontSize: 10, padding: "1px 7px", borderRadius: 99, border: "1px solid var(--orvyn-border)", color: "var(--orvyn-text-muted)" };
const input: React.CSSProperties = { background: "var(--orvyn-bg)", border: "1px solid var(--orvyn-border)", borderRadius: 6, color: "var(--orvyn-text)", fontSize: 13, padding: "6px 9px", outline: "none" };
const primary: React.CSSProperties = { background: "var(--orvyn-purple, #6C5CFF)", border: "none", borderRadius: 8, color: "#fff", padding: "7px 14px", fontSize: 13, cursor: "pointer" };
const ghost: React.CSSProperties = { background: "transparent", border: "1px solid var(--orvyn-border)", borderRadius: 8, color: "var(--orvyn-text)", padding: "6px 12px", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap" };
