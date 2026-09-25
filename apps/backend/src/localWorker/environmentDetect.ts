import { execFile } from "child_process";

export interface LocalEnvironment {
  /** process.platform of the user's computer: "win32", "darwin", "linux". */
  os?: string;
  node?: string;
  npm?: string;
  pnpm?: string;
  yarn?: string;
  python?: string;
  pip?: string;
  uv?: string;
  git?: string;
  docker?: string;
}

function versionOf(bin: string, args: string[] = ["--version"]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 4000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return resolve(undefined);
      const text = `${stdout} ${stderr}`.trim();
      const m = text.match(/\d+\.\d+(?:\.\d+)?/);
      resolve(m?.[0] ?? text.split(/\s+/)[0]);
    });
  });
}

export async function detectLocalEnvironment(): Promise<LocalEnvironment> {
  const [node, npm, pnpm, yarn, python, python3, pip, uv, git, docker] = await Promise.all([
    versionOf("node"),
    versionOf("npm"),
    versionOf("pnpm"),
    versionOf("yarn"),
    versionOf("python"),
    versionOf("python3"),
    versionOf("pip"),
    versionOf("uv"),
    versionOf("git"),
    versionOf("docker", ["version", "--format", "{{.Server.Version}}"]),
  ]);
  return {
    os: process.platform,
    node,
    npm,
    pnpm,
    yarn,
    python: python ?? python3,
    pip,
    uv,
    git,
    docker,
  };
}

export function missingRuntime(env: LocalEnvironment, needed: Array<keyof LocalEnvironment>): string[] {
  return needed.filter((k) => !env[k]);
}
