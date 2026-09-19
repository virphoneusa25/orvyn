import { exec } from "child_process";

export interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

export function execCapture(
  command: string,
  cwd: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv
): Promise<Captured> {
  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, ...env, CI: "true" },
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
        resolve({
          code: Number.isFinite(code) ? code : 1,
          stdout: stdout ?? "",
          stderr: stderr ?? (error?.message ?? ""),
        });
      }
    );
  });
}
