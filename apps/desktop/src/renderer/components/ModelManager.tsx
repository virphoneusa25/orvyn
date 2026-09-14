import React, { useEffect, useState, useCallback } from "react";
import { api, ModelConfig, ModelHealthResult, ModelTestResult, ModelCapabilities } from "../api";

const PROVIDERS: ModelConfig["provider"][] = [
  "ollama",
  "vllm",
  "llamacpp",
  "openai-compatible",
  "custom-http",
  "mock",
];

const TASKS = ["chat", "code", "completion", "embedding", "agent", "vision"] as const;

const EMPTY_CAPS: ModelCapabilities = {
  chat: true,
  code: false,
  agent: false,
  tools: false,
  vision: false,
  embeddings: false,
  completion: false,
};

function emptyModel(): ModelConfig {
  return {
    id: "",
    name: "",
    provider: "ollama",
    endpoint: "http://localhost:11434",
    apiKey: "",
    contextWindow: 8192,
    maxOutputTokens: 2048,
    defaultTemperature: 0.2,
    defaultTopP: 1,
    streaming: true,
    capabilities: { ...EMPTY_CAPS },
  };
}

const STATUS_COLOR: Record<string, string> = {
  online: "#3fd68a",
  connecting: "#e8b93f",
  offline: "#5a6478",
  error: "#f0546a",
};

function StatusDot({ status }: { status?: string }) {
  return (
    <span
      title={status ?? "unknown"}
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: STATUS_COLOR[status ?? "offline"] ?? "#5a6478",
        marginRight: 6,
      }}
    />
  );
}

function labelStyle(): React.CSSProperties {
  return { display: "block", fontSize: 11, opacity: 0.6, marginBottom: 3, marginTop: 10 };
}

function inputStyle(): React.CSSProperties {
  return {
    width: "100%",
    background: "#0f1420",
    border: "1px solid #1c2330",
    borderRadius: 6,
    color: "#e6e9f0",
    padding: "6px 8px",
    fontSize: 13,
  };
}

function ModelForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: ModelConfig;
  onSave: (m: ModelConfig) => void;
  onCancel: () => void;
}) {
  const [model, setModel] = useState<ModelConfig>(initial);
  const isEditing = !!initial.id;

  function setCap(key: keyof ModelCapabilities, value: boolean) {
    setModel((m) => ({ ...m, capabilities: { ...m.capabilities, [key]: value } }));
  }

  return (
    <div style={{ background: "#0d111a", border: "1px solid #1c2330", borderRadius: 8, padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
        {isEditing ? `Edit ${initial.id}` : "Add Model"}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <label style={labelStyle()}>Model ID</label>
          <input
            style={inputStyle()}
            value={model.id}
            disabled={isEditing}
            placeholder="e.g. llama3, my-custom-model"
            onChange={(e) => setModel({ ...model, id: e.target.value })}
          />
        </div>
        <div>
          <label style={labelStyle()}>Display Name</label>
          <input
            style={inputStyle()}
            value={model.name}
            placeholder="e.g. Llama 3 (Ollama)"
            onChange={(e) => setModel({ ...model, name: e.target.value })}
          />
        </div>

        <div>
          <label style={labelStyle()}>Provider</label>
          <select style={inputStyle()} value={model.provider} onChange={(e) => setModel({ ...model, provider: e.target.value as ModelConfig["provider"] })}>
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={labelStyle()}>Endpoint</label>
          <input
            style={inputStyle()}
            value={model.endpoint}
            placeholder="http://localhost:11434"
            onChange={(e) => setModel({ ...model, endpoint: e.target.value })}
          />
        </div>

        <div>
          <label style={labelStyle()}>API Key (optional)</label>
          <input
            style={inputStyle()}
            type="password"
            value={model.apiKey ?? ""}
            onChange={(e) => setModel({ ...model, apiKey: e.target.value })}
          />
        </div>
        <div />

        <div>
          <label style={labelStyle()}>Context Window</label>
          <input
            type="number"
            style={inputStyle()}
            value={model.contextWindow}
            onChange={(e) => setModel({ ...model, contextWindow: Number(e.target.value) })}
          />
        </div>
        <div>
          <label style={labelStyle()}>Max Output Tokens</label>
          <input
            type="number"
            style={inputStyle()}
            value={model.maxOutputTokens}
            onChange={(e) => setModel({ ...model, maxOutputTokens: Number(e.target.value) })}
          />
        </div>

        <div>
          <label style={labelStyle()}>Temperature</label>
          <input
            type="number"
            step="0.1"
            style={inputStyle()}
            value={model.defaultTemperature}
            onChange={(e) => setModel({ ...model, defaultTemperature: Number(e.target.value) })}
          />
        </div>
        <div>
          <label style={labelStyle()}>Top P</label>
          <input
            type="number"
            step="0.1"
            style={inputStyle()}
            value={model.defaultTopP}
            onChange={(e) => setModel({ ...model, defaultTopP: Number(e.target.value) })}
          />
        </div>
      </div>

      <label style={labelStyle()}>Capabilities</label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontSize: 12 }}>
        {(Object.keys(EMPTY_CAPS) as (keyof ModelCapabilities)[]).map((cap) => (
          <label key={cap} style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
            <input type="checkbox" checked={model.capabilities[cap]} onChange={(e) => setCap(cap, e.target.checked)} />
            {cap}
          </label>
        ))}
        <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
          <input type="checkbox" checked={model.streaming} onChange={(e) => setModel({ ...model, streaming: e.target.checked })} />
          streaming
        </label>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button
          onClick={() => onSave(model)}
          disabled={!model.id || !model.name}
          style={{ background: "#3b5bfd", border: "none", borderRadius: 6, color: "white", padding: "6px 14px", cursor: "pointer" }}
        >
          {isEditing ? "Save Changes" : "Add Model"}
        </button>
        <button
          onClick={onCancel}
          style={{ background: "transparent", border: "1px solid #2a3244", borderRadius: 6, color: "#c9d1e0", padding: "6px 14px", cursor: "pointer" }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function ModelManager() {
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [health, setHealth] = useState<Record<string, ModelHealthResult>>({});
  const [routing, setRoutingState] = useState<Record<string, string>>({});
  const [testResults, setTestResults] = useState<Record<string, ModelTestResult>>({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<ModelConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [{ models }, { overrides }] = await Promise.all([api.listModels(), api.getRouting()]);
      setModels(models);
      setRoutingState(overrides);
      setError(null);
    } catch (err: any) {
      setError(`Could not reach backend: ${err.message}`);
    }
  }, []);

  const refreshHealth = useCallback(async () => {
    try {
      const { results } = await api.healthAll();
      const byId: Record<string, ModelHealthResult> = {};
      for (const r of results) byId[r.id] = r;
      setHealth(byId);
    } catch {
      // Health is best-effort; a failed sweep shouldn't blank the list.
    }
  }, []);

  useEffect(() => {
    refresh();
    refreshHealth();
    const interval = setInterval(refreshHealth, 15000);
    return () => clearInterval(interval);
  }, [refresh, refreshHealth]);

  async function handleSave(model: ModelConfig) {
    const isNew = !models.some((m) => m.id === model.id);
    if (isNew) await api.addModel(model);
    else await api.updateModel(model.id, model);
    setEditing(null);
    refresh();
    refreshHealth();
  }

  async function handleDelete(id: string) {
    await api.deleteModel(id);
    refresh();
  }

  async function handleTest(id: string) {
    setTestingId(id);
    try {
      const result = await api.testModel(id);
      setTestResults((prev) => ({ ...prev, [id]: result }));
    } catch (err: any) {
      setTestResults((prev) => ({ ...prev, [id]: { ok: false, latencyMs: 0, error: err.message } }));
    } finally {
      setTestingId(null);
    }
  }

  async function handleRoutingChange(task: string, modelId: string) {
    await api.setRouting(task, modelId);
    setRoutingState((prev) => ({ ...prev, [task]: modelId }));
  }

  return (
    <div style={{ padding: 20, color: "#c9d1e0", overflowY: "auto", height: "100%" }}>
      <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>AI Models</div>
      <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 16 }}>
        Configure the models ORVYN talks to. Nothing here is tied to a specific vendor —
        point it at Ollama, vLLM, llama.cpp, or any custom HTTP model server.
      </div>

      {error && (
        <div style={{ background: "#2a1420", border: "1px solid #f0546a", borderRadius: 6, padding: 10, fontSize: 12, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {editing && (
        <ModelForm initial={editing} onSave={handleSave} onCancel={() => setEditing(null)} />
      )}

      {!editing && (
        <button
          onClick={() => setEditing(emptyModel())}
          style={{ background: "#3b5bfd", border: "none", borderRadius: 6, color: "white", padding: "6px 14px", cursor: "pointer", marginBottom: 16 }}
        >
          + Add Model
        </button>
      )}

      {models.map((model) => {
        const h = health[model.id];
        const t = testResults[model.id];
        return (
          <div key={model.id} style={{ border: "1px solid #1c2330", borderRadius: 8, padding: 12, marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                <StatusDot status={h?.status} />
                {model.name}
                <span style={{ opacity: 0.5, fontWeight: 400, marginLeft: 8 }}>
                  {model.id} · {model.provider}
                </span>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => handleTest(model.id)} disabled={testingId === model.id} style={btnGhost()}>
                  {testingId === model.id ? "Testing…" : "Test Model"}
                </button>
                <button onClick={() => setEditing(model)} style={btnGhost()}>
                  Edit
                </button>
                <button onClick={() => handleDelete(model.id)} style={{ ...btnGhost(), color: "#f0546a", borderColor: "#4a2230" }}>
                  Delete
                </button>
              </div>
            </div>

            <div style={{ fontSize: 11, opacity: 0.6, marginTop: 6 }}>
              endpoint: {model.endpoint || "(none)"} · context: {model.contextWindow.toLocaleString()} tok ·
              {" "}
              {Object.entries(model.capabilities)
                .filter(([, v]) => v)
                .map(([k]) => k)
                .join(", ") || "no capabilities set"}
              {h?.latencyMs !== undefined && ` · ${h.latencyMs}ms`}
              {h?.error && ` · ${h.error}`}
            </div>

            {t && (
              <div
                style={{
                  fontSize: 12,
                  marginTop: 8,
                  padding: 8,
                  borderRadius: 6,
                  background: t.ok ? "#0f2418" : "#2a1420",
                  border: `1px solid ${t.ok ? "#1f5c3a" : "#4a2230"}`,
                }}
              >
                {t.ok ? `✓ Responded in ${t.latencyMs}ms — "${t.snippet}"` : `✗ Failed (${t.latencyMs}ms): ${t.error}`}
              </div>
            )}
          </div>
        );
      })}

      <div style={{ fontSize: 13, fontWeight: 600, marginTop: 24, marginBottom: 8 }}>Model Routing</div>
      <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 10 }}>
        Which model handles each kind of request. Falls back automatically to any model with the right capability if unset.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", rowGap: 8, columnGap: 12, fontSize: 13, maxWidth: 420 }}>
        {TASKS.map((task) => (
          <React.Fragment key={task}>
            <div style={{ alignSelf: "center", textTransform: "capitalize" }}>{task}</div>
            <select
              style={inputStyle()}
              value={routing[task] ?? ""}
              onChange={(e) => handleRoutingChange(task, e.target.value)}
            >
              <option value="" disabled>
                (auto — first capable model)
              </option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

function btnGhost(): React.CSSProperties {
  return {
    background: "transparent",
    border: "1px solid #2a3244",
    borderRadius: 6,
    color: "#c9d1e0",
    padding: "4px 10px",
    fontSize: 12,
    cursor: "pointer",
  };
}
