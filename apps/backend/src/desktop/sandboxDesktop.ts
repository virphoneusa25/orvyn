// apps/backend/src/desktop/sandboxDesktop.ts
//
// Container-backed sandbox desktop — a TRUE visual desktop (Xvfb + openbox
// + Chromium + xterm), not just a browser viewport. The container runs on
// the local Docker daemon or the OVH worker; the control plane captures
// frames via `docker exec import` and injects input via `docker exec xdotool`.
//
// Security: the container is isolated (--network none by default, or a
// project-specific network), cap-drop ALL, no-new-privileges, resource
// limits. Only the project workspace is mounted.

import { spawn, exec } from "child_process";
import { randomUUID } from "crypto";

export interface SandboxDesktopSession {
  id: string;
  containerId: string;
  containerName: string;
  tenantId: string;
  projectRoot?: string;
  runId?: string;
  status: "starting" | "ready" | "user_control" | "ended" | "error";
  controlOwner: "orion" | "user" | "none";
  width: number;
  height: number;
  url?: string;
  createdAt: number;
  lastFrameAt: number;
  error?: string;
}

const sessions = new Map<string, SandboxDesktopSession>();

function dockerExec(containerId: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn("docker", ["exec", containerId, ...args], { windowsHide: true });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    p.on("error", () => resolve({ code: -1, stdout: "", stderr: "docker not found" }));
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
  const height = opts.height ?? 800;

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
    createdAt: Date.now(),
    lastFrameAt: 0,
  };

  // Build the docker run command with security constraints.
  const args = [
    "run", "-d",
    "--name", containerName,
    "-e", `SCREEN_WIDTH=${width}`,
    "-e", `SCREEN_HEIGHT=${height}`,
    ...(opts.url ? ["-e", `START_URL=${opts.url}`] : []),
    // Security: isolated, no new privileges, drop all caps, resource limits.
    "--network", "none",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--memory", "2g",
    "--cpus", "2",
    "--pids-limit", "512",
    "--shm-size", "512m",
    "-l", `orvyn.desktop.id=${id}`,
    "-l", `orvyn.desktop.tenant=${opts.tenantId}`,
    ...(opts.projectRoot ? ["-v", `${opts.projectRoot}:/home/orvyn/project:ro`] : []),
    "orvyn-desktop:latest",
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

  // Wait for the desktop to be ready (entrypoint starts Xvfb + openbox + Chromium).
  const ready = await new Promise<boolean>((resolve) => {
    let tries = 0;
    const check = async () => {
      tries++;
      const r = await dockerExec(containerId, ["xdotool", "getdisplaygeometry"]);
      if (r.code === 0 && r.stdout.trim()) {
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
    // Clean up the failed container.
    void dockerExec(containerId, ["true"]).then(() => {
      exec(`docker rm -f ${containerId}`, { windowsHide: true });
    });
    sessions.set(id, session);
    return session;
  }

  session.status = "ready";
  sessions.set(id, session);
  return session;
}

export async function captureSandboxFrame(session: SandboxDesktopSession): Promise<Buffer | null> {
  if (session.status !== "ready" && session.status !== "user_control") return null;
  const r = await dockerExec(session.containerId, [
    "import", "-window", "root", "-quality", "75", "jpeg:-",
  ]);
  if (r.code === 0 && r.stdout.length > 100) {
    session.lastFrameAt = Date.now();
    // The stdout contains the raw JPEG bytes as a string — convert to Buffer.
    return Buffer.from(r.stdout, "binary");
  }
  return null;
}

export async function sandboxInput(
  session: SandboxDesktopSession,
  type: string,
  args: Record<string, unknown>,
): Promise<boolean> {
  if (session.controlOwner !== "user") return false;
  const viewW = Number(args.viewWidth ?? session.width);
  const viewH = Number(args.viewHeight ?? session.height);
  const x = Math.round(Number(args.x ?? 0) * (session.width / Math.max(1, viewW)));
  const y = Math.round(Number(args.y ?? 0) * (session.height / Math.max(1, viewH)));

  let cmd: string[] = [];
  switch (type) {
    case "move":
      cmd = ["xdotool", "mousemove", String(x), String(y)];
      break;
    case "click":
      cmd = ["xdotool", "click", "--window", "$(xdotool getactivewindow)", "1"];
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
      cmd = ["xdotool", "click", "--repeat", String(times), "--delay", "50", button];
      break;
    }
    case "key": {
      const key = String(args.key ?? "");
      const mapped = key === "Enter" ? "Return" : key === " " ? "space" : key;
      cmd = ["xdotool", "key", mapped];
      break;
    }
    case "type": {
      const text = String(args.text ?? "");
      if (text) cmd = ["xdotool", "type", "--delay", "30", text];
      break;
    }
    default:
      return false;
  }
  if (!cmd.length) return true;
  const r = await dockerExec(session.containerId, cmd);
  return r.code === 0;
}

export async function sandboxNavigate(session: SandboxDesktopSession, url: string): Promise<boolean> {
  if (session.status !== "ready") return false;
  // Focus Chromium and navigate via xdotool (Ctrl+L, type URL, Enter).
  const r = await dockerExec(session.containerId, [
    "xdotool", "search", "--name", "Chromium", "windowactivate", "--sync",
    "key", "--clearmodifiers", "ctrl+l",
  ]);
  await new Promise((res) => setTimeout(res, 200));
  await dockerExec(session.containerId, ["xdotool", "type", "--delay", "20", url]);
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
    if (s.tenantId === tenantId && (!projectRoot || s.projectRoot === projectRoot)) return s;
  }
  return undefined;
}

export async function stopSandboxDesktop(session: SandboxDesktopSession): Promise<void> {
  session.status = "ended";
  session.controlOwner = "none";
  // Kill the container.
  exec(`docker rm -f ${session.containerId}`, { windowsHide: true }, () => {
    sessions.delete(session.id);
  });
}

export function listSandboxSessions(tenantId: string): SandboxDesktopSession[] {
  return [...sessions.values()].filter((s) => s.tenantId === tenantId && s.status !== "ended");
}
