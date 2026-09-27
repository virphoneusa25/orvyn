import { test } from "node:test";
import assert from "node:assert/strict";
import { formatGitStatus, parseGitStatusPorcelain } from "./gitStatus";

test("git status porcelain becomes a structured snapshot", () => {
  const snapshot = parseGitStatusPorcelain([
    "## main...origin/main",
    " M apps/index.html",
    "A  public/hero.svg",
    "?? notes.txt",
  ].join("\n"));
  assert.equal(snapshot.branch, "main");
  assert.equal(snapshot.clean, false);
  assert.deepEqual(snapshot.modified, ["apps/index.html"]);
  assert.deepEqual(snapshot.staged, ["public/hero.svg"]);
  assert.deepEqual(snapshot.untracked, ["notes.txt"]);
  assert.equal(snapshot.repository, true);
  const text = formatGitStatus(snapshot);
  assert.match(text, /"branch":"main"/);
  assert.match(text, /public\/hero\.svg/);
});
