import React, { useEffect, useState } from "react";
import { getConnectionConfig, loadConnectionConfig, saveConnectionConfig } from "../connection";

export function ConnectionSettings() {
  const [backendUrl, setBackendUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [statusDetail, setStatusDetail] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    loadConnectionConfig().then((c) => {
      setBackendUrl(c.backendUrl);
      setApiKey(c.apiKey);
    });
  }, []);

  async function handleTest() {
    setStatus("testing");
    try {
      const res = await fetch(`${backendUrl.replace(/\/$/, "")}/api/v1/health`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStatus("ok");
      setStatusDetail(`${data.service} v${data.version}`);
    } catch (err: any) {
      setStatus("error");
      setStatusDetail(err.message);
    }
  }

  async function handleSave() {
    await saveConnectionConfig({ backendUrl: backendUrl.trim(), apiKey: apiKey.trim() });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div style={{ padding: 20, color: "#c9d1e0", maxWidth: 480 }}>
      <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Connection</div>
      <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 16 }}>
        Point ORVYN at a local backend (default) or a backend you've deployed to a cloud server.
        Every panel — Chat, Composer, Agent, Search, Model Manager — uses this connection.
      </div>

      <label style={{ display: "block", fontSize: 11, opacity: 0.6, marginBottom: 4 }}>Backend URL</label>
      <input
        value={backendUrl}
        onChange={(e) => setBackendUrl(e.target.value)}
        placeholder="http://localhost:4570 or https://orvyn.yourdomain.com"
        style={inputStyle()}
      />

      <label style={{ display: "block", fontSize: 11, opacity: 0.6, marginBottom: 4, marginTop: 12 }}>
        API Key (required once the backend has ORVYN_API_KEY set — e.g. any cloud deployment)
      </label>
      <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" style={inputStyle()} />

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button onClick={handleSave} style={{ background: "#3b5bfd", border: "none", borderRadius: 6, color: "white", padding: "6px 14px", cursor: "pointer" }}>
          {saved ? "Saved ✓" : "Save"}
        </button>
        <button onClick={handleTest} disabled={status === "testing"} style={btnGhost()}>
          {status === "testing" ? "Testing…" : "Test Connection"}
        </button>
      </div>

      {status === "ok" && (
        <div style={{ marginTop: 12, padding: 10, borderRadius: 6, background: "#0f2418", border: "1px solid #1f5c3a", fontSize: 12 }}>
          ✓ Connected — {statusDetail}
        </div>
      )}
      {status === "error" && (
        <div style={{ marginTop: 12, padding: 10, borderRadius: 6, background: "#2a1420", border: "1px solid #4a2230", fontSize: 12 }}>
          ✗ Could not reach backend: {statusDetail}
        </div>
      )}

      <div style={{ marginTop: 20, fontSize: 11, opacity: 0.5 }}>
        Current: {getConnectionConfig().backendUrl || "(not set)"}
      </div>
    </div>
  );
}

function inputStyle(): React.CSSProperties {
  return { width: "100%", background: "#0f1420", border: "1px solid #1c2330", borderRadius: 6, color: "#e6e9f0", padding: "6px 10px", fontSize: 13 };
}

function btnGhost(): React.CSSProperties {
  return { background: "transparent", border: "1px solid #2a3244", borderRadius: 6, color: "#c9d1e0", padding: "6px 14px", fontSize: 13, cursor: "pointer" };
}
