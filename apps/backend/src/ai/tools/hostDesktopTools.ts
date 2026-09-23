/** Opt-in host Windows desktop control. Never merged with cloud Desktop. */

import { execFile } from "child_process";
import { promisify } from "util";
import { AITool, ToolResult } from "../ToolTypes";
import {
  beginHostAgentAction,
  failHostAction,
  getHostDesktopState,
  isHostDesktopAllowed,
} from "../../desktop/hostDesktopSession";

const execFileAsync = promisify(execFile);

async function powershell(script: string): Promise<{ ok: boolean; output: string; error?: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 12_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }
    );
    return { ok: true, output: String(stdout || stderr || "ok").slice(0, 4000) };
  } catch (err: any) {
    return { ok: false, output: "", error: String(err?.stderr || err?.message || err).slice(0, 400) };
  }
}

async function runHost(tenantId: string, action: string, win32: () => Promise<ToolResult>): Promise<ToolResult> {
  const gate = beginHostAgentAction(tenantId, action);
  if (!gate.ok) return gate;
  if (process.platform !== "win32") {
    const error = "Host desktop control is implemented for Windows. This machine is not Windows.";
    failHostAction(tenantId, error);
    return { ok: false, error };
  }
  const result = await win32();
  if (!result.ok) failHostAction(tenantId, result.error ?? "failed");
  return result;
}

export function makeHostDesktopStatusTool(tenantId: string): AITool {
  return {
    name: "host_desktop_status",
    description: "Status of opt-in host Windows desktop control. Separate from cloud Desktop and Browser.",
    parameters: { type: "object", properties: {} },
    defaultPermission: "allowed",
    execute: async () => ({
      ok: true,
      output: JSON.stringify({ ...getHostDesktopState(tenantId), enabled: isHostDesktopAllowed(tenantId) }),
    }),
  };
}

export function makeHostDesktopScreenshotTool(tenantId: string): AITool {
  return {
    name: "host_desktop_screenshot",
    description: "Capture the user's actual Windows desktop. Requires Settings opt-in. Not the cloud Desktop.",
    parameters: { type: "object", properties: {} },
    defaultPermission: "ask",
    execute: async () =>
      runHost(tenantId, "screenshot", async () => {
        const script = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$path = Join-Path $env:TEMP 'orvyn-host-desktop.png'
$bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output $path
`;
        const out = await powershell(script);
        return out.ok
          ? { ok: true, output: `Screenshot saved to ${out.output.trim()}` }
          : { ok: false, error: out.error ?? "Screenshot failed" };
      }),
  };
}

export function makeHostDesktopMoveTool(tenantId: string): AITool {
  return {
    name: "host_desktop_move",
    description: "Move the mouse on the host Windows desktop. Requires Settings opt-in.",
    parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] },
    defaultPermission: "ask",
    execute: async (args) =>
      runHost(tenantId, "move", async () => {
        const x = Number(args.x ?? 0);
        const y = Number(args.y ?? 0);
        const out = await powershell(
          `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class H { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); }'; [H]::SetCursorPos(${Math.round(x)},${Math.round(y)})`
        );
        return out.ok ? { ok: true, output: `Moved to ${x},${y}` } : { ok: false, error: out.error ?? "move failed" };
      }),
  };
}

export function makeHostDesktopClickTool(tenantId: string): AITool {
  return {
    name: "host_desktop_click",
    description: "Click on the host Windows desktop. Requires Settings opt-in.",
    parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, button: { type: "string" } } },
    defaultPermission: "ask",
    execute: async (args) =>
      runHost(tenantId, "click", async () => {
        const x = Number(args.x ?? 0);
        const y = Number(args.y ?? 0);
        const out = await powershell(
          `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point ${Math.round(x)},${Math.round(y)}; Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class H { [DllImport("user32.dll")] public static extern void mouse_event(int f,int x,int y,int d,int e); }'; [H]::mouse_event(0x02,0,0,0,0); [H]::mouse_event(0x04,0,0,0,0)`
        );
        return out.ok ? { ok: true, output: `Clicked ${x},${y}` } : { ok: false, error: out.error ?? "click failed" };
      }),
  };
}

export function makeHostDesktopTypeTool(tenantId: string): AITool {
  return {
    name: "host_desktop_type",
    description: "Type into the focused host window. Requires Settings opt-in.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    defaultPermission: "ask",
    execute: async (args) =>
      runHost(tenantId, "type", async () => {
        const text = String(args.text ?? "").replace(/'/g, "''").slice(0, 400);
        const out = await powershell(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${text}')`);
        return out.ok ? { ok: true, output: `Typed ${text.length} characters` } : { ok: false, error: out.error ?? "type failed" };
      }),
  };
}

export function makeHostDesktopScrollTool(tenantId: string): AITool {
  return {
    name: "host_desktop_scroll",
    description: "Scroll the host Windows desktop. Requires Settings opt-in.",
    parameters: { type: "object", properties: { delta: { type: "number" } } },
    defaultPermission: "ask",
    execute: async (args) =>
      runHost(tenantId, "scroll", async () => {
        const delta = Number(args.delta ?? -120);
        const out = await powershell(
          `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class H { [DllImport("user32.dll")] public static extern void mouse_event(int f,int x,int y,int d,int e); }'; [H]::mouse_event(0x0800,0,0,${Math.round(delta)},0)`
        );
        return out.ok ? { ok: true, output: `Scrolled ${delta}` } : { ok: false, error: out.error ?? "scroll failed" };
      }),
  };
}

export function makeHostDesktopFocusTool(tenantId: string): AITool {
  return {
    name: "host_desktop_focus",
    description: "Focus a host window by title. Requires Settings opt-in.",
    parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    defaultPermission: "ask",
    execute: async (args) =>
      runHost(tenantId, "focus", async () => {
        const title = String(args.title ?? "").replace(/'/g, "''").slice(0, 120);
        const out = await powershell(
          `$w = Get-Process | Where-Object { $_.MainWindowTitle -like '*${title}*' } | Select-Object -First 1; if (-not $w) { throw 'Window not found' }; Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class H { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }'; [H]::SetForegroundWindow($w.MainWindowHandle)`
        );
        return out.ok ? { ok: true, output: `Focused window matching ${title}` } : { ok: false, error: out.error ?? "focus failed" };
      }),
  };
}

export function registerHostDesktopTools(register: (tool: AITool) => void, tenantId: string): void {
  register(makeHostDesktopStatusTool(tenantId));
  register(makeHostDesktopScreenshotTool(tenantId));
  register(makeHostDesktopMoveTool(tenantId));
  register(makeHostDesktopClickTool(tenantId));
  register(makeHostDesktopTypeTool(tenantId));
  register(makeHostDesktopScrollTool(tenantId));
  register(makeHostDesktopFocusTool(tenantId));
}
