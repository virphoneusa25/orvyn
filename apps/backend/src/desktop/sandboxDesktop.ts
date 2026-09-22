// apps/backend/src/desktop/sandboxDesktop.ts
//
// Container-backed sandbox desktop — a TRUE visual desktop (Xvfb + openbox
// + tint2 panel/dock + Thunar + Chromium + terminal + editor + feh ORVYN
// wallpaper). The container runs on the local Docker daemon or the OVH
// worker; the control plane captures frames via `docker exec import` and
// injects input via `docker exec xdotool`.
//
// Security: cap-drop ALL, no-new-privileges, resource limits. Only the
// project workspace is mounted (at /workspace, read-only). Network policy
// is configurable via ORVYN_DESKTOP_NETWORK (default "bridge" so the
// in-sandbox Chromium can actually browse; set to "none" for full
// isolation).

import { spawn, exec } from "child_process";
import { randomUUID } from "crypto";

export type SandboxControlOwner = "orion" | "user" | "none";

export interface SandboxResources {
  os: string;
  vcpus: number;
  memoryMb: number;
}

export interface SandboxDesktopSession {
  id: string;
  containerId: string;
  containerName: string;
  tenantId: string;
  projectRoot?: string;
  runId?: string;
  status: "starting" | "ready" | "user_control" | "ended" | "error";
  controlOwner: SandboxControlOwner;
  width: number;
  height: number;
  url?: string;
  resources: SandboxResources;
  createdAt: number;
  startedAt?: string;
  lastFrameAt: number;
  error?: string;
}

const sessions = new Map<string, SandboxDesktopSession>();

let dockerProbe: boolean | null = null;
/** One-shot probe: is a Docker daemon reachable from this backend? */
export async function dockerAvailable(): Promise<boolean> {
  if (dockerProbe !== null) return dockerProbe;
  dockerProbe = await new Promise<boolean>((resolve) => {
    const p = spawn("docker", ["version", "--format", "{{.Server.Version}}"], { windowsHide: true });
    p.on("close", (code) => resolve(code === 0));
    p.on("error", () => resolve(false));
  });
  return dockerProbe;
}

// Configured resource limits — these are the ACTUAL docker run values, so
// the UI can truthfully display "Linux · 2 vCPU · 4 GB RAM".
const DESKTOP_CPUS = Math.max(1, Number(process.env.ORVYN_DESKTOP_CPUS) || 2);
const DESKTOP_MEMORY_MB = Math.max(512, Number(process.env.ORVYN_DESKTOP_MEMORY_MB) || 4096);
const DESKTOP_IMAGE = process.env.ORVYN_DESKTOP_IMAGE || "orvyn-desktop:latest";
const DESKTOP_NETWORK = process.env.ORVYN_DESKTOP_NETWORK ?? "bridge";

function dockerExec(containerId: string, args: string[], binary = false): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn("docker", ["exec", containerId, ...args], { windowsHide: true });
    const chunks: Buffer[] = [];
    let stderr = "";
    p.stdout.on("data", (d: Buffer) => chunks.push(d));
    p.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    p.on("close", (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(chunks), stderr }));
    p.on("error", () => resolve({ code: -1, stdout: Buffer.alloc(0), stderr: "docker not found" }));
  });
}

export async function startSandboxDesktop(opts: {
  tenantId: string;
  projectRoot?: string;
  runId?: string;
  url?: string;
  width?: number;
  height?: number;
}): Promise<SandboxDesktopSession> {
  const id = `desk_${randomUUID().slice(0, 12)}`;
  const containerName = `orvyn-desktop-${id.slice(5)}`;
  const width = opts.width ?? 1280;
  const height = opts.height ?? 720;

  const session: SandboxDesktopSession = {
    id,
    containerId: "",
    containerName,
    tenantId: opts.tenantId,
    projectRoot: opts.projectRoot,
    runId: opts.runId,
    status: "starting",
    controlOwner: "orion",
    width,
    height,
    url: opts.url,
    resources: { os: "Linux", vcpus: DESKTOP_CPUS, memoryMb: DESKTOP_MEMORY_MB },
    createdAt: Date.now(),
    lastFrameAt: 0,
  };

  const args = [
    "run", "-d",
    "--name", containerName,
    "-e", `SCREEN_WIDTH=${width}`,
    "-e", `SCREEN_HEIGHT=${height}`,
    ...(opts.url ? ["-e", `START_URL=${opts.url}`] : []),
    "--network", DESKTOP_NETWORK,
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--memory", `${DESKTOP_MEMORY_MB}m`,
    "--cpus", String(DESKTOP_CPUS),
    "--pids-limit", "512",
    "--shm-size", "512m",
    "-l", `orvyn.desktop.id=${id}`,
    "-l", `orvyn.desktop.tenant=${opts.tenantId}`,
    // The synced project snapshot is the sandbox's /workspace (read-only —
    // ORION edits go through tools, the desktop is a visual surface).
    ...(opts.projectRoot ? ["-v", `${opts.projectRoot}:/workspace:ro`] : []),
    DESKTOP_IMAGE,
  ];

  const containerId = await new Promise<string>((resolve, reject) => {
    const p = spawn("docker", args, { windowsHide: true });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (code) => {
      if (code === 0 && stdout.trim()) resolve(stdout.trim());
      else reject(new Error(`docker run failed: ${stderr.slice(0, 200)}`));
    });
    p.on("error", () => reject(new Error("docker not available")));
  });

  session.containerId = containerId;

  // Wait for the desktop to be ready (entrypoint starts Xvfb + openbox + panel).
  const ready = await new Promise<boolean>((resolve) => {
    let tries = 0;
    const check = async () => {
      tries++;
      const r = await dockerExec(containerId, ["xdotool", "getdisplaygeometry"]);
      if (r.code === 0 && r.stdout.toString().trim()) {
        resolve(true);
      } else if (tries < 30) {
        setTimeout(check, 1000);
      } else {
        resolve(false);
      }
    };
    setTimeout(check, 2000);
  });

  if (!ready) {
    session.status = "error";
    session.error = "Desktop container failed to become ready within 30s.";
    void dockerExec(containerId, ["true"]).then(() => {
      exec(`docker rm -f ${containerId}`, { windowsHide: true });
    });
    sessions.set(id, session);
    return session;
  }

  session.status = "ready";
  session.startedAt = new Date().toISOString();
  sessions.set(id, session);
  return session;
}

export type FrameQuality = "low" | "auto" | "high";

function qualityArgs(quality: FrameQuality): string[] {
  switch (quality) {
    case "low": return ["-resize", "55%", "-quality", "45"];
    case "high": return ["-quality", "92"];
    default: return ["-quality", "72"];
  }
}

export async function captureSandboxFrame(
  session: SandboxDesktopSession,
  quality: FrameQuality = "auto",
): Promise<Buffer | null> {
  if (session.status !== "ready" && session.status !== "user_control") return null;
  const r = await dockerExec(session.containerId, [
    "import", "-window", "root", ...qualityArgs(quality), "jpeg:-",
  ], true);
  if (r.code === 0 && r.stdout.length > 100 && r.stdout[0] === 0xff) {
    session.lastFrameAt = Date.now();
    return r.stdout; // raw JPEG bytes, binary-safe
  }
  return null;
}

/** Full-resolution PNG screenshot — for artifact/evidence capture. */
export async function captureSandboxScreenshot(session: SandboxDesktopSession): Promise<Buffer | null> {
  if (session.status !== "ready" && session.status !== "user_control") return null;
  const r = await dockerExec(session.containerId, ["import", "-window", "root", "png:-"], true);
  if (r.code === 0 && r.stdout.length > 100 && r.stdout[0] === 0x89) {
    return r.stdout;
  }
  return null;
}

// ── Input ─────────────────────────────────────────────────────────────────

export interface DesktopPoint { x: number; y: number }

/** Letterbox-aware mapping: client coords relative to the DISPLAYED image
 *  rect (already un-letterboxed by the UI) scaled to remote resolution. */
export function mapSandboxPoint(
  session: Pick<SandboxDesktopSession, "width" | "height">,
  x: number, y: number, viewW: number, viewH: number,
): DesktopPoint {
  const sx = viewW > 0 ? session.width / viewW : 1;
  const sy = viewH > 0 ? session.height / viewH : 1;
  return {
    x: Math.max(0, Math.min(session.width - 1, Math.round(x * sx))),
    y: Math.max(0, Math.min(session.height - 1, Math.round(y * sy))),
  };
}

const NAMED_KEYS: Record<string, string> = {
  "ctrl+alt+del": "ctrl+alt+Delete",
  "ctrlaltdel": "ctrl+alt+Delete",
  "ctrl+c": "ctrl+c",
  "ctrl+v": "ctrl+v",
  "ctrl+x": "ctrl+x",
  "alt+tab": "alt+Tab",
  "alt+f4": "alt+F4",
  "esc": "Escape",
  "escape": "Escape",
  "enter": "Return",
  "tab": "Tab",
  "super": "Super_L",
  "f5": "F5",
  "f11": "F11",
};

/** Maps a Send-Keys combo name to xdotool key syntax. Returns null if unknown. */
export function resolveKeyCombo(combo: string): string | null {
  const key = NAMED_KEYS[String(combo ?? "").trim().toLowerCase()];
  if (key) return key;
  // Custom combos: accept xdotool-style "ctrl+shift+t" / single keys.
  const custom = String(combo ?? "").trim();
  if (/^[a-z0-9+_ -]+$/i.test(custom) && custom.length <= 40) return custom;
  return null;
}

export async function sandboxSendKeys(session: SandboxDesktopSession, combo: string): Promise<boolean> {
  const seq = resolveKeyCombo(combo);
  if (!seq) return false;
  const r = await dockerExec(session.containerId, ["xdotool", "key", "--clearmodifiers", seq]);
  return r.code === 0;
}

export async function sandboxInput(
  session: SandboxDesktopSession,
  type: string,
  args: Record<string, unknown>,
): Promise<boolean> {
  if (session.controlOwner !== "user") return false;
  return sandboxAct(session, type, args);
}

/** ORION-side input: same desktop, gated on ORION ownership (never during
 *  user control — input is exclusive). Used by ORION desktop_* tools. */
export async function sandboxAgentInput(
  session: SandboxDesktopSession,
  type: string,
  args: Record<string, unknown>,
): Promise<boolean> {
  if (session.controlOwner !== "orion") return false;
  if (session.status !== "ready") return false;
  return sandboxAct(session, type, args);
}

async function sandboxAct(
  session: SandboxDesktopSession,
  type: string,
  args: Record<string, unknown>,
): Promise<boolean> {
  const viewW = Number(args.viewWidth ?? session.width);
  const viewH = Number(args.viewHeight ?? session.height);
  const { x, y } = mapSandboxPoint(session, Number(args.x ?? 0), Number(args.y ?? 0), viewW, viewH);

  let cmd: string[] = [];
  switch (type) {
    case "move":
      cmd = ["xdotool", "mousemove", String(x), String(y)];
      break;
    case "click":
      cmd = ["xdotool", "mousemove", String(x), String(y), "click", "1"];
      break;
    case "rightclick":
      cmd = ["xdotool", "mousemove", String(x), String(y), "click", "3"];
      break;
    case "dblclick":
      cmd = ["xdotool", "mousemove", String(x), String(y), "click", "--repeat", "2", "--delay", "100", "1"];
      break;
    case "scroll": {
      const deltaY = Number(args.deltaY ?? 0);
      const button = deltaY > 0 ? "5" : "4";
      const times = Math.min(5, Math.abs(Math.round(deltaY / 100)) || 1);
      cmd = ["xdotool", "mousemove", String(x), String(y), "click", "--repeat", String(times), "--delay", "50", button];
      break;
    }
    case "key": {
      const key = String(args.key ?? "");
      const mapped = key === "Enter" ? "Return" : key === " " ? "space" : key === "Escape" ? "Escape" : key;
      cmd = ["xdotool", "key", "--clearmodifiers", mapped];
      break;
    }
    case "type": {
      const text = String(args.text ?? "");
      if (text) cmd = ["xdotool", "type", "--delay", "30", "--clearmodifiers", text];
      break;
    }
    default:
      return false;
  }
  if (!cmd.length) return true;
  const r = await dockerExec(session.containerId, cmd);
  return r.code === 0;
}

/** Launch one of the dock apps inside the live desktop (ORION or control
 *  plane initiated). */
export async function sandboxLaunchApp(
  session: SandboxDesktopSession,
  app: "terminal" | "files" | "chromium" | "editor" | "settings",
): Promise<boolean> {
  const cmds: Record<string, string[]> = {
    terminal: ["lxterminal", "--working-directory=/workspace"],
    files: ["thunar", "/workspace"],
    chromium: ["chromium", "--no-sandbox", "--disable-dev-shm-usage", "--start-maximized"],
    editor: ["geany", "/workspace"],
    settings: ["lxappearance"],
  };
  const cmd = cmds[app];
  if (!cmd) return false;
  const r = await dockerExec(session.containerId, ["sh", "-c", `nohup ${cmd.join(" ")} >/dev/null 2>&1 &`]);
  return r.code === 0;
}

export async function sandboxNavigate(session: SandboxDesktopSession, url: string): Promise<boolean> {
  if (session.status !== "ready") return false;
  // Launch Chromium at the URL (it may not be running yet in the new layout).
  const running = await dockerExec(session.containerId, ["sh", "-c", "xdotool search --name 'Chromium' | head -1"]);
  if (!running.stdout.toString().trim()) {
    await dockerExec(session.containerId, ["sh", "-c", `nohup chromium --no-sandbox --disable-dev-shm-usage --start-maximized >/dev/null 2>&1 &`]);
    await new Promise((res) => setTimeout(res, 2500));
  }
  const r = await dockerExec(session.containerId, [
    "xdotool", "search", "--name", "Chromium", "windowactivate", "--sync",
    "key", "--clearmodifiers", "ctrl+l",
  ]);
  await new Promise((res) => setTimeout(res, 200));
  await dockerExec(session.containerId, ["xdotool", "type", "--delay", "20", "--clearmodifiers", url]);
  await new Promise((res) => setTimeout(res, 200));
  await dockerExec(session.containerId, ["xdotool", "key", "Return"]);
  session.url = url;
  return r.code === 0;
}

export function getSandboxSession(id: string): SandboxDesktopSession | undefined {
  return sessions.get(id);
}

export function findSandboxSession(tenantId: string, projectRoot?: string): SandboxDesktopSession | undefined {
  for (const s of sessions.values()) {
    if (s.tenantId === tenantId && s.status !== "ended" && (!projectRoot || s.projectRoot === projectRoot)) return s;
  }
  return undefined;
}

export async function stopSandboxDesktop(session: SandboxDesktopSession): Promise<void> {
  session.status = "ended";
  session.controlOwner = "none";
  exec(`docker rm -f ${session.containerId}`, { windowsHide: true }, () => {
    sessions.delete(session.id);
  });
}

/** Restart: kill the container, start a fresh one with the same options. */
export async function restartSandboxDesktop(session: SandboxDesktopSession): Promise<SandboxDesktopSession> {
  const opts = {
    tenantId: session.tenantId,
    projectRoot: session.projectRoot,
    runId: session.runId,
    url: session.url,
    width: session.width,
    height: session.height,
  };
  await stopSandboxDesktop(session);
  // Give docker a moment to release the name.
  await new Promise((r) => setTimeout(r, 800));
  return startSandboxDesktop(opts);
}

export function listSandboxSessions(tenantId: string): SandboxDesktopSession[] {
  return [...sessions.values()].filter((s) => s.tenantId === tenantId && s.status !== "ended");
}

export function resetSandboxSessionsForTests(): void {
  sessions.clear();
}
