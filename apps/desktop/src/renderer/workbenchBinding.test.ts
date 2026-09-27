import { test } from "node:test";
import assert from "node:assert/strict";
import { withWrittenFiles } from "./filesPanelModel.ts";
import {
  NEW_WORKSPACE_LABEL,
  NO_WORKSPACE_LABEL,
  OPEN_PREVIEW_LABEL,
  PREVIEW_STOPPED_LABEL,
  PROJECT_RESTORED_LABEL,
  isUntrustedWorkbenchRoot,
  previewUrlForSelection,
  projectWorkbench,
  sameWorkspace,
  shouldListDisk,
  workspaceChromeLabel,
  type WorkbenchSessionSnapshot,
} from "./workbenchBinding.ts";

const ROOT = "/data/tenants/t1/workspaces/ws_site";
const GUESSED = "C:/Users/me/AppData/Roaming/@orvyn/workspace";

function websiteEvents() {
  return [
    {
      type: "workspace.resolved",
      data: {
        sessionId: "ses_1",
        projectId: "proj_1",
        workspaceId: "ws_1",
        projectRoot: ROOT,
        created: true,
        restored: false,
      },
    },
    { type: "run.execution", data: { executionTargetActual: "local_host" } },
    { type: "file.created", data: { path: "index.html" } },
    {
      type: "file.edit",
      data: {
        path: "index.html",
        preview: { path: "index.html", kind: "create", additions: 20, deletions: 0, diff: [{ type: "add", content: "<h1>Hello</h1>" }] },
      },
    },
    { type: "file.created", data: { path: `${ROOT}/styles.css` } },
    { type: "file.edit", data: { path: "styles.css", preview: { path: "styles.css", kind: "create", additions: 4, deletions: 0 } } },
    { type: "file.created", data: { path: "../../outside.txt" } },
    { type: "terminal.started", id: "t1", data: { command: "python -m http.server 43191" } },
    { type: "preview.available", data: { url: "http://127.0.0.1:43191" } },
    { type: "browser.completed", data: { tool: "browser_open", url: "http://127.0.0.1:43191" } },
  ];
}

test("a website run binds Files, Changes, Terminal, and Browser to the resolved workspace", () => {
  const view = projectWorkbench({ events: websiteEvents(), guessedRoot: GUESSED });
  assert.equal(view.label, NEW_WORKSPACE_LABEL);
  assert.equal(view.status, "created");
  assert.equal(view.listRoot, ROOT);
  assert.notEqual(view.listRoot, GUESSED);
  assert.equal(shouldListDisk(view.listRoot, GUESSED), false);
  assert.deepEqual(view.identity && {
    sessionId: view.identity.sessionId,
    projectId: view.identity.projectId,
    workspaceId: view.identity.workspaceId,
    projectRoot: view.identity.projectRoot,
  }, {
    sessionId: "ses_1",
    projectId: "proj_1",
    workspaceId: "ws_1",
    projectRoot: ROOT,
  });
  assert.deepEqual(view.files.map((f) => f.path).sort(), ["index.html", "styles.css"]);
  assert.equal(view.files.some((f) => f.path.includes("outside")), false);
  const index = view.changes.find((c) => c.path === "index.html");
  assert.equal(index?.kind, "create");
  assert.equal(index?.diff?.[0]?.content, "<h1>Hello</h1>");
  assert.equal(view.changes.some((c) => c.path === "styles.css"), true);
  assert.deepEqual(view.commands.map((c) => c.command), ["python -m http.server 43191"]);
  assert.equal(view.previewUrl, "http://127.0.0.1:43191");
  assert.equal(view.browserUrl, "http://127.0.0.1:43191");
  const tree = withWrittenFiles([], view.files.map((f) => f.path));
  assert.deepEqual(tree.map((n) => n.name).sort(), ["index.html", "styles.css"]);
});

test("no project shows No workspace yet and does not list a guessed directory", () => {
  for (const guessed of [null, "", ".", "./", "/opt/orvyn/workspaces", GUESSED]) {
    const view = projectWorkbench({ events: [], guessedRoot: guessed });
    assert.equal(view.label, NO_WORKSPACE_LABEL);
    assert.equal(view.status, "none");
    assert.equal(view.listRoot, null);
    assert.equal(view.files.length, 0);
    assert.equal(isUntrustedWorkbenchRoot(guessed), true);
    assert.equal(workspaceChromeLabel(view, "workspace", guessed, view.listRoot), NO_WORKSPACE_LABEL);
  }
});

test("reopening the same conversation reconnects to the same project workspace", () => {
  const live = projectWorkbench({ events: websiteEvents(), guessedRoot: "." });
  const session: WorkbenchSessionSnapshot = {
    sessionId: live.identity!.sessionId,
    projectId: live.identity!.projectId,
    workspaceId: live.identity!.workspaceId,
    projectRoot: live.identity!.projectRoot,
    created: false,
    restored: true,
    files: [
      { path: "index.html", operation: "write" },
      { path: "styles.css", operation: "write" },
    ],
    preview: { url: "http://127.0.0.1:43191", available: true },
  };
  const reopened = projectWorkbench({ events: [], session, guessedRoot: GUESSED });
  assert.equal(sameWorkspace(live.identity, reopened.identity), true);
  assert.equal(reopened.listRoot, ROOT);
  assert.notEqual(reopened.listRoot, GUESSED);
  assert.equal(shouldListDisk(reopened.listRoot, GUESSED), false);
  assert.deepEqual(reopened.files.map((f) => f.path).sort(), ["index.html", "styles.css"]);
  assert.equal(reopened.changes.length, 2);
  assert.equal(reopened.previewUrl, "http://127.0.0.1:43191");
  assert.equal(reopened.browserUrl, "http://127.0.0.1:43191");
  assert.equal(workspaceChromeLabel(reopened, "workspace", GUESSED, reopened.listRoot), "Workspace");
  assert.equal(reopened.projectStatusLabel, PROJECT_RESTORED_LABEL);
  assert.equal(reopened.previewStatusLabel, OPEN_PREVIEW_LABEL);
  assert.equal(reopened.previewAvailable, true);
  assert.equal(reopened.previewStopped, false);
  assert.equal(previewUrlForSelection(reopened, false), null);
  assert.equal(previewUrlForSelection(reopened, true), "http://127.0.0.1:43191");
});

test("a stopped preview leaves the project files and does not claim the site is gone", () => {
  const session: WorkbenchSessionSnapshot = {
    sessionId: "ses_1",
    projectId: "proj_1",
    workspaceId: "ws_1",
    projectRoot: ROOT,
    projectName: "Harbor",
    created: false,
    restored: true,
    files: [
      { path: "index.html", operation: "write" },
      { path: "styles.css", operation: "write" },
    ],
    runs: [{ runId: "run_1", status: "completed", instruction: "Build a website", createdAt: 1 }],
    artifacts: [{ artifactId: "art_1", name: "logo.png", mimeType: "image/png" }],
    preview: { url: "http://127.0.0.1:43191", available: false },
  };
  const view = projectWorkbench({ events: [], session, guessedRoot: GUESSED });
  assert.equal(view.projectName, "Harbor");
  assert.equal(view.identity?.workspaceId, "ws_1");
  assert.deepEqual(view.files.map((f) => f.path).sort(), ["index.html", "styles.css"]);
  assert.equal(view.changes.length, 2);
  assert.equal(view.runs[0]?.instruction, "Build a website");
  assert.equal(view.artifacts[0]?.name, "logo.png");
  assert.equal(view.projectStatusLabel, PROJECT_RESTORED_LABEL);
  assert.equal(view.previewStatusLabel, PREVIEW_STOPPED_LABEL);
  assert.equal(view.previewAvailable, false);
  assert.equal(view.previewUrl, null);
  assert.equal(view.previewSavedUrl, "http://127.0.0.1:43191");
  assert.equal(previewUrlForSelection(view, true), null);
  assert.equal(view.previewOpensAutomatically, false);
  assert.doesNotMatch(`${view.projectStatusLabel} ${view.previewStatusLabel}`, /does not exist/i);
});
