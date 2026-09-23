// apps/desktop/src/renderer/components/workspace/DesktopView.tsx
//
// Desktop is a REAL isolated virtual computer (Linux desktop with Xvfb +
// openbox + tint2 panel/dock + Thunar + Chromium + terminal inside a
// Docker container on the OVH worker). It is NOT a browser viewport.
//
// Browser is a SEPARATE Workbench tab with an embedded web view.
// They share nothing except the Workbench tab system.
//
// Layout follows the approved ORVYN desktop mockup:
//   session header (Running · resolution · overflow · End Session)
//   large letterboxed live framebuffer (Take Control overlay / user pill)
//   action bar (status · Send Keys · Screenshot · Full Screen · More)

import React, { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl, authHeaders } from "../../connection";
import { onConnectionFacts } from "../../connectionRuntime";
import { deriveCloudConnectionState } from "../../connectionState";
import { letterboxRect, remoteToClient, type Rect } from "../../desktopMapping";
import { FRAME_REQUEST_MS, imageKind, sessionCanStream, shouldCoverFrame } from "../../desktopStream";
import { OrionCursorOverlay } from "./OrionCursorOverlay";
import { emptyBody, emptyTitle, ghostBtn, iconBtn } from "./workspaceChrome";

type ControlOwner = "orion" | "user" | "none";

interface DesktopResources { os?: string; vcpus?: number; memoryMb?: number }

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
  resources?: DesktopResources;
  startedAt?: string;
}

const SEND_KEYS: { label: string; combo: string }[] = [
  { label: "Ctrl+Alt+Del", combo: "ctrlaltdel" },
  { label: "Ctrl+C", combo: "ctrl+c" },
  { label: "Ctrl+V", combo: "ctrl+v" },
  { label: "Alt+Tab", combo: "alt+tab" },
  { label: "Esc", combo: "esc" },
  { label: "Enter", combo: "enter" },
];

function Dot({ color }: { color: string }) {
  return (
    <span style={{
      width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0,
      boxShadow: `0 0 8px ${color}`,
    }} />
  );
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
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [quality, setQuality] = useState<"auto" | "low" | "high">("auto");
  const [interrupted, setInterrupted] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [cloudState, setCloudState] = useState<string>("local");
  const [fullscreen, setFullscreen] = useState(false);
  const [openMenu, setOpenMenu] = useState<"sendkeys" | "more" | "overflow" | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [frameDrawn, setFrameDrawn] = useState(false);
  const [streamNote, setStreamNote] = useState<string | null>(null);
  const [imageRect, setImageRect] = useState<Rect>({ x: 0, y: 0, w: 0, h: 0 });
  const viewRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastFrameAt = useRef(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }

  // React to cloud connection changes — Desktop re-evaluates immediately
  // after sign-in/sign-out, no app restart needed.
  useEffect(() => {
    const off = onConnectionFacts((facts) => {
      setCloudState(deriveCloudConnectionState(facts));
      setSandboxAvailable(null);
      void refreshSession();
    });
    return off;
  }, []);

  const refreshSession = useCallback(async () => {
    if (!projectRoot) return;
    const q = new URLSearchParams({ projectRoot, ...(runId ? { runId } : {}) });
    try {
      const res = await fetch(apiUrl(`/desktop/session?${q}`), { headers: authHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      setSandboxAvailable(data.sandbox === true);
      setSession(data.session ?? null);
    } catch { /* transient */ }
  }, [projectRoot, runId]);

  const sessionRef = useRef(session);
  sessionRef.current = session;
  const projectRef = useRef(projectRoot);
  projectRef.current = projectRoot;
  const runRef = useRef(runId);
  runRef.current = runId;
  const qualityRef = useRef(quality);
  qualityRef.current = quality;
  const frameInFlight = useRef(false);

  async function pullFrame() {
    const root = projectRef.current;
    const current = sessionRef.current;
    if (!root || !sessionCanStream(current) || frameInFlight.current) return;
    frameInFlight.current = true;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FRAME_REQUEST_MS);
    const noteProblem = (message: string) => {
      if (!shouldCoverFrame(lastFrameAt.current, Date.now())) return;
      setInterrupted(true);
      setStreamNote(message);
    };
    try {
      const q = new URLSearchParams({ projectRoot: root, q: qualityRef.current, ...(runRef.current ? { runId: runRef.current } : {}) });
      const res = await fetch(apiUrl(`/desktop/frame?${q}&_=${Date.now()}`), { headers: authHeaders(), cache: "no-store", signal: ctrl.signal });
      if (!res.ok) {
        noteProblem(res.status === 409 ? "The desktop is up, but the picture is not ready yet." : `Picture request failed (${res.status}).`);
        return;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      const kind = imageKind(bytes);
      if (!kind) {
        noteProblem("Desktop replied without a picture.");
        return;
      }
      const bitmap = await createImageBitmap(new Blob([bytes], { type: kind === "png" ? "image/png" : "image/jpeg" }));
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(bitmap, 0, 0);
          setFrameDrawn(true);
          setInterrupted(false);
          setStreamNote(null);
          lastFrameAt.current = Date.now();
        }
      }
      bitmap.close();
    } catch {
      noteProblem("The picture stream timed out.");
    } finally {
      clearTimeout(timer);
      frameInFlight.current = false;
    }
  }

  useEffect(() => {
    void refreshSession();
    const id = setInterval(() => void refreshSession(), 2000);
    return () => clearInterval(id);
  }, [refreshSession]);

  // AUTO-START: clicking Desktop with a project + cloud connected starts a
  // session — the user never needs a separate Start button.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current || !projectRoot || sandboxAvailable !== true) return;
    if (session || starting) return;
    autoStarted.current = true;
    void startSession();
  }, [projectRoot, sandboxAvailable, session, starting]);

  const refreshRef = useRef(refreshSession);
  refreshRef.current = refreshSession;
  // One pump for the life of the pane. It reads the latest session through
  // refs, so a React re-render cannot stop the stream mid-frame.
  useEffect(() => {
    let stopped = false;
    const tick = () => { if (!stopped) void pullFrame(); };
    tick();
    const id = setInterval(tick, 120);
    const watchdog = setInterval(() => {
      if (sessionCanStream(sessionRef.current) && Date.now() - lastFrameAt.current > 5000) {
        void refreshRef.current();
      }
    }, 3000);
    return () => { stopped = true; clearInterval(id); clearInterval(watchdog); };
    // pullFrame closes over refs, not render state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Letterbox: measure the viewport container, keep the canvas element at
  // the aspect-preserved image rect so input mapping is exact at any DPI.
  useEffect(() => {
    const el = viewRef.current;
    if (!el || !session) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      const rect = letterboxRect(r.width, r.height, session.width, session.height);
      setImageRect(rect);
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.style.width = `${rect.w}px`;
        canvas.style.height = `${rect.h}px`;
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    // The Desktop tab is display:none until selected. A hidden measure
    // stores a 0×0 canvas and the picture stays invisible after the tab opens.
    const tick = window.setInterval(update, 400);
    return () => { ro.disconnect(); window.clearInterval(tick); };
  }, [session?.width, session?.height, session?.id, fullscreen, expanded]);

  // Esc exits fullscreen; menus close on outside click.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFullscreen(false); };
    const onDown = () => setOpenMenu(null);
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, []);

  async function post(path: string, body: Record<string, unknown> = {}): Promise<any> {
    const res = await fetch(apiUrl(path), {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ projectRoot, runId, ...body }),
    });
    return { ok: res.ok, data: await res.json().catch(() => ({})) };
  }

  async function startSession() {
    if (!projectRoot) return;
    setStarting(true);
    setError(null);
    const { ok, data } = await post("/desktop/session");
    if (!ok) setError(data.error ?? "Desktop could not start.");
    else setSession(data.session);
    setStarting(false);
  }

  async function setOwner(owner: "user" | "orion") {
    setSession((current) => current ? {
      ...current,
      controlOwner: owner,
      status: owner === "user" ? "user_control" : current.status === "user_control" ? "ready" : current.status,
    } : current);
    if (owner === "user") viewRef.current?.focus();
    const { ok, data } = await post("/desktop/control", { owner });
    if (!ok) {
      setError(data.error ?? "Control change blocked.");
      void refreshSession();
    } else setSession(data.session);
  }

  async function endSession() {
    if (!window.confirm("End this Desktop session? The virtual machine will be stopped.")) return;
    await post("/desktop/stop");
    setSession(null);
    setFrameDrawn(false);
    autoStarted.current = false;
  }

  async function sendInput(type: string, extra: Record<string, unknown>) {
    if (!projectRoot || sessionRef.current?.controlOwner !== "user") return;
    await post("/desktop/input", {
      type,
      viewWidth: imageRect.w || sessionRef.current?.width,
      viewHeight: imageRect.h || sessionRef.current?.height,
      ...extra,
    });
  }

  /** clientX/Y → coords inside the displayed image (letterbox-correct). */
  function imagePoint(e: React.MouseEvent): { x: number; y: number } | null {
    const r = canvasRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return null;
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (x < 0 || y < 0 || x > r.width || y > r.height) return null;
    return { x, y };
  }

  async function sendKeys(combo: string) {
    setOpenMenu(null);
    const { ok, data } = await post("/desktop/keys", { combo });
    if (!ok) showToast(data.error ?? "Key send failed");
  }

  async function screenshot() {
    setOpenMenu(null);
    const { ok, data } = await post("/desktop/screenshot");
    showToast(ok ? `Screenshot saved — ${data.artifact?.name ?? "artifact"}` : (data.error ?? "Screenshot failed"));
  }

  async function restart() {
    setOpenMenu(null);
    setError(null);
    const { ok, data } = await post("/desktop/restart");
    if (ok) { setSession(data.session); setFrameDrawn(false); }
    else setError(data.error ?? "Restart failed.");
  }

  async function reconnect() {
    setOpenMenu(null);
    setInterrupted(false);
    setSession(null);
    setFrameDrawn(false);
    // Check if the backend session is still alive; restart if dead
    await refreshSession();
    // If no session after refresh, start a fresh one
    if (!session) {
      await startSession();
    } else {
      void pullFrame();
    }
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
          A full virtual Linux desktop — wallpaper, panel, file manager, Chromium, terminal — that ORION operates visually. Take Control to use it yourself.
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
        <div style={emptyTitle()}>Starting ORVYN Desktop</div>
        <div style={emptyBody()}>Preparing secure Linux workspace…</div>
        <div style={{
          width: 22, height: 22, borderRadius: "50%", marginTop: 4,
          border: "2px solid rgba(34,211,238,0.25)", borderTopColor: "var(--orvyn-cyan)",
          animation: "orvyn-spin 0.9s linear infinite",
        }} />
        <style>{`@keyframes orvyn-spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (session.status === "error") {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, textAlign: "center", padding: 28 }}>
        <div style={{ ...emptyTitle(), color: "var(--orvyn-red)" }}>Desktop error</div>
        <div style={emptyBody()}>{session.error ?? "The desktop session failed."}</div>
        <button style={ghostBtn()} onClick={() => void startSession()}>Try again</button>
      </div>
    );
  }

  const user = session.controlOwner === "user";
  const res = session.resources;
  const ramGb = res?.memoryMb ? Math.round(res.memoryMb / 1024) : null;
  const resourceLine = res
    ? `${res.os ?? "Linux"} · ${res.vcpus ?? "?"} vCPU · ${ramGb ?? "?"} GB RAM`
    : `Linux · ${session.width}×${session.height}`;
  const statusLabel = user ? "User Control" : session.controlOwner === "orion" ? "Running" : session.status;
  const statusColor = user ? "#22d3ee" : "#34d399";

  const header = (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", flexShrink: 0, flexWrap: "wrap", minWidth: 0 }}>
      <span style={{ display: "inline-flex", alignItems: "flex-start", gap: 8, minWidth: 0 }}>
        <span style={{ marginTop: 5 }}><Dot color={statusColor} /></span>
        <span style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 650 }}>Live Desktop Session</div>
          <div style={{ fontSize: 11, color: "var(--orvyn-text-muted)" }}>ORION can operate this desktop. You can take control at any time.</div>
        </span>
      </span>
      <span style={{ flex: 1 }} />
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--orvyn-text-muted)" }}>
        <span style={{ opacity: 0.7 }}>Connection</span>
        <span style={{ color: "var(--orvyn-text)", fontWeight: 600 }}>Cloud Sandbox</span>
      </span>
      {!user && (
        <button
          style={{ ...ghostBtn(), background: "#2563eb", borderColor: "#2563eb", color: "#f8fafc", fontWeight: 650 }}
          onClick={() => void setOwner("user")}
        >
          Take Control
        </button>
      )}
      <button style={ghostBtn()} onClick={() => void setOwner("orion")}>Return to ORION</button>
      <div style={{ position: "relative" }} onMouseDown={(e) => e.stopPropagation()}>
        <button title="More" style={iconBtn()} onClick={() => setOpenMenu(openMenu === "overflow" ? null : "overflow")}>
          <svg width="14" height="14" viewBox="0 0 16 16"><circle cx="3" cy="8" r="1.4" fill="currentColor" /><circle cx="8" cy="8" r="1.4" fill="currentColor" /><circle cx="13" cy="8" r="1.4" fill="currentColor" /></svg>
        </button>
        {openMenu === "overflow" && (
          <div style={menuStyle()}>
            <MenuItem label={expanded ? "Collapse" : "Expand"} onClick={() => { setOpenMenu(null); setExpanded((v) => !v); }} />
            <MenuItem label="Session details" onClick={() => { setOpenMenu(null); setDetailsOpen(true); }} />
            <MenuItem label="Reconnect" onClick={() => void reconnect()} />
            <MenuItem label="Restart desktop" onClick={() => void restart()} />
          </div>
        )}
      </div>
      <button
        style={{ ...ghostBtn(), background: "#dc2626", borderColor: "#dc2626", color: "#fff", fontWeight: 650 }}
        onClick={() => void endSession()}
      >
        Stop Session
      </button>
    </div>
  );

  const viewport = (
    <div
      ref={viewRef}
      style={{
        flex: 1, minWidth: 0, minHeight: 0, width: "100%", position: "relative", overflow: "hidden",
        background: "#04060f",
        outline: "none",
        cursor: "default",
      }}
      tabIndex={user ? 0 : -1}
      onMouseDown={user ? (e) => { e.currentTarget.focus(); } : undefined}
      onClick={user ? (e) => { const p = imagePoint(e); if (p) void sendInput("click", p); } : undefined}
      onContextMenu={user ? (e) => { e.preventDefault(); const p = imagePoint(e); if (p) void sendInput("rightclick", p); } : undefined}
      onDoubleClick={user ? (e) => { const p = imagePoint(e); if (p) void sendInput("dblclick", p); } : undefined}
      onKeyDown={user ? (e) => { e.preventDefault(); void sendInput("key", { key: e.key }); } : undefined}
      onWheel={user ? (e) => { e.preventDefault(); const p = imagePoint(e); if (p) void sendInput("scroll", { ...p, deltaY: e.deltaY }); } : undefined}
    >
      <canvas
        ref={canvasRef}
        style={{
          display: "block",
          pointerEvents: "none",
          position: "absolute",
          left: imageRect.w > 0 ? imageRect.x : 0,
          top: imageRect.h > 0 ? imageRect.y : 0,
          width: imageRect.w > 0 ? imageRect.w : "100%",
          height: imageRect.h > 0 ? imageRect.h : "100%",
          objectFit: "contain",
          maxWidth: "100%",
          maxHeight: "100%",
        }}
      />
      {!frameDrawn && (
        <div style={{ ...emptyBody(), position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, pointerEvents: "none" }}>
          <div>Connecting to Desktop…</div>
          <div style={{ fontSize: 10, color: "var(--orvyn-text-muted)" }}>{streamNote ?? "Streaming the live virtual desktop"}</div>
        </div>
      )}
      {interrupted && (
        <div style={{ position: "absolute", inset: 0, zIndex: 6, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, background: "rgba(7,11,20,0.78)" }}>
          <div style={emptyTitle()}>Reconnecting to Desktop…</div>
          {streamNote && <div style={{ fontSize: 11, color: "var(--orvyn-text-muted)", maxWidth: 280, textAlign: "center" }}>{streamNote}</div>}
          <button style={ghostBtn()} onClick={() => void reconnect()}>Reconnect now</button>
        </div>
      )}
      {user && (
        <div style={{
          position: "absolute", top: 10, left: 10, zIndex: 5, pointerEvents: "none",
          display: "inline-flex", alignItems: "center", gap: 6, fontSize: 10.5, fontWeight: 600,
          color: "#22d3ee", background: "rgba(11,18,32,0.8)", border: "1px solid rgba(34,211,238,0.35)",
          borderRadius: 999, padding: "3px 10px",
        }}>
          <Dot color="#22d3ee" /> You are controlling
        </div>
      )}
      {!user && session && (
        <OrionCursorOverlay
          cursor={cursor ? { ...cursor, ...remoteToClient(cursor.x, cursor.y, imageRect, session.width, session.height) } : null}
          status={status ?? "ORION is operating this desktop"}
        />
      )}
      {fullscreen && (
        <button
          onClick={() => setFullscreen(false)}
          style={{
            position: "absolute", top: 10, right: 10, zIndex: 7,
            ...ghostBtn(), background: "rgba(11,18,32,0.85)",
          }}
        >
          Exit Full Screen (Esc)
        </button>
      )}
    </div>
  );

  const actionBar = (
    <div style={{
      display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", flexShrink: 0, flexWrap: "wrap",
      minWidth: 0, borderTop: "1px solid var(--orvyn-border-soft)",
    }}>
      <span style={{ display: "inline-flex", alignItems: "flex-start", gap: 8 }}>
        <span style={{ marginTop: 5 }}><Dot color="#34d399" /></span>
        <span>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--orvyn-text)" }}>Desktop is running</div>
          <div style={{ fontSize: 10.5, color: "var(--orvyn-text-muted)" }}>{resourceLine}</div>
        </span>
      </span>
      <span style={{ flex: 1 }} />
      <div style={{ position: "relative" }} onMouseDown={(e) => e.stopPropagation()}>
        <button style={ghostBtn()} onClick={() => setOpenMenu(openMenu === "sendkeys" ? null : "sendkeys")}>
          Send Keys ⌄
        </button>
        {openMenu === "sendkeys" && (
          <div style={menuStyle(true)}>
            {SEND_KEYS.map((k) => (
              <MenuItem key={k.combo} label={k.label} onClick={() => void sendKeys(k.combo)} />
            ))}
            <MenuItem label="Custom…" onClick={() => {
              const c = window.prompt("Key combo (e.g. ctrl+shift+t)");
              if (c) void sendKeys(c);
            }} />
          </div>
        )}
      </div>
      <button style={ghostBtn()} onClick={() => void screenshot()}>Screenshot</button>
      <button style={ghostBtn()} onClick={() => setFullscreen(true)}>Full Screen</button>
      <div style={{ position: "relative" }} onMouseDown={(e) => e.stopPropagation()}>
        <button style={ghostBtn()} onClick={() => setOpenMenu(openMenu === "more" ? null : "more")}>More ⌄</button>
        {openMenu === "more" && (
          <div style={menuStyle(true)}>
            <MenuItem label="Restart desktop" onClick={() => void restart()} />
            <MenuItem label="Reconnect" onClick={() => void reconnect()} />
            <div style={{ height: 1, background: "var(--orvyn-border-soft)", margin: "4px 0" }} />
            {(["low", "auto", "high"] as const).map((qq) => (
              <MenuItem key={qq} label={`${quality === qq ? "● " : "   "}Quality: ${qq[0].toUpperCase()}${qq.slice(1)}`} onClick={() => { setQuality(qq); setOpenMenu(null); }} />
            ))}
            <div style={{ height: 1, background: "var(--orvyn-border-soft)", margin: "4px 0" }} />
            <MenuItem label="Session details" onClick={() => { setOpenMenu(null); setDetailsOpen(true); }} />
            <MenuItem label="Stop Desktop" danger onClick={() => void endSession()} />
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div style={expanded ? {
      position: "fixed" as const,
      inset: 0,
      zIndex: 1000,
      background: "#070b14",
      display: "flex",
      flexDirection: "column" as const,
    } : { flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", background: "#070b14", overflow: "hidden" }}>
      {!fullscreen && header}
      <div style={fullscreen
        ? { position: "fixed", inset: 0, zIndex: 50, display: "flex", flexDirection: "column", background: "#04060f" }
        : { flex: 1, minHeight: 0, padding: "0 12px", display: "flex", flexDirection: "column" }}>
        <div style={{
          flex: 1, minHeight: 0, display: "flex", flexDirection: "column",
          border: fullscreen ? "none" : "1px solid var(--orvyn-border-soft)",
          borderRadius: fullscreen ? 0 : 12, overflow: "hidden",
          background: "#04060f",
        }}>
          {viewport}
        </div>
      </div>
      {!fullscreen && actionBar}
      {toast && (
        <div style={{
          position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", zIndex: 60,
          background: "rgba(11,18,32,0.92)", border: "1px solid var(--orvyn-border)",
          color: "var(--orvyn-text)", fontSize: 11.5, borderRadius: 8, padding: "7px 14px",
        }}>
          {toast}
        </div>
      )}
      {detailsOpen && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 55, background: "rgba(4,7,15,0.6)", display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => setDetailsOpen(false)}
        >
          <div
            style={{ minWidth: 300, background: "#0b1220", border: "1px solid var(--orvyn-border)", borderRadius: 12, padding: 18 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: 13, fontWeight: 650, color: "var(--orvyn-text)", marginBottom: 12 }}>Desktop session</div>
            {[
              ["Status", statusLabel],
              ["Resolution", `${session.width} × ${session.height}`],
              ["Resources", resourceLine],
              ["Transport", session.transport ?? "sandbox-x11"],
              ["Control", session.controlOwner],
              ["Started", session.startedAt ? new Date(session.startedAt).toLocaleString() : "—"],
            ].map(([k, v]) => (
              <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 24, fontSize: 11.5, padding: "3px 0" }}>
                <span style={{ color: "var(--orvyn-text-muted)" }}>{k}</span>
                <span style={{ color: "var(--orvyn-text)" }}>{v}</span>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
              <button style={ghostBtn()} onClick={() => setDetailsOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
      {error && <div style={{ padding: "6px 12px", color: "var(--orvyn-yellow)", fontSize: 11 }}>{error}</div>}
    </div>
  );
}

function menuStyle(up = false): React.CSSProperties {
  return {
    position: "absolute",
    right: 0,
    ...(up ? { bottom: "calc(100% + 6px)" } : { top: "calc(100% + 6px)" }),
    minWidth: 170,
    background: "#0c1426",
    border: "1px solid var(--orvyn-border)",
    borderRadius: 9,
    padding: 4,
    zIndex: 40,
    boxShadow: "0 8px 28px rgba(0,0,0,0.5)",
  };
}

function MenuItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "block", width: "100%", textAlign: "left",
        background: "transparent", border: "none", borderRadius: 6,
        color: danger ? "#f87171" : "var(--orvyn-text-secondary)",
        fontSize: 11.5, padding: "6px 10px", cursor: "pointer",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.05)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      {label}
    </button>
  );
}
