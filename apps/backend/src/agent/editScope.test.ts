import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { classifyTaskScope, decideWriteGuard, writeGuardError } from "./editScope";
import { makeWriteFileTool, makeApplyPatchTool } from "../ai/tools/fileTools";

// ── Scope classification ─────────────────────────────────────────────────────

test("broad redesign asks classify as full_redesign", () => {
  for (const instruction of [
    "I don't like this site at all, can you redesign it?",
    "completely redesign the landing page",
    "rebuild this website from scratch",
    "rebrand the whole site",
    "I want a totally new design",
    "rewrite the entire stylesheet",
    "modernize the site",
  ]) {
    assert.equal(classifyTaskScope(instruction), "full_redesign", `"${instruction}"`);
  }
});

test("specific small asks classify as targeted", () => {
  for (const instruction of [
    "Change the button from blue to purple",
    "make the header text larger",
    "fix the broken footer link",
    "add a contact form",
  ]) {
    assert.equal(classifyTaskScope(instruction), "targeted", `"${instruction}"`);
  }
});

// ── Guard decision matrix ────────────────────────────────────────────────────

const big = 900;
const small = 40;

test("guard decision matrix", () => {
  // Small change → allow regardless.
  assert.equal(decideWriteGuard({ oldLines: big, newLines: big - 3, wasRead: false, taskScope: "targeted" }).decision, "allow");
  // Large + never read → read first.
  assert.equal(decideWriteGuard({ oldLines: big, newLines: small, wasRead: false, taskScope: "full_redesign" }).decision, "read_first");
  // Large + read + broad redesign → authorized with checkpoint.
  assert.equal(decideWriteGuard({ oldLines: big, newLines: small + 200, wasRead: true, taskScope: "full_redesign" }).decision, "allow_with_checkpoint");
  // Large + read + small task → replan as patch (reasoning is not authorization).
  assert.equal(decideWriteGuard({ oldLines: big, newLines: small, wasRead: true, taskScope: "targeted" }).decision, "replan_as_patch");
  assert.equal(decideWriteGuard({ oldLines: big, newLines: small, wasRead: true, taskScope: "unknown" }).decision, "replan_as_patch");
});

test("guard errors carry structured codes", () => {
  const replan = decideWriteGuard({ oldLines: big, newLines: small, wasRead: true, taskScope: "targeted" });
  assert.match(writeGuardError(replan, "styles.css"), /DESTRUCTIVE_REWRITE/);
  const readFirst = decideWriteGuard({ oldLines: big, newLines: small, wasRead: false, taskScope: "full_redesign" });
  assert.match(writeGuardError(readFirst, "styles.css"), /READ_FIRST_BEFORE_REWRITE/);
});

// ── The tools enforce it (including the apply_patch bypass) ──────────────────

function projectWithBigStyles(): string {
  const root = mkdtempSync(join(tmpdir(), "orvyn-guard-"));
  writeFileSync(join(root, "styles.css"), Array.from({ length: big }, (_, i) => `.rule-${i} { color: #123; }`).join("\n"));
  return root;
}

test("write_file: redesign + read-first is authorized; targeted asks replan", async () => {
  const root = projectWithBigStyles();
  try {
    const replacement = Array.from({ length: 200 }, (_, i) => `.new-${i} { margin: ${i}px; }`).join("\n");
    const tool = makeWriteFileTool(root);
    const filesRead = new Set(["styles.css"]);

    const intercepted = await tool.execute({ path: "styles.css", content: replacement }, { filesReadThisRun: filesRead, taskScope: "targeted" });
    assert.equal(intercepted.ok, false, "small ask + huge rewrite → replan");
    assert.equal(intercepted.meta?.code, "DESTRUCTIVE_REWRITE");

    const unread = await tool.execute({ path: "styles.css", content: replacement }, { filesReadThisRun: new Set(), taskScope: "full_redesign" });
    assert.equal(unread.ok, false, "even a redesign must read the current file first");
    assert.equal(unread.meta?.code, "READ_FIRST_BEFORE_REWRITE");

    const authorized = await tool.execute({ path: "styles.css", content: replacement }, { filesReadThisRun: filesRead, taskScope: "full_redesign" });
    assert.equal(authorized.ok, true, "redesign + read → authorized replacement");
    assert.equal(authorized.meta?.code, "AUTHORIZED_REWRITE");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("apply_patch can no longer bypass the write guard", async () => {
  const root = projectWithBigStyles();
  try {
    const replacement = Array.from({ length: 200 }, (_, i) => `.new-${i} { margin: ${i}px; }`).join("\n");
    const tool = makeApplyPatchTool(root);
    // The exact production bypass: full replacement via apply_patch on a task
    // that did not authorize it.
    const intercepted = await tool.execute({ path: "styles.css", content: replacement }, { filesReadThisRun: new Set(["styles.css"]), taskScope: "unknown" });
    assert.equal(intercepted.ok, false, "apply_patch is a replacement — guarded identically");
    assert.equal(intercepted.meta?.code, "DESTRUCTIVE_REWRITE");
    // And it is authorized for a real redesign the run read first.
    const authorized = await tool.execute({ path: "styles.css", content: replacement }, { filesReadThisRun: new Set(["styles.css"]), taskScope: "full_redesign" });
    assert.equal(authorized.ok, true);
    assert.equal(authorized.meta?.code, "AUTHORIZED_REWRITE");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
