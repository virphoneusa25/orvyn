// apps/backend/src/execution/ExecutionProvider.ts
//
// The execution-provider seam (spec PART 14): one interface behind which
// LOCAL, DOCKER_LOCAL, and (future) OVH_WORKER are interchangeable. The
// desktop does not care where a run executes — runtime events remain
// identical. The DockerSandbox already implements this shape; it adapts
// rather than being rewritten.

export type ExecutionLocation = "LOCAL" | "DOCKER_LOCAL" | "OVH_WORKER";

export interface CommandResult {
  ok: boolean;
  output: string;
  exitCode?: number;
  timedOut?: boolean;
}

export interface ExecutionProvider {
  readonly location: ExecutionLocation;

  /** Prepare the execution environment for a run. */
  startRun(runId: string, projectRoot: string): Promise<void>;

  /** Execute one command inside the environment. */
  executeCommand(runId: string, command: string, opts?: { timeoutS?: number; cwd?: string }): Promise<CommandResult>;

  /** Stream output while a command runs (live terminal events). */
  onOutput?(runId: string, cb: (chunk: string) => void): void;

  /** Cancel the active command (Stop button / run cancellation). */
  cancel(runId: string): Promise<void>;

  /** Sync produced artifacts back to the workspace (container → host). */
  downloadArtifacts(runId: string): Promise<{ files: string[] }>;

  /** Tear down the environment for a run. */
  stopRun(runId: string): Promise<void>;

  /** Liveness for the executor itself. */
  health(): Promise<{ healthy: boolean; detail?: string }>;
}

/** Run metadata for remote-capable execution (spec PART 14). */
export interface ExecutionInfo {
  executionLocation: ExecutionLocation;
  workerId?: string;
  containerId?: string;
  startedAt?: number;
  lastHeartbeat?: number;
  checkpoint?: string;
  artifactLocation?: string;
}
