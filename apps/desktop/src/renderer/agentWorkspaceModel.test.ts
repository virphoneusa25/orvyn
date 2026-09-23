import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyManualTab,
  cursorOverlayStyle,
  deriveAgentWorkspace,
  deriveReviewSummary,
  detectPreviewUrls,
  extractOrionCommands,
  followApplies,
  followedTab,
  initialFollowState,
  isLocalPreviewUrl,
  isSafeHttpUrl,
  mapContextTab,
  parseActiveTab,
  previewLabel,
  reconstructWorkspace,
  resumeFollow,
  routeEvent,
  shouldAutoSwitch,
  toggleFollow,
  type WorkspaceEvent,
} from "./agentWorkspaceModel.ts";
import { followActiveTab, nextWorkspaceLayout } from "./agentWorkspaceLayout.ts";

function ev(type: string, data: Record<string, unknown> = {}, timestamp = 1, id?: string): WorkspaceEvent {
  return { id: id ?? type, type, timestamp, data };
}

test("safe URL checks reject javascript and relative junk", () => {
  assert.equal(isSafeHttpUrl("http://127.0.0.1:5173"), true);
  assert.equal(isSafeHttpUrl("https://docs.example.com"), true);
  assert.equal(isSafeHttpUrl("javascript:alert(1)"), false);
  assert.equal(isSafeHttpUrl("file:///etc/passwd"), false);
  assert.equal(isLocalPreviewUrl("http://localhost:43173/"), true);
  assert.equal(isLocalPreviewUrl("http://127.0.0.1:3000"), true);
  assert.equal(isLocalPreviewUrl("https://github.com"), false);
});

test("detects Vite/Next localhost URLs from terminal text", () => {
  const vite = detectPreviewUrls("  VITE v5 ready in 312 ms\n  ➜  Local:   http://localhost:5173/\n");
  assert.equal(vite.length, 1);
  assert.equal(vite[0]!.url, "http://localhost:5173/");
  assert.equal(vite[0]!.port, 5173);
  assert.equal(vite[0]!.source, "dev-server");
  assert.equal(vite[0]!.local, true);

  const next = detectPreviewUrls("▲ Next.js 14\n- Local:        http://127.0.0.1:3000");
  assert.equal(next.some((p) => p.url.includes("127.0.0.1:3000")), true);

  const none = detectPreviewUrls("compiling TypeScript…");
  assert.equal(none.length, 0);
});

test("preview labels prefer project name + port", () => {
  assert.equal(previewLabel({ url: "http://127.0.0.1:43173", label: "Preview", port: 43173, source: "dev-server", local: true }, "ORVYN"), "ORVYN :43173");
  assert.equal(previewLabel({ url: "http://localhost", label: "Preview", source: "dev-server", local: true }), "Preview");
});

test("event routing maps file/browser/terminal/review onto one tab", () => {
  const edit = routeEvent(ev("file.edit", { preview: { path: "App.tsx" } }));
  assert.equal(edit?.tab, "diff");
  assert.equal(edit?.priority, 70);
  assert.match(edit?.line ?? "", /App\.tsx/);

  const read = routeEvent(ev("file.read", { path: "readme.md" }));
  assert.equal(read?.priority, 20);
  assert.equal(read?.tab, "files");
  assert.equal(read?.switchTab, false);

  const localBrowse = routeEvent(ev("browser.action", { tool: "browser_click", url: "http://127.0.0.1:5173", target: "Sign In", x: 40, y: 80 }));
  assert.equal(localBrowse?.tab, "preview");
  assert.match(localBrowse?.line ?? "", /Sign In/);

  const extBrowse = routeEvent(ev("browser.action", { tool: "browser_goto", url: "https://docs.stripe.com" }));
  assert.equal(extBrowse?.tab, "browser");

  const term = routeEvent(ev("terminal.started", { command: "npm test" }));
  assert.equal(term?.tab, "terminal");
  assert.match(term?.line ?? "", /npm test/);

  const preview = routeEvent(ev("preview.available", { url: "http://localhost:4173" }));
  assert.equal(preview?.tab, "preview");
  assert.ok((preview?.priority ?? 0) > 80);

  const approval = routeEvent(ev("approval.required", { tool: "terminal" }));
  assert.equal(approval?.priority, 100);
  assert.equal(approval?.switchTab, false);
  assert.notEqual(approval?.tab, "review");

  const desk = routeEvent(ev("tool.started", { tool: "desktop_start", url: "http://127.0.0.1:43191" }));
  assert.equal(desk?.tab, "desktop");
  assert.equal(desk?.switchTab, true);
  const deskStop = routeEvent(ev("desktop.completed"));
  assert.equal(deskStop?.tab, "desktop");
});

test("debounce and priority stop tab thrash on tiny events", () => {
  const edit = routeEvent(ev("file.edit", { path: "a.ts" }))!;
  const read = routeEvent(ev("file.read", { path: "b.ts" }))!;
  const browse = routeEvent(ev("browser.action", { tool: "browser_click", url: "https://example.com" }))!;
  const term = routeEvent(ev("terminal.started", { command: "npm test" }))!;

  assert.equal(shouldAutoSwitch(null, edit, 0), true);
  assert.equal(shouldAutoSwitch(edit, read, 50), false);
  assert.equal(shouldAutoSwitch(edit, edit, 800), false);
  assert.equal(shouldAutoSwitch(edit, browse, 100), true);
  assert.equal(shouldAutoSwitch(browse, term, 100), false);
  assert.equal(shouldAutoSwitch(browse, term, 500), true);
  assert.equal(shouldAutoSwitch(term, routeEvent(ev("approval.required", { tool: "write_file" }))!, 10), true);
});

test("derive aggregates files, diffs, previews, cursor, and artifacts", () => {
  const events: WorkspaceEvent[] = [
    ev("file.read", { path: "src/main.ts" }, 1),
    ev("file.edit", { preview: { path: "App.tsx", kind: "create", additions: 24, deletions: 0, diff: [{ type: "add", content: "export" }] } }, 2),
    ev("file.edit", { preview: { path: "styles.css", kind: "update", additions: 18, deletions: 4, diff: [{ type: "add", content: "body{}" }] } }, 3),
    ev("terminal.output", { chunk: "VITE ready\n  Local: http://127.0.0.1:5173/\n" }, 4),
    ev("preview.available", { url: "http://127.0.0.1:5173/", label: "Dashboard" }, 5),
    ev("browser.action", { tool: "browser_click", url: "http://127.0.0.1:5173/", x: 120, y: 40, target: "Nav" }, 6),
    ev("tool.completed", { tool: "create_document", name: "report.md" }, 7),
    ev("artifact.created", { name: "virphone-logo.png", kind: "generated", id: "art_1" }, 7.5),
    ev("approval.required", { tool: "terminal" }, 8),
  ];
  const ws = deriveAgentWorkspace(events, { projectName: "ORVYN" });
  assert.equal(ws.files.some((f) => f.path === "App.tsx" && f.kind === "created"), true);
  assert.equal(ws.files.some((f) => f.path === "src/main.ts" && f.kind === "read"), true);
  assert.equal(ws.diffs.length, 2);
  assert.equal(ws.changeSummary.additions, 42);
  assert.equal(ws.changeSummary.deletions, 4);
  assert.equal(ws.previews.some((p) => p.url.includes("5173")), true);
  assert.equal(ws.browser.cursor?.x, 120);
  assert.equal(ws.browser.cursor?.kind, "click");
  assert.equal(ws.artifacts.some((a) => a.path === "report.md"), true);
  assert.equal(ws.artifacts.some((a) => a.path === "virphone-logo.png"), true);
  assert.equal(ws.waitingApproval, true);
  assert.notEqual(ws.suggestedTab, "review");
  assert.equal(followActiveTab(ws.activity, "changes"), "changes");
});

test("follow ORION default on, manual override pauses, resume restores", () => {
  const active = initialFollowState(true);
  assert.equal(active.followOrion, true);
  assert.equal(followApplies(active), true);

  const paused = applyManualTab(active);
  assert.equal(paused.followOrion, true);
  assert.equal(paused.paused, true);
  assert.equal(followApplies(paused), false);

  const resumed = resumeFollow();
  assert.equal(followApplies(resumed), true);

  const off = toggleFollow(resumed);
  assert.equal(off.followOrion, false);
  assert.equal(followApplies(off), false);
  assert.equal(followApplies(toggleFollow(off)), true);

  const idle = initialFollowState(false);
  assert.equal(idle.followOrion, false);
});

test("followed tab opens Preview for localhost automation", () => {
  const derived = deriveAgentWorkspace([
    ev("preview.available", { url: "http://localhost:43173" }, 1),
    ev("browser.action", { tool: "browser_click", url: "http://localhost:43173", x: 10, y: 10 }, 2),
  ]);
  assert.equal(followedTab(derived), "preview");
  assert.deepEqual(parseActiveTab("preview:http://localhost:43173"), { tab: "preview", previewUrl: "http://localhost:43173" });
});

test("cursor overlay clamps coordinates and keeps click kind", () => {
  assert.equal(cursorOverlayStyle(null), null);
  const pos = cursorOverlayStyle({ x: 4000, y: -20, kind: "click" }, { width: 800, height: 600 });
  assert.ok(pos);
  assert.equal(pos!.left, 792);
  assert.equal(pos!.top, 8);
  assert.equal(pos!.kind, "click");
});

test("replay reconstructs the same files, diffs, and preview without duplicates", () => {
  const events: WorkspaceEvent[] = [
    ev("file.edit", { preview: { path: "a.ts", kind: "update", additions: 2, deletions: 1, diff: [] } }, 1, "e1"),
    ev("file.edit", { preview: { path: "a.ts", kind: "update", additions: 3, deletions: 1, diff: [] } }, 2, "e2"),
    ev("terminal.output", { chunk: "http://127.0.0.1:4173" }, 3, "e3"),
    ev("terminal.output", { chunk: "Local: http://127.0.0.1:4173" }, 4, "e4"),
  ];
  const first = reconstructWorkspace(events);
  const second = reconstructWorkspace(events);
  assert.equal(first.diffs.filter((d) => d.path === "a.ts").length, 1);
  assert.equal(first.diffs[0]!.additions, 3);
  assert.equal(first.previews.filter((p) => p.url.includes("4173")).length, 1);
  assert.deepEqual(first.previews.map((p) => p.url), second.previews.map((p) => p.url));
  assert.deepEqual(first.diffs.map((d) => d.path), second.diffs.map((d) => d.path));
});

test("review summary and ORION terminal sessions derive from events", () => {
  const events: WorkspaceEvent[] = [
    ev("file.edit", { preview: { path: "App.tsx", additions: 7, deletions: 11, diff: [] } }, 1),
    ev("terminal.started", { command: "npm test" }, 2, "t1"),
    ev("terminal.output", { chunk: "174 passing" }, 3),
    ev("tool.completed", { tool: "terminal", preview: "ok" }, 4),
    ev("test.completed", { ok: true, kind: "unit" }, 5),
    ev("run.completed", {}, 6),
  ];
  const derived = deriveAgentWorkspace(events);
  const review = deriveReviewSummary(events, derived);
  assert.equal(review.filesChanged, 1);
  assert.equal(review.testsPassed, 1);
  assert.equal(review.completed, true);
  assert.equal(derived.suggestedTab, "review");
  const cmds = extractOrionCommands(events);
  assert.equal(cmds[0]!.command, "npm test");
  assert.match(cmds[0]!.output, /174 passing/);
  assert.equal(cmds[0]!.running, false);
  const switched = nextWorkspaceLayout(
    { open: true, width: 520, activeTab: "changes", followOrion: true },
    derived.activity
  );
  assert.equal(switched.activeTab, "review");
  assert.equal(switched.columns, 1);
});

test("generated file run opens Files, not empty Review", () => {
  const events: WorkspaceEvent[] = [
    ev("tool.started", { tool: "generate_image" }, 1),
    ev("tool.completed", { tool: "generate_image", artifactId: "art_2", artifactName: "virphone-logo-2.png" }, 2),
    ev("artifact.created", { artifactId: "art_2", name: "virphone-logo-2.png", kind: "generated" }, 3),
    ev("files.ready", { name: "virphone-logo-2.png" }, 4),
    ev("run.completed", { artifactCount: 1 }, 5),
  ];
  const derived = deriveAgentWorkspace(events);
  assert.equal(derived.artifacts.some((a) => a.path === "virphone-logo-2.png"), true);
  assert.equal(derived.suggestedTab, "files");
  const switched = nextWorkspaceLayout(
    { open: true, width: 520, activeTab: "changes", followOrion: true },
    derived.activity
  );
  assert.equal(switched.activeTab, "files");
});

test("mapContextTab resolves Docs/Plan/Diff onto the single tab set", () => {
  assert.equal(mapContextTab("documents"), "docs");
  assert.equal(mapContextTab("plan"), "plan");
  assert.equal(mapContextTab("browser"), "browser");
  assert.equal(mapContextTab("diff"), "diff");
});
