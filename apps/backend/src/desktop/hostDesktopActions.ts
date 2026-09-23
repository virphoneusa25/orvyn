/** Shared Windows host input used by host_desktop_* tools and ComputerUseCapability. */

import { execFile } from "child_process";
import { promisify } from "util";
import { beginHostAgentAction, failHostAction } from "./hostDesktopSession";

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

export async function runHostAction(
  tenantId: string,
  action: string,
  win32: () => Promise<{ ok: boolean; output?: string; error?: string }>
): Promise<{ ok: boolean; output?: string; error?: string }> {
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

export async function hostClick(tenantId: string, x: number, y: number): Promise<{ ok: boolean; output?: string; error?: string }> {
  return runHostAction(tenantId, "click", async () => {
    const out = await powershell(
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point ${Math.round(x)},${Math.round(y)}; Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class H { [DllImport("user32.dll")] public static extern void mouse_event(int f,int x,int y,int d,int e); }'; [H]::mouse_event(0x02,0,0,0,0); [H]::mouse_event(0x04,0,0,0,0)`
    );
    return out.ok ? { ok: true, output: `Clicked ${x},${y}` } : { ok: false, error: out.error ?? "click failed" };
  });
}

export async function hostMove(tenantId: string, x: number, y: number): Promise<{ ok: boolean; output?: string; error?: string }> {
  return runHostAction(tenantId, "move", async () => {
    const out = await powershell(
      `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class H { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); }'; [H]::SetCursorPos(${Math.round(x)},${Math.round(y)})`
    );
    return out.ok ? { ok: true, output: `Moved to ${x},${y}` } : { ok: false, error: out.error ?? "move failed" };
  });
}

export async function hostType(tenantId: string, text: string): Promise<{ ok: boolean; output?: string; error?: string }> {
  return runHostAction(tenantId, "type", async () => {
    const safe = String(text ?? "").replace(/'/g, "''").slice(0, 400);
    const out = await powershell(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${safe}')`);
    return out.ok ? { ok: true, output: `Typed ${safe.length} characters` } : { ok: false, error: out.error ?? "type failed" };
  });
}

export async function hostScroll(tenantId: string, delta: number): Promise<{ ok: boolean; output?: string; error?: string }> {
  return runHostAction(tenantId, "scroll", async () => {
    const out = await powershell(
      `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class H { [DllImport("user32.dll")] public static extern void mouse_event(int f,int x,int y,int d,int e); }'; [H]::mouse_event(0x0800,0,0,${Math.round(delta)},0)`
    );
    return out.ok ? { ok: true, output: `Scrolled ${delta}` } : { ok: false, error: out.error ?? "scroll failed" };
  });
}

export async function hostKey(tenantId: string, key: string): Promise<{ ok: boolean; output?: string; error?: string }> {
  return runHostAction(tenantId, "key", async () => {
    const safe = String(key ?? "Enter").replace(/'/g, "''").slice(0, 40);
    const out = await powershell(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{${safe}}')`);
    return out.ok ? { ok: true, output: `Pressed ${safe}` } : { ok: false, error: out.error ?? "key failed" };
  });
}
