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
import { createHash, randomUUID } from "crypto";

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
  if (dockerProbe) void removeOrphanDesktops();
  return dockerProbe;
}

/**
 * Which backend started a desktop container. Staging and production share
 * one Docker host, so each only cleans up its own containers.
 */
export const DESKTOP_OWNER = process.env.ORVYN_DESKTOP_OWNER || process.env.ORVYN_ENV || "production";

/** Sessions live in memory. After a restart or deploy, containers this
 *  backend started earlier are unreachable: nobody can see or stop them, yet
 *  each keeps a browser and a frame loop running and slows every other
 *  desktop on the host. Remove them once, at startup. Containers from before
 *  the owner label existed are treated as ours. */
export function orphanDesktopIds(rows: string, owner: string): string[] {
  return rows
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => { const [id, labelOwner = ""] = l.split("\t"); return { id, labelOwner: labelOwner.trim() }; })
    .filter((r) => r.id && (r.labelOwner === "" || r.labelOwner === "<no value>" || r.labelOwner === owner))
    .map((r) => r.id);
}

let orphansRemoved = false;
async function removeOrphanDesktops(): Promise<void> {
  if (orphansRemoved) return;
  orphansRemoved = true;
  const rows = await new Promise<string>((resolve) => {
    // Arguments as an array: no shell quoting around the Go template.
    const p = spawn("docker", ["ps", "-a", "--filter", "label=orvyn.desktop.id", "--format", '{{.ID}}\t{{.Label "orvyn.desktop.owner"}}'], { windowsHide: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) => resolve(code === 0 ? out : ""));
    p.on("error", () => resolve(""));
  });
  const known = new Set([...sessions.values()].map((s) => s.containerId.slice(0, 12)));
  const ids = orphanDesktopIds(rows, DESKTOP_OWNER).filter((id) => !known.has(id.slice(0, 12)));
  if (!ids.length) return;
  console.log(`[desktop] removing ${ids.length} desktop container(s) left from a previous backend run`);
  spawn("docker", ["rm", "-f", ...ids], { windowsHide: true, stdio: "ignore" }).on("error", () => undefined);
}

// Configured resource limits — these are the ACTUAL docker run values, so
// the UI can truthfully display "Linux · 2 vCPU · 4 GB RAM".
const DESKTOP_CPUS = Math.max(1, Number(process.env.ORVYN_DESKTOP_CPUS) || 2);
const DESKTOP_MEMORY_MB = Math.max(512, Number(process.env.ORVYN_DESKTOP_MEMORY_MB) || 4096);
const DESKTOP_IMAGE = process.env.ORVYN_DESKTOP_IMAGE || "orvyn-desktop:latest";
const DESKTOP_NETWORK = process.env.ORVYN_DESKTOP_NETWORK ?? "bridge";

function dockerExec(containerId: string, args: string[], timeoutMs = 20000): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (result: { code: number; stdout: Buffer; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const p = spawn("docker", ["exec", containerId, ...args], { windowsHide: true });
    const chunks: Buffer[] = [];
    let stderr = "";
    timer = setTimeout(() => {
      p.kill("SIGKILL");
      finish({ code: -1, stdout: Buffer.concat(chunks), stderr: "timed out" });
    }, timeoutMs);
    p.stdout.on("data", (d: Buffer) => chunks.push(d));
    p.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    p.on("close", (code) => finish({ code: code ?? 1, stdout: Buffer.concat(chunks), stderr }));
    p.on("error", () => finish({ code: -1, stdout: Buffer.alloc(0), stderr: "docker not found" }));
  });
}

/** JPEG payload, even when ImageMagick prints a warning ahead of the bytes. */
export function jpegFromOutput(buf: Buffer): Buffer | null {
  const start = buf.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
  if (start < 0 || buf.length - start < 100) return null;
  return start === 0 ? buf : buf.subarray(start);
}

export function pngFromOutput(buf: Buffer): Buffer | null {
  const start = buf.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (start < 0 || buf.length - start < 100) return null;
  return start === 0 ? buf : buf.subarray(start);
}

/**
 * Grab the X root window and encode JPEG on stdout.
 * `import -window root` waits for a mouse click when it cannot grab the
 * root window, so the Desktop pane stays on "Connecting…" forever.
 * `xwd -root -silent` either returns the framebuffer or fails immediately.
 */
export function frameCaptureCommand(quality: FrameQuality): string {
  const q = quality === "low" ? 45 : quality === "high" ? 92 : 72;
  const resize = quality === "low" ? "-resize 55% " : "";
  return `xwd -root -silent | convert ${resize}-quality ${q} xwd:- jpeg:-`;
}

/** The desktop image refreshes this file in the background. */
export const CACHED_FRAME_PATH = "/tmp/orvyn-frame.jpg";
/** Touched by the control plane while someone polls for frames. */
export const FRAME_WANT_PATH = "/tmp/orvyn-frame.want";

export function usesCachedFrame(quality: FrameQuality): boolean {
  return quality !== "high";
}

/** Serve a frame we already read instead of starting another docker exec. */
export const MEMORY_FRAME_MS = 200;

export function memoryFrameIsFresh(at: number, now: number, bytes: number): boolean {
  return bytes > 1000 && now - at < MEMORY_FRAME_MS;
}

interface MemoryFrame {
  jpeg: Buffer;
  at: number;
  pending?: Promise<Buffer | null>;
}

const memoryFrames = new Map<string, MemoryFrame>();

function dropMemoryFrame(id: string): void {
  memoryFrames.delete(id);
}

const startsInFlight = new Map<string, Promise<SandboxDesktopSession>>();

/**
 * One desktop per tenant. The Desktop pane, desktop_start and
 * computer_open_app can all ask at once; they share the session that is
 * already running or starting instead of each creating a container.
 */
export async function startSandboxDesktop(opts: {
  tenantId: string;
  projectRoot?: string;
  runId?: string;
  url?: string;
  width?: number;
  height?: number;
}): Promise<SandboxDesktopSession> {
  const existing = findSandboxSession(opts.tenantId);
  if (existing && existing.status !== "error") return existing;
  const pending = startsInFlight.get(opts.tenantId);
  if (pending) return pending;
  const job = createSandboxDesktop(opts).finally(() => startsInFlight.delete(opts.tenantId));
  startsInFlight.set(opts.tenantId, job);
  return job;
}

async function createSandboxDesktop(opts: {
  tenantId: string;
  projectRoot?: string;
  runId?: string;
  url?: string;
  width?: number;
  height?: number;
}): Promise<SandboxDesktopSession> {
  const stale = findSandboxSession(opts.tenantId);
  if (stale?.status === "error") sessions.delete(stale.id);
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
    "-l", `orvyn.desktop.owner=${DESKTOP_OWNER}`,
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
  openInputPipe(session);
  startDesktopIdleReaper();
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

const frameInFlight = new Map<string, Promise<Buffer | null>>();

async function pullContainerFrame(session: SandboxDesktopSession): Promise<Buffer | null> {
  // Touching the want-file keeps the in-desktop frame loop running; with
  // nobody watching it stops using CPU.
  const cached = await dockerExec(session.containerId, ["sh", "-c", `touch ${FRAME_WANT_PATH}; timeout 2 cat ${CACHED_FRAME_PATH}`], 3000);
  const ready = jpegFromOutput(cached.stdout);
  const slot = memoryFrames.get(session.id) ?? { jpeg: Buffer.alloc(0), at: 0 };
  if (ready && ready.length > 1000) {
    slot.jpeg = ready;
    slot.at = Date.now();
    memoryFrames.set(session.id, slot);
    return ready;
  }
  return null;
}

function scheduleContainerFrame(session: SandboxDesktopSession): Promise<Buffer | null> {
  const hit = memoryFrames.get(session.id);
  if (hit?.pending) return hit.pending;
  const pending = pullContainerFrame(session).finally(() => {
    const cur = memoryFrames.get(session.id);
    if (cur?.pending === pending) cur.pending = undefined;
  });
  const slot = hit ?? { jpeg: Buffer.alloc(0), at: 0 };
  slot.pending = pending;
  memoryFrames.set(session.id, slot);
  return pending;
}

async function grabFrame(session: SandboxDesktopSession, quality: FrameQuality): Promise<Buffer | null> {
  const live = frameStreams.get(session.id);
  const slotNow = memoryFrames.get(session.id);
  if (live && !live.ended && slotNow && Date.now() - slotNow.at < 1500 && slotNow.jpeg.length > 1000) {
    // The live stream already has this second's picture.
    if (quality !== "high" || Date.now() - slotNow.at < 400) return slotNow.jpeg;
  }
  if (usesCachedFrame(quality)) {
    const hit = memoryFrames.get(session.id);
    if (hit && memoryFrameIsFresh(hit.at, Date.now(), hit.jpeg.length)) return hit.jpeg;
    if (hit && hit.jpeg.length > 1000) {
      void scheduleContainerFrame(session);
      return hit.jpeg;
    }
    const ready = await scheduleContainerFrame(session);
    if (ready && ready.length > 1000) return ready;
  }
  const viaXwd = await dockerExec(
    session.containerId,
    ["timeout", "6", "sh", "-c", frameCaptureCommand(quality)],
    8000,
  );
  const jpeg = jpegFromOutput(viaXwd.stdout);
  if (jpeg) return jpeg;
  // Older desktop images may not have xwd. import is wrapped in timeout so
  // a window-select hang cannot pin the HTTP request.
  const viaImport = await dockerExec(
    session.containerId,
    ["timeout", "5", "import", "-silent", "-window", "root", ...qualityArgs(quality), "jpeg:-"],
    7000,
  );
  return jpegFromOutput(viaImport.stdout);
}

export async function captureSandboxFrame(
  session: SandboxDesktopSession,
  quality: FrameQuality = "auto",
): Promise<Buffer | null> {
  if (session.status !== "ready" && session.status !== "user_control") return null;
  // The pane polls faster than a capture finishes. Share one grab so a
  // disconnected client does not stack docker execs and slow the next frame.
  let job = frameInFlight.get(session.id);
  if (!job) {
    job = grabFrame(session, quality).finally(() => frameInFlight.delete(session.id));
    frameInFlight.set(session.id, job);
  }
  const jpeg = await job;
  if (!jpeg) return null;
  session.lastFrameAt = Date.now();
  noteDesktopUse(session.id, session.lastFrameAt);
  return jpeg;
}

/** Full-resolution PNG screenshot — for artifact/evidence capture. */
export async function captureSandboxScreenshot(session: SandboxDesktopSession): Promise<Buffer | null> {
  if (session.status !== "ready" && session.status !== "user_control") return null;
  const viaXwd = await dockerExec(
    session.containerId,
    ["timeout", "4", "sh", "-c", "xwd -root -silent | convert xwd:- png:-"],
    6000,
  );
  const png = pngFromOutput(viaXwd.stdout) ?? pngFromOutput(
    (await dockerExec(session.containerId, ["timeout", "4", "import", "-silent", "-window", "root", "png:-"], 6000)).stdout,
  );
  return png;
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

/** One line for the in-desktop `orvyn-input` reader. Coordinates are already remote pixels. */
export function formatDesktopCommand(
  type: string,
  x: number,
  y: number,
  extra: { key?: string; text?: string; deltaY?: number } = {},
): string | null {
  const xi = Math.max(0, Math.round(x));
  const yi = Math.max(0, Math.round(y));
  switch (type) {
    case "move":
      return `MOVE ${xi} ${yi}`;
    case "click":
      return `CLICK ${xi} ${yi} 1`;
    case "rightclick":
      return `CLICK ${xi} ${yi} 3`;
    case "dblclick":
      return `DCLICK ${xi} ${yi}`;
    case "scroll": {
      const button = Number(extra.deltaY ?? 0) > 0 ? 5 : 4;
      const times = Math.min(5, Math.abs(Math.round(Number(extra.deltaY ?? 0) / 100)) || 1);
      return `SCROLL ${xi} ${yi} ${button} ${times}`;
    }
    case "key": {
      const raw = extra.key === "Enter" ? "Return" : extra.key === " " ? "space" : extra.key === "Escape" ? "Escape" : String(extra.key ?? "");
      if (!/^[\w+]+$/.test(raw)) return null;
      return `KEY ${raw}`;
    }
    case "type": {
      const text = String(extra.text ?? "");
      if (!text) return null;
      return `TYPE ${Buffer.from(text, "utf8").toString("base64")}`;
    }
    default:
      return null;
  }
}

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

interface InputPipe {
  proc: ReturnType<typeof spawn>;
  dead: boolean;
}

const inputPipes = new Map<string, InputPipe>();
const inputMode = new Map<string, "pipe" | "exec">();

function dropInputPipe(id: string): void {
  inputMode.delete(id);
  const pipe = inputPipes.get(id);
  inputPipes.delete(id);
  if (pipe && !pipe.proc.killed) pipe.proc.kill();
}

function openInputPipe(session: SandboxDesktopSession): void {
  if (!session.containerId) return;
  const existing = inputPipes.get(session.id);
  if (existing && !existing.dead) return;
  const proc = spawn("docker", ["exec", "-i", session.containerId, "/usr/local/bin/orvyn-input"], {
    windowsHide: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
  const pipe: InputPipe = { proc, dead: false };
  inputPipes.set(session.id, pipe);
  inputMode.set(session.id, "pipe");
  const markDead = () => {
    pipe.dead = true;
    if (inputPipes.get(session.id)?.proc === proc) inputMode.set(session.id, "exec");
  };
  proc.on("error", markDead);
  proc.on("exit", markDead);
}

async function desktopInputMode(session: SandboxDesktopSession): Promise<"pipe" | "exec"> {
  const known = inputMode.get(session.id);
  if (known) return known;
  const probe = await dockerExec(session.containerId, ["test", "-x", "/usr/local/bin/orvyn-input"], 4000);
  const mode = probe.code === 0 ? "pipe" : "exec";
  inputMode.set(session.id, mode);
  return mode;
}

function writeInputLine(session: SandboxDesktopSession, line: string): boolean {
  let pipe = inputPipes.get(session.id);
  if (!pipe || pipe.dead) openInputPipe(session);
  pipe = inputPipes.get(session.id);
  const stdin = pipe?.proc.stdin;
  if (!pipe || pipe.dead || !stdin || stdin.destroyed) return false;
  // A false return means the buffer is full. The line is still queued.
  stdin.write(`${line}\n`);
  return true;
}

async function sandboxAct(
  session: SandboxDesktopSession,
  type: string,
  args: Record<string, unknown>,
): Promise<boolean> {
  noteDesktopUse(session.id);
  const viewW = Number(args.viewWidth ?? session.width);
  const viewH = Number(args.viewHeight ?? session.height);
  const { x, y } = mapSandboxPoint(session, Number(args.x ?? 0), Number(args.y ?? 0), viewW, viewH);
  const line = formatDesktopCommand(type, x, y, {
    key: args.key == null ? undefined : String(args.key),
    text: args.text == null ? undefined : String(args.text),
    deltaY: Number(args.deltaY ?? 0),
  });
  if (line == null) return type === "type" ? true : false;
  // Pointer-move spam was queued ahead of clicks, so Take Control felt frozen.
  // Clicks already carry the coordinates. Do not send a move for every pixel.
  if (type === "move") return true;

  if ((await desktopInputMode(session)) === "pipe" && writeInputLine(session, line)) return true;

  let cmd: string[] = [];
  switch (type) {
    case "move":
      return true;
    case "click":
      cmd = ["xdotool", "mousemove", String(x), String(y), "click", "1"];
      break;
    case "rightclick":
      cmd = ["xdotool", "mousemove", String(x), String(y), "click", "3"];
      break;
    case "dblclick":
      cmd = ["xdotool", "mousemove", String(x), String(y), "click", "--repeat", "2", "--delay", "40", "1"];
      break;
    case "scroll": {
      const deltaY = Number(args.deltaY ?? 0);
      const button = deltaY > 0 ? "5" : "4";
      const times = Math.min(5, Math.abs(Math.round(deltaY / 100)) || 1);
      cmd = ["xdotool", "mousemove", String(x), String(y), "click", "--repeat", String(times), "--delay", "16", button];
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
      if (text) cmd = ["xdotool", "type", "--delay", "0", "--clearmodifiers", text];
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
    chromium: ["sh", "-c", "if command -v firefox-esr >/dev/null; then exec firefox-esr --new-window file:///usr/share/orvyn/home.html; fi; exec chromium --no-sandbox --disable-dev-shm-usage --start-maximized"],
    editor: ["sh", "-c", "if command -v code >/dev/null; then exec code --no-sandbox --disable-gpu /workspace; fi; exec geany /workspace"],
    settings: ["lxappearance"],
  };
  const cmd = cmds[app];
  if (!cmd) return false;
  noteDesktopUse(session.id);
  const r = await dockerExec(session.containerId, ["sh", "-c", `nohup ${cmd.join(" ")} >/dev/null 2>&1 &`]);
  return r.code === 0;
}

export async function sandboxNavigate(session: SandboxDesktopSession, url: string): Promise<boolean> {
  if (session.status !== "ready") return false;
  const titled = async (name: string) => (await dockerExec(session.containerId, ["sh", "-c", `xdotool search --name '${name}' | head -1`])).stdout.toString().trim();
  let title = (await titled("Firefox")) ? "Firefox" : (await titled("Chromium")) ? "Chromium" : "";
  if (!title) {
    await dockerExec(session.containerId, ["sh", "-c", "if command -v firefox-esr >/dev/null; then nohup firefox-esr --new-window >/dev/null 2>&1 &; else nohup chromium --no-sandbox --disable-dev-shm-usage --start-maximized >/dev/null 2>&1 &; fi"]);
    await new Promise((res) => setTimeout(res, 2500));
    title = (await titled("Firefox")) ? "Firefox" : "Chromium";
  }
  const r = await dockerExec(session.containerId, [
    "xdotool", "search", "--name", title, "windowactivate", "--sync",
    "key", "--clearmodifiers", "ctrl+l",
  ]);
  await new Promise((res) => setTimeout(res, 200));
  await dockerExec(session.containerId, ["xdotool", "type", "--delay", "20", "--clearmodifiers", url]);
  await new Promise((res) => setTimeout(res, 200));
  await dockerExec(session.containerId, ["xdotool", "key", "Return"]);
  session.url = url;
  return r.code === 0;
}

function runningDesktopContainer(): Promise<string | null> {
  return new Promise((resolve) => {
    exec("docker ps --filter name=orvyn-desktop --format {{.ID}}", { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const id = stdout.split("\n").map((l) => l.trim()).find(Boolean) ?? null;
      resolve(id);
    });
  });
}

/** Put the finished page on the sandbox desktop and open it in that desktop's browser. */
export async function openSiteOnDesktop(html: string): Promise<{ url: string } | null> {
  const containerId = await runningDesktopContainer();
  if (!containerId || !html.trim()) return null;
  const b64 = Buffer.from(html, "utf8").toString("base64");
  const setup = await dockerExec(containerId, ["sh", "-c", `mkdir -p /tmp/orvyn-site && printf %s '${b64}' | base64 -d > /tmp/orvyn-site/index.html`]);
  if (setup.code !== 0) return null;
  const url = "file:///tmp/orvyn-site/index.html";
  const session = [...sessions.values()].find((s) => s.containerId.startsWith(containerId) || containerId.startsWith(s.containerId));
  if (session && session.status === "ready") {
    await sandboxNavigate(session, url);
  } else {
    await dockerExec(containerId, ["sh", "-c", `nohup firefox-esr --new-window '${url}' >/dev/null 2>&1 &`]);
  }
  return { url };
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
  endFrameStream(session.id, "stopped");
  dropInputPipe(session.id);
  dropMemoryFrame(session.id);
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
  for (const id of inputPipes.keys()) dropInputPipe(id);
  for (const id of [...frameStreams.keys()]) endFrameStream(id, "stopped");
  streamUnsupported.clear();
  startsInFlight.clear();
  memoryFrames.clear();
  sessions.clear();
}

// ── Live picture stream ─────────────────────────────────────────────────────
//
// Polling a frame per HTTP request costs a docker exec plus a round trip per
// picture, which is what made the Desktop feel slow. Instead one ffmpeg in the
// desktop grabs the screen continuously (x11grab → MJPEG on stdout). The
// control plane splits that into JPEGs, keeps the newest one, and pushes only
// pictures that changed to every viewer. Images without ffmpeg fall back to
// the frame file / per-request capture above.

export const FRAME_STREAM_FPS = Math.max(2, Math.min(15, Number(process.env.ORVYN_DESKTOP_FPS) || 8));
/** Stop grabbing this long after the last viewer leaves. */
export const FRAME_STREAM_LINGER_MS = 15_000;

export function frameStreamCommand(width: number, height: number, fps = FRAME_STREAM_FPS): string[] {
  return [
    "sh", "-c",
    `command -v ffmpeg >/dev/null 2>&1 || exit 127; pkill -x ffmpeg 2>/dev/null; exec ffmpeg -loglevel error -nostdin -f x11grab -draw_mouse 1 -framerate ${fps} -video_size ${width}x${height} -i "\${DISPLAY:-:99}" -f mjpeg -q:v 5 -`,
  ];
}

/** Splits a concatenated MJPEG byte stream into whole JPEG images. */
export class JpegSplitter {
  private buf: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: Buffer[] = [];
    for (;;) {
      const start = this.buf.indexOf(SOI);
      if (start < 0) { this.buf = this.buf.subarray(Math.max(0, this.buf.length - 1)); break; }
      const end = this.buf.indexOf(EOI, start + 2);
      if (end < 0) {
        this.buf = this.buf.subarray(start);
        // A runaway buffer means the stream is not JPEG. Start over.
        if (this.buf.length > 16 * 1024 * 1024) this.buf = Buffer.alloc(0);
        break;
      }
      out.push(Buffer.from(this.buf.subarray(start, end + 2)));
      this.buf = this.buf.subarray(end + 2);
    }
    return out;
  }
}
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

export interface FrameSubscriber {
  frame(jpeg: Buffer): void;
  end(reason: "stopped" | "unsupported" | "failed"): void;
}

interface FrameStream {
  proc: ReturnType<typeof spawn> | null;
  subscribers: Set<FrameSubscriber>;
  lastHash: string;
  frames: number;
  startedAt: number;
  ended: boolean;
  linger?: ReturnType<typeof setTimeout>;
  restarts: number;
}

const frameStreams = new Map<string, FrameStream>();
/** Sessions whose desktop image has no ffmpeg: they keep using polling. */
const streamUnsupported = new Set<string>();

export function frameStreamSupported(session: SandboxDesktopSession): boolean {
  return !streamUnsupported.has(session.id);
}

/** Number of viewers currently receiving the live picture. */
export function frameStreamViewers(sessionId: string): number {
  return frameStreams.get(sessionId)?.subscribers.size ?? 0;
}

function spawnFrameGrabber(session: SandboxDesktopSession, stream: FrameStream): void {
  const proc = spawn("docker", ["exec", session.containerId, ...frameStreamCommand(session.width, session.height)], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  stream.proc = proc;
  stream.startedAt = Date.now();
  const splitter = new JpegSplitter();
  proc.stdout?.on("data", (chunk: Buffer) => {
    for (const jpeg of splitter.push(chunk)) {
      if (jpeg.length < 1000) continue;
      stream.frames++;
      const slot = memoryFrames.get(session.id) ?? { jpeg: Buffer.alloc(0), at: 0 };
      slot.jpeg = jpeg;
      slot.at = Date.now();
      memoryFrames.set(session.id, slot);
      session.lastFrameAt = slot.at;
      // Only pictures that changed go over the network.
      const hash = createHash("sha1").update(jpeg).digest("hex");
      if (hash === stream.lastHash) continue;
      stream.lastHash = hash;
      for (const sub of stream.subscribers) {
        try { sub.frame(jpeg); } catch { /* a closed viewer is removed on close */ }
      }
    }
  });
  proc.on("exit", (code) => {
    if (stream.proc !== proc) return;
    stream.proc = null;
    if (stream.ended) return;
    const quick = Date.now() - stream.startedAt < 4000;
    if (code === 127 || (quick && stream.frames === 0)) {
      streamUnsupported.add(session.id);
      endFrameStream(session.id, "unsupported");
      return;
    }
    const live = session.status === "ready" || session.status === "user_control";
    if (!live || stream.subscribers.size === 0 || stream.restarts >= 5) {
      endFrameStream(session.id, live ? "failed" : "stopped");
      return;
    }
    stream.restarts++;
    setTimeout(() => { if (!stream.ended && !stream.proc) spawnFrameGrabber(session, stream); }, 800);
  });
  proc.on("error", () => {
    if (stream.proc !== proc) return;
    stream.proc = null;
    endFrameStream(session.id, "failed");
  });
}

/**
 * Receive every changed desktop picture as it happens. Returns null when this
 * desktop cannot stream (no ffmpeg in the image) — the caller polls instead.
 */
export function subscribeFrames(session: SandboxDesktopSession, sub: FrameSubscriber): (() => void) | null {
  if (streamUnsupported.has(session.id)) return null;
  if (session.status !== "ready" && session.status !== "user_control") return null;
  let stream = frameStreams.get(session.id);
  if (!stream || stream.ended) {
    stream = { proc: null, subscribers: new Set(), lastHash: "", frames: 0, startedAt: Date.now(), ended: false, restarts: 0 };
    frameStreams.set(session.id, stream);
    spawnFrameGrabber(session, stream);
  }
  if (stream.linger) { clearTimeout(stream.linger); stream.linger = undefined; }
  stream.subscribers.add(sub);
  // A new viewer gets the current picture right away, even if nothing moves.
  const slot = memoryFrames.get(session.id);
  if (slot && slot.jpeg.length > 1000 && Date.now() - slot.at < 5000) sub.frame(slot.jpeg);
  const s = stream;
  return () => {
    s.subscribers.delete(sub);
    if (s.subscribers.size === 0 && !s.ended && !s.linger) {
      s.linger = setTimeout(() => {
        s.linger = undefined;
        if (s.subscribers.size === 0) endFrameStream(session.id, "stopped");
      }, FRAME_STREAM_LINGER_MS);
    }
  };
}

function endFrameStream(sessionId: string, reason: "stopped" | "unsupported" | "failed"): void {
  const stream = frameStreams.get(sessionId);
  if (!stream) return;
  frameStreams.delete(sessionId);
  stream.ended = true;
  if (stream.linger) clearTimeout(stream.linger);
  const proc = stream.proc;
  stream.proc = null;
  if (proc && !proc.killed) proc.kill();
  // Killing the docker exec client leaves ffmpeg running inside the desktop.
  const session = sessions.get(sessionId);
  if (session?.containerId && session.status !== "ended") {
    void dockerExec(session.containerId, ["pkill", "-x", "ffmpeg"], 4000);
  }
  for (const sub of stream.subscribers) {
    try { sub.end(reason); } catch { /* ignore */ }
  }
  stream.subscribers.clear();
}

// ── Idle desktops ──────────────────────────────────────────────────────────
//
// A desktop nobody watches or uses still runs a browser. Stop it after a
// quiet period so forgotten sessions do not slow the host down.

export const DESKTOP_IDLE_MS = Math.max(5, Number(process.env.ORVYN_DESKTOP_IDLE_MINUTES) || 30) * 60_000;
const lastUse = new Map<string, number>();

/** Anything that shows the desktop is in use: input, agent actions, viewers. */
export function noteDesktopUse(sessionId: string, at = Date.now()): void {
  lastUse.set(sessionId, at);
}

export function desktopIsIdle(session: Pick<SandboxDesktopSession, "id" | "createdAt" | "lastFrameAt" | "controlOwner">, now: number, viewers: number, lastUsed?: number): boolean {
  if (viewers > 0) return false;
  if (session.controlOwner === "user") return false;
  const last = Math.max(session.createdAt, lastUsed ?? 0);
  return now - last > DESKTOP_IDLE_MS;
}

let idleTimer: ReturnType<typeof setInterval> | null = null;
export function startDesktopIdleReaper(): void {
  if (idleTimer) return;
  idleTimer = setInterval(() => {
    const now = Date.now();
    for (const s of sessions.values()) {
      if (s.status === "ended" || s.status === "starting") continue;
      if (desktopIsIdle(s, now, frameStreamViewers(s.id), lastUse.get(s.id))) {
        console.log(`[desktop] stopping idle desktop ${s.id}`);
        lastUse.delete(s.id);
        void stopSandboxDesktop(s);
      }
    }
  }, 60_000);
  idleTimer.unref?.();
}
