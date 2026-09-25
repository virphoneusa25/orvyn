// Pins the Windows command normalization that keeps agents self-sufficient:
// models emit POSIX-isms (`/c/...`, `2>/dev/null`) and cmd.exe answers with
// "The system cannot find the path specified." — the exact live failure this
// exists to prevent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeWindowsCommand } from "./terminalTool";

test("unix drive paths become Windows drive paths", () => {
  assert.equal(
    normalizeWindowsCommand("cd /c/laragon/www/virphone && git diff --stat"),
    "cd C:/laragon/www/virphone && git diff --stat"
  );
  assert.equal(normalizeWindowsCommand("ls /d/data"), "ls D:/data");
});

test("/dev/null redirects become NUL", () => {
  assert.equal(
    normalizeWindowsCommand("git diff --cached --stat 2>/dev/null | head -20"),
    "git diff --cached --stat 2>NUL | head -20"
  );
  assert.equal(normalizeWindowsCommand("foo > /dev/null"), "foo >NUL");
});

test("cmd flags and URLs are untouched", () => {
  assert.equal(normalizeWindowsCommand("dir /b /s C:\\x"), "dir /b /s C:\\x");
  assert.equal(
    normalizeWindowsCommand("curl http://example.com/c/path"),
    "curl http://example.com/c/path"
  );
  assert.equal(normalizeWindowsCommand("cp htaccess.bak .htaccess"), "cp htaccess.bak .htaccess");
});

test("a command that leaves a background process finishes when the shell exits", async () => {
  const { runStreaming } = await import("./terminalTool");
  const started = Date.now();
  // The background sleeper inherits stdout; the shell itself is done at once.
  const bg = process.platform === "win32" ? "start /b ping -n 20 127.0.0.1 >nul & echo done" : "sleep 20 & echo done";
  const r = await runStreaming(bg, process.cwd(), undefined, undefined, 15_000);
  assert.equal(r.ok, true);
  assert.match(String(r.output), /done/);
  assert.ok(Date.now() - started < 8_000, `took ${Date.now() - started}ms`);
});
