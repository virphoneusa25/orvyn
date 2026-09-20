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
