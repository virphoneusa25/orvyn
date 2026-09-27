// Reopening a chat must fetch the backend WorkSession before another run.
// orvyn-chats.json is only a cache and can be stale after a restart.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentRunRestoreError,
  applyBackendMessages,
  canStartAgentRun,
  followUpRunBinding,
  getActiveChat,
  openChatSession,
  resetChatStoreForTests,
  seedChatCacheForTests,
  sessionRestoreState,
  restoredWorkSession,
  setSessionMirror,
  type BackendMessageLike,
} from "./chatSession.ts";
import { restoreWorkSessionFromBackend, type SessionGet } from "./sessionRestore.ts";
import { OPEN_PREVIEW_LABEL, PREVIEW_STOPPED_LABEL, PROJECT_RESTORED_LABEL, previewUrlForSelection, projectWorkbench } from "./workbenchBinding.ts";

const SESSION = "ses_1";
const CANON = {
  sessionId: SESSION,
  projectId: "proj_9",
  workspaceId: "ws_9",
  projectRoot: "D:/work/site",
  runIds: ["run_a", "run_b"],
  activeRunId: "run_b",
  title: "Build the site",
  status: "active",
  pinned: false,
  createdAt: 10,
  updatedAt: 20,
};

const MESSAGES: BackendMessageLike[] = [
  { messageId: "m1", role: "user", content: "Build the files", runId: "run_a", sequence: 1, mode: "agent", createdAt: 11 },
];

function installMirror(get: SessionGet): void {
  setSessionMirror({
    patch() {},
    remove() {},
    load() {},
    restore: (sessionId, chatId, gen) => restoreWorkSessionFromBackend({
      sessionId,
      chatId,
      gen,
      get: async (path) => {
        const result = await get(path);
        if (result.ok && path.endsWith("/messages")) {
          applyBackendMessages(sessionId, ((result.body as { messages?: BackendMessageLike[] } | null)?.messages) ?? []);
        }
        return result;
      },
    }),
  });
}

test("reopening a chat restores the same WorkSession before another run can start", async () => {
  (globalThis as { window?: unknown }).window = {
    orvyn: { chats: { save: async () => {}, load: async () => ({ sessions: [] }) } },
  };
  resetChatStoreForTests();
  seedChatCacheForTests([{
    id: "chat_old",
    title: "Build the site",
    createdAt: 1,
    updatedAt: 2,
    messages: [{ role: "user", content: "Build the files", createdAt: 1 }],
    sessionId: SESSION,
    projectId: "proj_stale",
    workspaceId: "ws_stale",
    projectRoot: "C:/stale/folder",
    runId: "run_stale",
    runIds: ["run_stale"],
  }]);

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  installMirror(async (path) => {
    await gate;
    if (path.endsWith("/messages")) return { ok: true, body: { messages: MESSAGES } };
    if (path.endsWith("/state")) {
      return {
        ok: true,
        body: {
          session: CANON,
          files: [{ path: "index.html", operation: "write" }],
          preview: { url: "http://127.0.0.1:4693", available: true },
        },
      };
    }
    if (path.endsWith(`/sessions/${encodeURIComponent(SESSION)}`)) return { ok: true, body: { session: CANON } };
    return { ok: false, body: null };
  });

  const pending = openChatSession("chat_old");
  assert.equal(sessionRestoreState(), "restoring");
  assert.equal(canStartAgentRun(), false);
  assert.equal(followUpRunBinding(), null);
  assert.match(agentRunRestoreError() ?? "", /Restoring/);
  assert.equal(getActiveChat()?.projectRoot, "C:/stale/folder");

  release();
  assert.equal(await pending, "ready");
  assert.equal(sessionRestoreState(), "ready");
  assert.equal(canStartAgentRun(), true);
  assert.equal(agentRunRestoreError(), null);
  const chat = getActiveChat();
  assert.equal(chat?.sessionId, CANON.sessionId);
  assert.equal(chat?.projectId, CANON.projectId);
  assert.equal(chat?.workspaceId, CANON.workspaceId);
  assert.equal(chat?.projectRoot, CANON.projectRoot);
  assert.deepEqual(chat?.runIds, CANON.runIds);
  assert.equal(chat?.runId, CANON.activeRunId);
  assert.equal(chat?.messages[0]?.id, "m1");
  const binding = followUpRunBinding();
  assert.equal(binding?.sessionId, CANON.sessionId);
  assert.equal(binding?.projectId, CANON.projectId);
  assert.equal(binding?.workspaceId, CANON.workspaceId);
  assert.equal(binding?.projectRoot, CANON.projectRoot);
  assert.equal(binding?.previousRunId, CANON.activeRunId);
  resetChatStoreForTests();
});

test("a failed session fetch does not allow a follow-up", async () => {
  (globalThis as { window?: unknown }).window = {
    orvyn: { chats: { save: async () => {}, load: async () => ({ sessions: [] }) } },
  };
  resetChatStoreForTests();
  seedChatCacheForTests([{
    id: "chat_old",
    title: "Build the site",
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    sessionId: SESSION,
    projectRoot: "C:/stale/folder",
    projectId: "proj_stale",
    workspaceId: "ws_stale",
  }]);
  installMirror(async () => ({ ok: false, body: null }));
  assert.equal(await openChatSession("chat_old"), "failed");
  assert.equal(sessionRestoreState(), "failed");
  assert.equal(canStartAgentRun(), false);
  assert.equal(followUpRunBinding(), null);
  assert.match(agentRunRestoreError() ?? "", /could not be restored/i);
  assert.equal(getActiveChat()?.projectId, "proj_stale");
  resetChatStoreForTests();
});

const ROOT = "/data/tenants/t1/workspaces/ws_9";

function websiteState(previewAvailable: boolean) {
  return {
    session: { ...CANON, title: "Harbor", projectRoot: ROOT },
    runs: [{ runId: "run_b", status: "completed", instruction: "Build a website", createdAt: 20 }],
    activeRunId: "run_b",
    files: [
      { path: "index.html", operation: "write", runId: "run_a", at: 11 },
      { path: "styles.css", operation: "write", runId: "run_a", at: 12 },
    ],
    artifacts: [{ artifactId: "art_1", name: "logo.png", mimeType: "image/png", runId: "run_a" }],
    preview: { url: "http://127.0.0.1:43191", available: previewAvailable, runId: "run_b" },
  };
}

async function reopenWebsite(previewAvailable: boolean) {
  (globalThis as { window?: unknown }).window = {
    orvyn: { chats: { save: async () => {}, load: async () => ({ sessions: [] }) } },
  };
  resetChatStoreForTests();
  seedChatCacheForTests([{
    id: "chat_old",
    title: "Harbor",
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    sessionId: SESSION,
  }]);
  installMirror(async (path) => {
    if (path.endsWith("/messages")) return { ok: true, body: { messages: MESSAGES } };
    if (path.endsWith("/state")) return { ok: true, body: websiteState(previewAvailable) };
    if (path.endsWith(`/sessions/${encodeURIComponent(SESSION)}`)) {
      return { ok: true, body: { session: { ...CANON, title: "Harbor", projectRoot: ROOT } } };
    }
    return { ok: false, body: null };
  });
  assert.equal(await openChatSession("chat_old"), "ready");
  const restored = restoredWorkSession("chat_old");
  assert.ok(restored);
  return projectWorkbench({
    events: [],
    session: {
      sessionId: restored.sessionId,
      projectId: restored.projectId,
      workspaceId: restored.workspaceId,
      projectRoot: restored.projectRoot,
      projectName: restored.projectName,
      created: false,
      restored: true,
      files: restored.files,
      runs: restored.runs,
      artifacts: restored.artifacts,
      preview: restored.preview,
    },
  });
}

test("reopening a website restores files, and a live preview opens only when selected", async () => {
  const view = await reopenWebsite(true);
  assert.equal(view.projectName, "Harbor");
  assert.equal(view.identity?.workspaceId, CANON.workspaceId);
  assert.equal(view.identity?.projectRoot, ROOT);
  assert.deepEqual(view.files.map((f) => f.path).sort(), ["index.html", "styles.css"]);
  assert.equal(view.changes.length, 2);
  assert.equal(view.runs[0]?.instruction, "Build a website");
  assert.equal(view.artifacts[0]?.name, "logo.png");
  assert.equal(view.previewAvailable, true);
  assert.equal(view.previewStatusLabel, OPEN_PREVIEW_LABEL);
  assert.equal(view.previewOpensAutomatically, false);
  assert.equal(previewUrlForSelection(view, false), null);
  assert.equal(previewUrlForSelection(view, true), "http://127.0.0.1:43191");
  resetChatStoreForTests();
});

test("reopening a website whose preview stopped still shows the project files", async () => {
  const view = await reopenWebsite(false);
  assert.deepEqual(view.files.map((f) => f.path).sort(), ["index.html", "styles.css"]);
  assert.equal(view.projectStatusLabel, PROJECT_RESTORED_LABEL);
  assert.equal(view.previewStatusLabel, PREVIEW_STOPPED_LABEL);
  assert.equal(view.previewAvailable, false);
  assert.equal(view.previewUrl, null);
  assert.equal(previewUrlForSelection(view, true), null);
  assert.doesNotMatch(`${view.projectStatusLabel} ${view.previewStatusLabel}`, /does not exist/i);
  resetChatStoreForTests();
});
