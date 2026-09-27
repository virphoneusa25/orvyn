// Canonical git status snapshot. The tool name stays `git_status`.
// The result is the real working tree, never a stand-in.

export interface GitStatusSnapshot {
  branch: string;
  clean: boolean;
  modified: string[];
  staged: string[];
  untracked: string[];
  repository: boolean;
}

/** `git status --porcelain=v1 -b` → structured status. */
export function parseGitStatusPorcelain(text: string): GitStatusSnapshot {
  const modified: string[] = [];
  const staged: string[] = [];
  const untracked: string[] = [];
  let branch = "";
  const lines = String(text ?? "").split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("##")) {
      const name = line.slice(2).trim().split("...")[0]?.trim() ?? "";
      branch = name === "HEAD (no branch)" ? "" : name;
      continue;
    }
    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    const file = line.slice(3).trim();
    if (!file) continue;
    if (xy === "??") {
      untracked.push(file);
      continue;
    }
    if (xy[0] && xy[0] !== " " && xy[0] !== "?") staged.push(file);
    if (xy[1] && xy[1] !== " ") modified.push(file);
  }
  return {
    branch,
    clean: modified.length === 0 && staged.length === 0 && untracked.length === 0,
    modified,
    staged,
    untracked,
    repository: true,
  };
}

export function formatGitStatus(snapshot: GitStatusSnapshot): string {
  const body = [
    `branch: ${snapshot.branch || "(none)"}`,
    `clean: ${snapshot.clean}`,
    `modified: ${snapshot.modified.join(", ") || "(none)"}`,
    `staged: ${snapshot.staged.join(", ") || "(none)"}`,
    `untracked: ${snapshot.untracked.join(", ") || "(none)"}`,
    JSON.stringify({
      branch: snapshot.branch,
      clean: snapshot.clean,
      modified: snapshot.modified,
      staged: snapshot.staged,
      untracked: snapshot.untracked,
    }),
  ];
  return body.join("\n");
}

export function notARepository(): GitStatusSnapshot {
  return { branch: "", clean: true, modified: [], staged: [], untracked: [], repository: false };
}
