import React, { useState, useRef } from "react";
import { wsUrl } from "../connection";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export function AIChatPanel({
  currentFile,
}: {
  currentFile: { path: string; content: string } | null;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [useRag, setUseRag] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);

  function send() {
    if (!input.trim() || streaming) return;
    const userMessage = input.trim();
    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    setMessages((prev) => [...prev, { role: "user", content: userMessage }, { role: "assistant", content: "" }]);
    setInput("");
    setStreaming(true);

    const ws = new WebSocket(wsUrl("/ws/chat"));
    socketRef.current = ws;
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          task: "chat",
          history,
          userMessage,
          context: { ...(currentFile ? { currentFile } : {}), useRag },
        })
      );
    };
    ws.onmessage = (event) => {
      const chunk = JSON.parse(event.data);
      setMessages((prev) => {
        const copy = [...prev];
        copy[copy.length - 1] = {
          role: "assistant",
          content: copy[copy.length - 1].content + (chunk.delta ?? ""),
        };
        return copy;
      });
      if (chunk.done) {
        setStreaming(false);
        ws.close();
      }
    };
    ws.onerror = () => setStreaming(false);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", color: "#c9d1e0" }}>
      <div style={{ padding: "8px 12px", borderBottom: "1px solid #1c2330", fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>AI Assistant {currentFile ? `· context: ${currentFile.path}` : ""}</span>
        <label style={{ fontSize: 11, fontWeight: 400, display: "flex", alignItems: "center", gap: 4, cursor: "pointer", opacity: 0.8 }}>
          <input type="checkbox" checked={useRag} onChange={(e) => setUseRag(e.target.checked)} />
          RAG
        </label>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 12, fontSize: 13 }}>
        {messages.map((m, i) => (
          <div key={i} style={{ marginBottom: 12 }}>
            <div style={{ opacity: 0.5, fontSize: 11, marginBottom: 2 }}>
              {m.role === "user" ? "YOU" : "VIRIDE"}
            </div>
            <div style={{ whiteSpace: "pre-wrap" }}>{m.content || (streaming ? "…" : "")}</div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", padding: 8, borderTop: "1px solid #1c2330", gap: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Ask VirIDE…"
          style={{
            flex: 1,
            background: "#0f1420",
            border: "1px solid #1c2330",
            borderRadius: 6,
            color: "#e6e9f0",
            padding: "6px 10px",
            fontSize: 13,
          }}
        />
        <button
          onClick={send}
          disabled={streaming}
          style={{
            background: "#3b5bfd",
            border: "none",
            borderRadius: 6,
            color: "white",
            padding: "6px 14px",
            cursor: "pointer",
            opacity: streaming ? 0.5 : 1,
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
