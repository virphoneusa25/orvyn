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
  setSessionMirror,
  type BackendMessageLike,
} from "./chatSession.ts";
import { restoreWorkSessionFromBackend, type SessionGet } from "./sessionRestore.ts";

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
