// apps/backend/src/desktop/vercelDesktop.ts
//
// True graphical desktop running inside a run-scoped Vercel Sandbox microVM.
// The existing ORVYN Desktop renderer remains unchanged.

import { randomUUID } from "crypto";
import { vercelToolRunner } from "../execution/VercelToolRunner";

export type VercelDesktopControlOwner = "orion" | "user" | "none";
export type VercelFrameQuality = "low" | "auto" | "high";

export interface VercelDesktopSession {
  id: string;
  provider: "vercel";
  tenantId: string;
  projectRoot: string;
  runId: string;
  status: "starting" | "ready" | "user_control" | "ended" | "error";
  controlOwner: VercelDesktopControlOwner;
  width: number;
  height: number;
  url?: string;
  resources: { os: string; vcpus: number; memoryMb: number };
  createdAt: number;
  startedAt?: string;
  startDurationMs?: number;
  lastFrameAt: number;
  error?: string;
}

const sessions = new Map<string, VercelDesktopSession>();

function sh(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function findVercelDesktopSession(
  tenantId: string,
  projectRoot?: string
): VercelDesktopSession | undefined {
  const candidates = Array.from(sessions.values())
    .filter(
      (session) =>
        session.tenantId === tenantId &&
        session.status !== "ended" &&
        (!projectRoot || session.projectRoot === projectRoot)
    )
    .sort((a, b) => b.createdAt - a.createdAt);
  return candidates[0];
}

export function getVercelDesktopSession(
  id: string
): VercelDesktopSession | undefined {
  return sessions.get(id);
}

export function listVercelDesktopSessions(
  tenantId: string
): VercelDesktopSession[] {
  return Array.from(sessions.values())
    .filter((session) => session.tenantId === tenantId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function vercelDesktopAvailable(runId?: string): boolean {
  return Boolean(runId && vercelToolRunner.hasRun(runId));
}

async function exec(
  runId: string,
  command: string,
  timeoutS = 60
): Promise<{ ok: boolean; output: string; exitCode?: number }> {
  return vercelToolRunner.execRaw(runId, command, { timeoutS });
}

async function resources(runId: string) {
  const result = await exec(
    runId,
    "uname -srm; nproc; awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo",
    10
  );
  const lines = result.output.trim().split(/\r?\n/);
  return {
    os: (lines[0] || "Linux") + " · Vercel Sandbox",
    vcpus: Math.max(0, Number(lines[1]) || 0),
    memoryMb: Math.max(0, Number(lines[2]) || 0),
  };
}

export async function startVercelDesktop(opts: {
  tenantId: string;
  projectRoot: string;
  runId: string;
  url?: string;
  width?: number;
  height?: number;
}): Promise<VercelDesktopSession> {
  const existing = findVercelDesktopSession(opts.tenantId, opts.projectRoot);
  if (
    existing &&
    existing.runId === opts.runId &&
    existing.status !== "error"
  ) {
    return existing;
  }
  if (existing) await stopVercelDesktop(existing);

  if (!vercelToolRunner.hasRun(opts.runId)) {
    throw new Error("This ORVYN Cloud run has no active Vercel Sandbox.");
  }

  const width = Math.max(800, Math.min(2560, Number(opts.width) || 1280));
  const height = Math.max(600, Math.min(1600, Number(opts.height) || 800));
  const id = "desk_v_" + randomUUID().slice(0, 12);
  const startedAt = Date.now();

  const session: VercelDesktopSession = {
    id,
    provider: "vercel",
    tenantId: opts.tenantId,
    projectRoot: opts.projectRoot,
    runId: opts.runId,
    status: "starting",
    controlOwner: "orion",
    width,
    height,
    url: opts.url,
    resources: { os: "Linux · Vercel Sandbox", vcpus: 0, memoryMb: 0 },
    createdAt: startedAt,
    lastFrameAt: 0,
  };
  sessions.set(id, session);

  try {
    const provision = [
      "sudo apt-get update -qq",
      "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq xvfb openbox xdotool imagemagick x11-apps xterm pcmanfm curl nano",
      "mkdir -p /tmp/orvyn-browser",
      "cd /tmp/orvyn-browser",
      "test -f package.json || npm init -y >/dev/null 2>&1",
      "test -d node_modules/playwright || npm install --silent --no-audit --no-fund playwright@1.63.0",
      "npx playwright install --with-deps chromium >/tmp/orvyn-desktop-playwright.log 2>&1",
      "mkdir -p /tmp/orvyn-desktop",
      "node -e \"console.log(require('playwright').chromium.executablePath())\" > /tmp/orvyn-desktop/chrome-path",
    ].join(" && ");

    const installed = await exec(opts.runId, provision, 300);
    if (!installed.ok) {
      throw new Error(
        "Desktop dependencies could not be prepared: " +
          installed.output.slice(0, 3000)
      );
    }

    const startUrl = opts.url ? sh(opts.url) : "about:blank";
    const launch =
      "export DISPLAY=:99; " +
      "rm -f /tmp/orvyn-desktop/*.pid; " +
      "nohup Xvfb :99 -screen 0 " +
      width +
      "x" +
      height +
      "x24 -nolisten tcp >/tmp/orvyn-desktop/xvfb.log 2>&1 & echo $! >/tmp/orvyn-desktop/xvfb.pid; " +
      "sleep 1; " +
      "nohup openbox >/tmp/orvyn-desktop/openbox.log 2>&1 & echo $! >/tmp/orvyn-desktop/openbox.pid; " +
      "nohup pcmanfm --desktop >/tmp/orvyn-desktop/files-desktop.log 2>&1 & echo $! >/tmp/orvyn-desktop/files-desktop.pid; " +
      "nohup xterm -geometry 110x30+30+80 >/tmp/orvyn-desktop/xterm.log 2>&1 & echo $! >/tmp/orvyn-desktop/xterm.pid; " +
      "CHROME=$(cat /tmp/orvyn-desktop/chrome-path); " +
      "nohup \"$CHROME\" --no-sandbox --disable-dev-shm-usage --user-data-dir=/tmp/orvyn-desktop-profile --window-size=" +
      width +
      "," +
      height +
      " " +
      startUrl +
      " >/tmp/orvyn-desktop/chromium.log 2>&1 & echo $! >/tmp/orvyn-desktop/chromium.pid";

    const launched = await exec(opts.runId, launch, 30);
    if (!launched.ok) {
      throw new Error(
        "Desktop processes could not start: " +
          launched.output.slice(0, 2000)
      );
    }

    const ready = await exec(
      opts.runId,
      "export DISPLAY=:99; for i in $(seq 1 60); do xdotool getdisplaygeometry >/dev/null 2>&1 && exit 0; sleep 1; done; cat /tmp/orvyn-desktop/xvfb.log; exit 1",
      75
    );
    if (!ready.ok) {
      throw new Error(
        "Desktop display did not become ready: " +
          ready.output.slice(0, 2000)
      );
    }

    session.resources = await resources(opts.runId);
    session.status = "ready";
    session.startedAt = new Date().toISOString();
    session.startDurationMs = Date.now() - startedAt;
    return session;
  } catch (error: any) {
    session.status = "error";
    session.error = error?.message ?? String(error);
    return session;
  }
}

export async function captureVercelDesktopFrame(
  session: VercelDesktopSession,
  quality: VercelFrameQuality = "auto"
): Promise<Buffer | null> {
  if (session.status !== "ready" && session.status !== "user_control") {
    return null;
  }
  const qualityValue =
    quality === "low" ? 45 : quality === "high" ? 92 : 72;
  const resize = quality === "low" ? "-resize 55% " : "";
  const command =
    "export DISPLAY=:99; timeout 8 sh -c " +
    sh(
      "xwd -root -silent | convert xwd:- " +
        resize +
        "-quality " +
        qualityValue +
        " jpeg:- | base64 -w0"
    );
  const result = await exec(session.runId, command, 12);
  if (!result.ok || !result.output.trim()) return null;
  const frame = Buffer.from(result.output.trim(), "base64");
  if (frame.length < 1000) return null;
  session.lastFrameAt = Date.now();
  return frame;
}

export async function captureVercelDesktopScreenshot(
  session: VercelDesktopSession
): Promise<Buffer | null> {
  if (session.status !== "ready" && session.status !== "user_control") {
    return null;
  }
  const result = await exec(
    session.runId,
    "export DISPLAY=:99; timeout 8 sh -c " +
      sh("xwd -root -silent | convert xwd:- png:- | base64 -w0"),
    12
  );
  if (!result.ok || !result.output.trim()) return null;
  const frame = Buffer.from(result.output.trim(), "base64");
  return frame.length > 1000 ? frame : null;
}

function keyName(raw: string): string | null {
  const value = String(raw || "").trim();
  if (!value || value.length > 60) return null;
  const map: Record<string, string> = {
    Enter: "Return",
    Escape: "Escape",
    Esc: "Escape",
    " ": "space",
  };
  const result = map[value] || value;
  return /^[A-Za-z0-9_+ -]+$/.test(result) ? result : null;
}

export async function vercelDesktopInput(
  session: VercelDesktopSession,
  type: string,
  args: Record<string, unknown>,
  actor: "user" | "orion"
): Promise<boolean> {
  if (actor === "user" && session.controlOwner !== "user") return false;
  if (actor === "orion" && session.controlOwner !== "orion") return false;
  if (session.status !== "ready" && session.status !== "user_control") {
    return false;
  }

  const x = Math.max(
    0,
    Math.min(session.width - 1, Math.round(Number(args.x) || 0))
  );
  const y = Math.max(
    0,
    Math.min(session.height - 1, Math.round(Number(args.y) || 0))
  );
  let action = "";

  if (type === "move") {
    action = "xdotool mousemove " + x + " " + y;
  } else if (type === "click") {
    action = "xdotool mousemove " + x + " " + y + " click 1";
  } else if (type === "rightclick") {
    action = "xdotool mousemove " + x + " " + y + " click 3";
  } else if (type === "dblclick") {
    action =
      "xdotool mousemove " +
      x +
      " " +
      y +
      " click --repeat 2 --delay 80 1";
  } else if (type === "scroll") {
    const delta = Number(args.deltaY) || 0;
    const button = delta > 0 ? 5 : 4;
    const times = Math.min(
      5,
      Math.max(1, Math.abs(Math.round(delta / 100)))
    );
    action =
      "xdotool mousemove " +
      x +
      " " +
      y +
      " click --repeat " +
      times +
      " " +
      button;
  } else if (type === "key") {
    const key = keyName(String(args.key || ""));
    if (!key) return false;
    action = "xdotool key --clearmodifiers " + sh(key);
  } else if (type === "type") {
    const encoded = Buffer.from(String(args.text || ""), "utf8").toString(
      "base64"
    );
    const nodeScript =
      "const {execFileSync}=require('child_process');" +
      "const s=Buffer.from(process.argv[1],'base64').toString();" +
      "execFileSync('xdotool',['type','--delay','0','--clearmodifiers','--',s],{stdio:'ignore'});";
    action =
      "node -e " + sh(nodeScript) + " " + sh(encoded);
  } else {
    return false;
  }

  const result = await exec(
    session.runId,
    "export DISPLAY=:99; " + action,
    15
  );
  return result.ok;
}

export async function vercelDesktopSendKeys(
  session: VercelDesktopSession,
  combo: string
): Promise<boolean> {
  const key = keyName(combo);
  if (!key) return false;
  const result = await exec(
    session.runId,
    "export DISPLAY=:99; xdotool key --clearmodifiers " + sh(key),
    10
  );
  return result.ok;
}

export async function vercelDesktopLaunchApp(
  session: VercelDesktopSession,
  app: "terminal" | "files" | "chromium" | "editor" | "settings"
): Promise<boolean> {
  const commands: Record<string, string> = {
    terminal: "xterm -geometry 110x30+30+80",
    files: "pcmanfm",
    chromium:
      'CHROME=$(cat /tmp/orvyn-desktop/chrome-path); "$CHROME" --no-sandbox --disable-dev-shm-usage --user-data-dir=/tmp/orvyn-desktop-profile',
    editor: "xterm -e nano",
    settings: "openbox --reconfigure",
  };
  const command = commands[app];
  if (!command) return false;
  const result = await exec(
    session.runId,
    "export DISPLAY=:99; nohup sh -lc " +
      sh(command) +
      " >/tmp/orvyn-desktop/app-" +
      app +
      ".log 2>&1 &",
    15
  );
  return result.ok;
}

export async function vercelDesktopNavigate(
  session: VercelDesktopSession,
  url: string
): Promise<{ ok: boolean; error?: string }> {
  if (session.status !== "ready" && session.status !== "user_control") {
    return { ok: false, error: "Desktop is " + session.status + "." };
  }
  const target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target)) {
    return { ok: false, error: "Only http(s) URLs can be opened." };
  }
  const chromium =
    'CHROME=$(cat /tmp/orvyn-desktop/chrome-path); "$CHROME" ' +
    "--no-sandbox --disable-dev-shm-usage " +
    "--user-data-dir=/tmp/orvyn-desktop-profile --new-tab " +
    sh(target);
  const result = await exec(
    session.runId,
    "export DISPLAY=:99; nohup sh -lc " +
      sh(chromium) +
      " >/tmp/orvyn-desktop/navigate.log 2>&1 &",
    15
  );
  if (!result.ok) {
    return { ok: false, error: result.output || "Navigation failed." };
  }
  session.url = target;
  return { ok: true };
}

export async function stopVercelDesktop(
  session: VercelDesktopSession
): Promise<void> {
  if (session.status === "ended") return;
  await exec(
    session.runId,
    "for f in /tmp/orvyn-desktop/*.pid; do " +
      'test -f "$f" && kill "$(cat "$f")" 2>/dev/null || true; ' +
      "done; rm -f /tmp/orvyn-desktop/*.pid",
    15
  ).catch(() => undefined);
  session.status = "ended";
  session.controlOwner = "none";
}

export async function restartVercelDesktop(
  session: VercelDesktopSession
): Promise<VercelDesktopSession> {
  const options = {
    tenantId: session.tenantId,
    projectRoot: session.projectRoot,
    runId: session.runId,
    url: session.url,
    width: session.width,
    height: session.height,
  };
  await stopVercelDesktop(session);
  sessions.delete(session.id);
  return startVercelDesktop(options);
}

export function resetVercelDesktopSessionsForTests(): void {
  sessions.clear();
}
