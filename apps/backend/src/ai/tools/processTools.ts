// apps/backend/src/ai/tools/processTools.ts
//
// Background processes (dev servers, watchers) for agents. Output is kept in a
// bounded ring buffer per process so logs can be read without unbounded memory.
// Managers are per project root; processes are killed when stopped explicitly.

import { spawn, ChildProcess } from "child_process";
import { AITool, ToolResult } from "../ToolTypes";

interface ManagedProcess {
  id: string;
  command: string;
  child: ChildProcess;
  startedAt: number;
  running: boolean;
  exitCode: number | null;
  buffer: string[];
  bytes: number;
}

const MAX_BUFFER_BYTES = 256 * 1024;
const MAX_PROCESSES = 8;

class ProcessManager {
  private procs = new Map<string, ManagedProcess>();
  private nextId = 1;

  constructor(private cwd: string) {}

  start(command: string): ToolResult {
    const live = Array.from(this.procs.values()).filter((p) => p.running);
    if (live.length >= MAX_PROCESSES) {
      return { ok: false, error: `Too many running processes (${MAX_PROCESSES}); stop one first.` };
    }
    const id = `proc_${this.nextId++}`;
    const child = spawn(command, { cwd: this.cwd, shell: true, windowsHide: true });
    const proc: ManagedProcess = {
      id,
      command,
      child,
      startedAt: Date.now(),
      running: true,
      exitCode: null,
      buffer: [],
      bytes: 0,
    };
    const append = (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      proc.buffer.push(s);
      proc.bytes += s.length;
      while (proc.bytes > MAX_BUFFER_BYTES && proc.buffer.length > 1) {
        proc.bytes -= proc.buffer[0].length;
        proc.buffer.shift();
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("exit", (code) => {
      proc.running = false;
      proc.exitCode = code;
    });
    child.on("error", (err) => {
      proc.running = false;
      append(Buffer.from(`\n[spawn error] ${err.message}\n`));
    });
    this.procs.set(id, proc);
    return { ok: true, output: `Started ${id}: ${command}` };
  }

  stop(id: string): ToolResult {
    const p = this.procs.get(id);
    if (!p) return { ok: false, error: `Unknown process "${id}"` };
    if (!p.running) return { ok: true, output: `${id} already exited (code ${p.exitCode})` };
    try {
      if (process.platform === "win32" && p.child.pid) {
        // Kill the whole tree — shell:true means the real server is a child of the shell.
        spawn("taskkill", ["/pid", String(p.child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        p.child.kill("SIGTERM");
      }
      return { ok: true, output: `Stopped ${id}` };
    } catch (err: any) {
      return { ok: false, error: `Failed to stop ${id}: ${err.message}` };
    }
  }

  logs(id: string, tail: number): ToolResult {
    const p = this.procs.get(id);
    if (!p) return { ok: false, error: `Unknown process "${id}"` };
    const text = p.buffer.join("");
    const lines = text.split(/\r?\n/);
    const shown = lines.slice(-tail).join("\n");
    const status = p.running ? "running" : `exited (code ${p.exitCode})`;
    return { ok: true, output: `[${p.id}] ${p.command} — ${status}\n\n${shown || "(no output yet)"}` };
  }

  list(): ToolResult {
    if (this.procs.size === 0) return { ok: true, output: "(no background processes)" };
    return {
      ok: true,
      output: Array.from(this.procs.values())
        .map(
          (p) =>
            `${p.id}: ${p.command} — ${p.running ? "running" : `exited (code ${p.exitCode})`} since ${new Date(p.startedAt).toISOString()}`
        )
        .join("\n"),
    };
  }
}

const managers = new Map<string, ProcessManager>();

function managerFor(projectRoot: string): ProcessManager {
  let m = managers.get(projectRoot);
  if (!m) {
    m = new ProcessManager(projectRoot);
    managers.set(projectRoot, m);
  }
  return m;
}

export function makeStartProcessTool(projectRoot: string): AITool {
  return {
    name: "start_process",
    description:
      "Start a long-running background process (dev server, watcher) in the project root. Returns a process id. Use read_process_logs to check its output; use terminal for one-shot commands.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
    defaultPermission: "ask",
    execute: async (args) => managerFor(projectRoot).start(String(args.command ?? "")),
  };
}

export function makeStopProcessTool(projectRoot: string): AITool {
  return {
    name: "stop_process",
    description: "Stop a background process started with start_process.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    defaultPermission: "ask",
    execute: async (args) => managerFor(projectRoot).stop(String(args.id ?? "")),
  };
}

export function makeReadProcessLogsTool(projectRoot: string): AITool {
  return {
    name: "read_process_logs",
    description: "Read the recent output of a background process (default: last 80 lines).",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        tail: { type: "number", description: "How many trailing lines (default 80)" },
      },
      required: ["id"],
    },
    defaultPermission: "allowed",
    execute: async (args) =>
      managerFor(projectRoot).logs(String(args.id ?? ""), Math.min(Math.max(Number(args.tail) || 80, 1), 500)),
  };
}

export function makeListProcessesTool(projectRoot: string): AITool {
  return {
    name: "list_processes",
    description: "List background processes started in this project and their status.",
    parameters: { type: "object", properties: {} },
    defaultPermission: "allowed",
    execute: async () => managerFor(projectRoot).list(),
  };
}
