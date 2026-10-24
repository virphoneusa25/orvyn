// apps/backend/src/sandbox/DockerSandboxProvider.ts

import { DockerSandbox } from "./DockerSandbox";
import type { SandboxProvider, SandboxSession } from "./SandboxProvider";

export class DockerSandboxProvider implements SandboxProvider {
  readonly name = "docker";

  available(): Promise<boolean> {
    return DockerSandbox.available();
  }

  start(missionId: string, projectRoot: string): Promise<SandboxSession> {
    return DockerSandbox.start(missionId, projectRoot);
  }
}
