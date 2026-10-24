// apps/backend/src/sandbox/SandboxProvider.ts
//
// Cloud execution abstraction for ORVYN.
//
// MultiAgentRuntime and ToolGateway depend on this contract, not on Docker,
// Vercel, or any other infrastructure provider. That keeps the desktop/web UI
// and ORION orchestration unchanged while the cloud execution plane evolves.

export interface ExecResult {
  ok: boolean;
  output: string;
  exitCode: number;
  timedOut: boolean;
}

export interface SandboxMergeResult {
  mergedFiles: number;
}

export interface SandboxSession {
  /** Stable provider-native sandbox/container identifier. */
  readonly id: string;
  /** Human-readable provider key used in events/diagnostics. */
  readonly provider: string;
  /** Absolute project path inside the execution environment. */
  readonly workspacePath: string;

  exec(command: string, timeoutS?: number): Promise<ExecResult>;
  mergeBack(projectRoot: string): Promise<SandboxMergeResult>;
  stop(): Promise<void>;
}

export interface SandboxProvider {
  readonly name: string;
  available(): Promise<boolean>;
  start(missionId: string, projectRoot: string): Promise<SandboxSession>;
}

export type SandboxProviderName = "docker" | "vercel";

export function configuredSandboxProvider(): SandboxProviderName {
  const raw = process.env.ORVYN_SANDBOX_PROVIDER?.trim().toLowerCase();
  if (!raw || raw === "docker") return "docker";
  if (raw === "vercel") return "vercel";
  throw new Error(
    `Unsupported ORVYN_SANDBOX_PROVIDER="${raw}". Expected "docker" or "vercel".`
  );
}
