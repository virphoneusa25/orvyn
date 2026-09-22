// apps/desktop/src/renderer/components/workspace/DesktopView.tsx
//
// Desktop is a REAL isolated virtual computer (Linux desktop with Xvfb +
// window manager + Chromium + terminal + file manager inside a Docker
// container on the OVH worker). It is NOT a browser viewport.
//
// Browser is a SEPARATE Workbench tab with an embedded web view.
// They share nothing except the Workbench tab system.
//
// When the backend cannot run Docker (local Windows dev without Docker),
// Desktop truthfully says it needs ORVYN Cloud — no Playwright fake.

import React, { useEffect, useRef, useState } from "react";
import { apiUrl, authHeaders } from "../../connection";
import { onConnectionFacts } from "../../connectionRuntime";
import { deriveCloudConnectionState } from "../../connectionState";
import { OrionCursorOverlay } from "./OrionCursorOverlay";
import { emptyBody, emptyTitle, ghostBtn } from "./workspaceChrome";

type ControlOwner = "orion" | "user" | "none";

interface DesktopPublic {
  id: string;
  status: string;
  controlOwner: ControlOwner;
  width: number;
  height: number;
  url?: string;
  live: boolean;
  transport?: string;
  error?: string;
}

export function DesktopView({
  projectRoot,
  runId,
  cursor,
  status,
}: {
  projectRoot: string | null;
  runId?: string | null;
  cursor?: { x: number; y: number; kind: "click" | "type" | "scroll" | "hover" | "navigate" | "other" } | null;
  status?: string | null;
}) {
  const [session, setSession] = useState<DesktopPublic | null>(null);
  const [sandboxAvailable, setSandboxAvailable] = useState<boolean | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [quality, setQuality] = useState<"auto" | "low" | "high">("auto");
  const [interrupted, setInterrupted] = useState(false);
  const [cloudState, setCloudState] = useState<string>("local");
  const viewRef = useRef<HTMLDivElement | null>(null);

  // React to cloud connection changes — Desktop re-evaluates immediately
  // after sign-in/sign-out, no app restart needed.
  useEffect(() => {
    const off = onConnectionFacts((facts) => {
      setCloudState(deriveCloudConnectionState(facts));
      // Re-probe desktop availability when the backend changes
      setSandboxAvailable(null);
      void refreshSession();
    });
    return off;
  }, []);

  async function refreshSession() {
    if (!projectRoot) return;
    const q = new URLSearchParams({ projectRoot, ...(runId ? { runId } : {}) });
    const res = await fetch(apiUrl(`/desktop/session?${q}`), { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    setSandboxAvailable(data.sandbox === true);
    setSession(data.session ?? null);
  }

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  async function pullFrame() {
    if (!projectRoot || !session?.live) return;
    try {
      const q = new URLSearchParams({ projectRoot, ...(runId ? { runId } : {}) });
      const res = await fetch(apiUrl(`/desktop/frame?${q}`), { headers: authHeaders() });
      if (!res.ok) {
        setInterrupted(true);
        return;
      }
      setInterrupted(false);
      const blob = await res.blob();
      if (!blob.type.startsWith("image/")) return; // auth error body
      // Canvas rendering: decode blob → draw to canvas. More reliable than
      // <img> for streaming — no data URL churn, no broken-image states.
      const bitmap = await createImageBitmap(blob);
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(bitmap, 0, 0);
          setFrame("canvas"); // signal: frame drawn to canvas
        }
      }
      bitmap.close();
    } catch {
      setInterrupted(true);
    }
  }

  useEffect(() => {
    void refreshSession();
    const id = setInterval(() => void refreshSession(), 2000);
    return () => clearInterval(id);
  }, [projectRoot, runId]);

  // AUTO-START: when the Desktop tab is opened with a project, cloud
  // connected, and no existing session, start one automatically — the user
  // should never have to click a separate Start button (Cursor behavior).
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current || !projectRoot || sandboxAvailable !== true) return;
    if (session || starting) return;
    autoStarted.current = true;
    void startSession();
  }, [projectRoot, sandboxAvailable, session, starting]);

  useEffect(() => {
    if (!session?.live) return;
    void pullFrame();
    const ms = quality === "low" ? 220 : quality === "high" ? 55 : 90;
    const id = setInterval(() => void pullFrame(), ms);
    return () => clearInterval(id);
  }, [session?.id, session?.live, session?.controlOwner, projectRoot, runId, quality]);

  async function startSession() {
    if (!projectRoot) return;
    setStarting(true);
    setError(null);
    const res = await fetch(apiUrl("/desktop/session"), {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ projectRoot, runId }),
    });
    const data = await res.json();
    if (!res.ok) setError(data.error ?? "Desktop could not start.");
    else setSession(data.session);
    setStarting(false);
  }

  async function setOwner(owner: "user" | "orion") {
    if (!projectRoot) return;
    const res = await fetch(apiUrl("/desktop/control"), {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ projectRoot, runId, owner }),
    });
    const data = await res.json();
    if (!res.ok) setError(data.error ?? "Control change blocked.");
    else setSession(data.session);
  }

  async function sendInput(type: string, extra: Record<string, unknown>) {
    if (!projectRoot || session?.controlOwner !== "user") return;
    const box = viewRef.current?.getBoundingClientRect();
    await fetch(apiUrl("/desktop/input"), {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        projectRoot,
        runId,
        type,
        viewWidth: box?.width ?? session?.width,
        viewHeight: box?.height ?? session?.height,
        ...extra,
      }),
    });
  }

  // ── Honest states, in truth order ──────────────────────────────────────

  if (!projectRoot) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 28, gap: 8, textAlign: "center" }}>
        <div style={emptyTitle()}>Open a project to start Desktop</div>
        <div style={emptyBody()}>Desktop is a full virtual Linux computer ORION can see and control.</div>
      </div>
    );
  }

  // No Docker on the backend (local Windows) → Desktop truthfully needs Cloud.
  // This gate appears ONLY when the user is actually signed out/local —
  // never for worker-offline, sync errors, or stream errors (those get
  // their own specific states below).
  if (sandboxAvailable === false) {
    const signedOut = cloudState === "local" || cloudState === "signed-out" || cloudState === "session-expired";
    const label = signedOut ? "Desktop requires ORVYN Cloud" : "Desktop unavailable on this backend";
    const detail = signedOut
      ? "Desktop sessions run as isolated Linux computers (wallpaper, taskbar, Chromium, terminal) on ORVYN infrastructure — not as browser viewports."
      : "You are connected, but this backend does not have the Docker sandbox runtime. Use ORVYN Cloud for Desktop sessions.";
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 28, gap: 10, textAlign: "center" }}>
        <div style={emptyTitle()}>{label}</div>
        <div style={emptyBody()}>{detail}</div>
        {signedOut && (
          <button
            style={{ ...ghostBtn(), padding: "8px 20px", fontSize: 12.5 }}
            onClick={() => document.dispatchEvent(new CustomEvent("orvyn:nav", { detail: "settings" }))}
          >
            Connect to ORVYN Cloud
          </button>
        )}
      </div>
    );
  }

  if (!session || session.status === "ended") {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 28, gap: 10, textAlign: "center" }}>
        <div style={emptyTitle()}>ORVYN Desktop</div>
        <div style={emptyBody()}>
          A full virtual Linux desktop — wallpaper, window manager, Chromium, terminal — that ORION operates visually. Take Control to use it yourself.
        </div>
        {error && <div style={{ color: "var(--orvyn-red)", fontSize: 12 }}>{error}</div>}
        <button style={ghostBtn()} disabled={starting} onClick={() => void startSession()}>
          {starting ? "Starting Desktop…" : "Start Desktop"}
        </button>
      </div>
    );
  }

  if (session.status === "starting") {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10 }}>
        <div style={emptyTitle()}>Starting Desktop…</div>
        <div style={emptyBody()}>Booting the virtual Linux desktop (Xvfb + openbox + Chromium).</div>
      </div>
    );
  }

  const user = session.controlOwner === "user";

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "#070b14" }}>
      {/* Control bar — shows DESKTOP state, not browser URLs */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderBottom: "1px solid var(--orvyn-border-soft)" }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: user ? "var(--orvyn-yellow)" : "var(--orvyn-cyan)" }}>
          {user ? "You are controlling" : session.controlOwner === "orion" ? "ORION controlling" : session.status}
        </span>
        <span style={{ flex: 1, fontSize: 10.5, color: "var(--orvyn-text-muted)", fontFamily: "var(--font-mono)" }}>
          Desktop session · {session.width}×{session.height} · {session.transport === "sandbox-x11" ? "Linux sandbox" : session.status}
        </span>
        <select
          value={quality}
          onChange={(e) => setQuality(e.target.value as "auto" | "low" | "high")}
          title="Desktop stream quality"
          style={{ background: "transparent", border: "1px solid var(--orvyn-border-soft)", color: "var(--orvyn-text-secondary)", fontSize: 10, borderRadius: 6, padding: "2px 4px" }}
        >
          <option value="auto">Auto</option>
          <option value="low">Low</option>
          <option value="high">High</option>
        </select>
        {user ? (
          <button style={ghostBtn()} onClick={() => void setOwner("orion")}>Return to ORION</button>
        ) : (
          <button style={ghostBtn()} onClick={() => void setOwner("user")}>Take Control</button>
        )}
        <button style={ghostBtn()} onClick={() => void fetch(apiUrl("/desktop/stop"), { method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ projectRoot, runId }) }).then(() => setSession(null))}>
          Stop
        </button>
      </div>

      {/* The live virtual desktop viewport */}
      <div
        ref={viewRef}
        style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden" }}
        onMouseMove={user ? (e) => {
          const r = e.currentTarget.getBoundingClientRect();
          void sendInput("move", { x: e.clientX - r.left, y: e.clientY - r.top });
        } : undefined}
        onClick={user ? (e) => {
          const r = e.currentTarget.getBoundingClientRect();
          void sendInput("click", { x: e.clientX - r.left, y: e.clientY - r.top });
        } : undefined}
        tabIndex={user ? 0 : -1}
        onContextMenu={user ? (e) => {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          void sendInput("rightclick", { x: e.clientX - r.left, y: e.clientY - r.top });
        } : undefined}
        onDoubleClick={user ? (e) => {
          const r = e.currentTarget.getBoundingClientRect();
          void sendInput("dblclick", { x: e.clientX - r.left, y: e.clientY - r.top });
        } : undefined}
        onKeyDown={user ? (e) => {
          e.preventDefault();
          void sendInput("key", { key: e.key });
        } : undefined}
        onWheel={user ? (e) => {
          e.preventDefault();
          void sendInput("scroll", { deltaY: e.deltaY });
        } : undefined}
      >
        {interrupted && (
          <div style={{ position: "absolute", inset: 0, zIndex: 5, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, background: "rgba(7,11,20,0.78)" }}>
            <div style={emptyTitle()}>Desktop connection interrupted</div>
            <button style={ghostBtn()} onClick={() => { setInterrupted(false); void refreshSession().then(() => void pullFrame()); }}>Reconnect</button>
          </div>
        )}
        <canvas
          ref={canvasRef}
          style={{
            display: frame ? "block" : "none",
            width: "100%",
            height: "100%",
            objectFit: "contain",
            pointerEvents: "none",
          }}
        />
        {!frame && (
          <div style={{ ...emptyBody(), padding: 24, display: "flex", flexDirection: "column", alignItems: "center", gap: 8, position: "absolute", inset: 0 }}>
            <div>Connecting to Desktop…</div>
            <div style={{ fontSize: 10, color: "var(--orvyn-text-muted)" }}>Streaming the live virtual desktop</div>
          </div>
        )}
        {!user && (
          <OrionCursorOverlay cursor={cursor ?? null} status={status ?? "ORION is operating this desktop"} />
        )}
        {!user && (
          <button
            onClick={() => void setOwner("user")}
            style={{
              position: "absolute",
              left: "50%",
              bottom: 28,
              transform: "translateX(-50%)",
              background: "rgba(11,18,32,0.86)",
              border: "1px solid var(--orvyn-border)",
              color: "var(--orvyn-text)",
              borderRadius: 999,
              padding: "8px 16px",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Take Control
          </button>
        )}
      </div>
      {error && <div style={{ padding: "6px 10px", color: "var(--orvyn-yellow)", fontSize: 11 }}>{error}</div>}
    </div>
  );
}
