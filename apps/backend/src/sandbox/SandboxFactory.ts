// apps/backend/src/sandbox/SandboxFactory.ts

import type { SandboxProvider, SandboxSession } from "./SandboxProvider";
import { configuredSandboxProvider } from "./SandboxProvider";
import { DockerSandboxProvider } from "./DockerSandboxProvider";
import { VercelSandboxProvider } from "./VercelSandboxProvider";

export function sandboxProvider(): SandboxProvider {
  switch (configuredSandboxProvider()) {
    case "vercel":
      return new VercelSandboxProvider();
    case "docker":
    default:
      return new DockerSandboxProvider();
  }
}

export async function startMissionSandbox(
  missionId: string,
  projectRoot: string
): Promise<SandboxSession> {
  const provider = sandboxProvider();

  if (!(await provider.available())) {
    throw new Error(
      'ORVYN sandbox provider "' +
        provider.name +
        '" is unavailable or not configured.'
    );
  }

  return provider.start(missionId, projectRoot);
}
