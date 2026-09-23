import { AsyncLocalStorage } from "node:async_hooks";
import type { ComputerUseIdentity } from "./types";

/**
 * Trusted run identity. Models cannot supply tenantId / userId / runId —
 * StreamingAgentRuntime binds this around ToolGateway.execute.
 */
const store = new AsyncLocalStorage<ComputerUseIdentity>();

export function runWithComputerContext<T>(identity: ComputerUseIdentity, fn: () => Promise<T> | T): Promise<T> | T {
  return store.run(identity, fn);
}

export function currentComputerContext(): ComputerUseIdentity | undefined {
  return store.getStore();
}

/** Merge registration-time tenant/project with the trusted run context. Ignore model-supplied identity. */
export function trustedIdentity(
  bound: Pick<ComputerUseIdentity, "tenantId" | "projectRoot">,
  sessionHint?: string | null
): ComputerUseIdentity {
  const ctx = currentComputerContext();
  const tenantId = ctx?.tenantId || bound.tenantId;
  return {
    tenantId,
    projectRoot: ctx?.projectRoot || bound.projectRoot,
    userId: ctx?.userId ?? null,
    organizationId: ctx?.organizationId ?? null,
    projectId: ctx?.projectId ?? null,
    runId: ctx?.runId ?? null,
    desktopSessionId: sessionHint || ctx?.desktopSessionId || null,
    browserSessionId: ctx?.browserSessionId ?? null,
  };
}
