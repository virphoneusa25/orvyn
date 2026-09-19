import React, { useEffect, useState } from "react";
import { apiUrl, authHeaders } from "../connection";
import { api, ModelConfig } from "../api";

interface GeneratedImage {
  relativePath?: string;
  dataUrl?: string;
  url?: string;
}

export function ImagePanel({ workspaceRoot }: { workspaceRoot: string | null }) {
  const [prompt, setPrompt] = useState("");
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [modelId, setModelId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [usedModel, setUsedModel] = useState<string | null>(null);

  useEffect(() => {
    api.listModels().then(({ models: list }) => {
      const imageModels = list.filter((m) => m.capabilities.image);
      setModels(imageModels);
      setModelId((prev) => prev || imageModels[0]?.id || "");
    }).catch(() => undefined);
  }, []);

  async function generate() {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(apiUrl("/images/generate"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          prompt: prompt.trim(),
          projectRoot: workspaceRoot,
          modelId: modelId || undefined,
          size: "1024x1024",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setUsedModel(data.model);
      setImages((prev) => [...(data.images ?? []), ...prev]);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 20, color: "var(--text)", height: "100%", overflowY: "auto" }}>
      <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Image generator</div>
      <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 16 }}>
        Uses Cheaper Inference image models (nano-banana / GPT Image). Saves into{" "}
        <code>.orvyn/generated/</code> when a folder is open. Agent can call the same
        <code> generate_image</code> tool.
      </div>

      {models.length === 0 && (
        <div style={{ fontSize: 12, color: "var(--warning)", marginBottom: 12 }}>
          No image-capable model is registered. Restart the backend with CHEAPER_INFERENCE_API_KEY set.
        </div>
      )}

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="A clean app icon of a phone made of light, dark background, no text…"
        rows={4}
        style={{
          width: "100%",
          maxWidth: 720,
          background: "var(--bg-app)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          color: "var(--text)",
          padding: 10,
          fontSize: 13,
          fontFamily: "inherit",
          resize: "vertical",
        }}
      />
      <div style={{ display: "flex", gap: 8, marginTop: 10, maxWidth: 720, alignItems: "center" }}>
        <select
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
          style={{
            flex: 1,
            background: "var(--bg-app)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            color: "var(--text)",
            padding: "6px 8px",
            fontSize: 13,
          }}
        >
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <button
          onClick={() => void generate()}
          disabled={busy || !prompt.trim() || models.length === 0}
          style={{
            background: "var(--accent)",
            border: "none",
            borderRadius: 6,
            color: "white",
            padding: "7px 16px",
            cursor: "pointer",
            opacity: busy || !prompt.trim() ? 0.5 : 1,
          }}
        >
          {busy ? "Generating…" : "Generate"}
        </button>
      </div>
      {error && (
        <div style={{ marginTop: 12, color: "var(--danger)", fontSize: 12 }}>{error}</div>
      )}
      {usedModel && (
        <div style={{ marginTop: 10, fontSize: 11, color: "var(--text-muted)" }}>Last model: {usedModel}</div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12, marginTop: 20 }}>
        {images.map((img, i) => (
          <div key={`${img.relativePath ?? img.url ?? i}`} style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", background: "var(--bg-elevated)" }}>
            {(img.dataUrl || img.url) && (
              <img src={img.dataUrl || img.url} alt="" style={{ width: "100%", display: "block", background: "#000" }} />
            )}
            <div style={{ padding: 8, fontSize: 11, color: "var(--text-muted)" }}>
              {img.relativePath || img.url || "image"}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
