import assert from "node:assert/strict";
import test from "node:test";
import { activeRunForSession } from "./activeSessionRun";

const runs = [
  { id: "run-active-elsewhere", status: "running" },
  { id: "run-same-chat", status: "awaiting_approval" },
  { id: "run-finished", status: "completed" },
];
const sessionOfRun = (id: string) => ({
  sessionId: id === "run-active-elsewhere" ? "chat-elsewhere" : id === "run-same-chat" ? "chat-current" : "chat-current",
});

test("an active run in another chat does not block this chat", () => {
  assert.equal(activeRunForSession(runs, "chat-current", sessionOfRun)?.id, "run-same-chat");
  assert.equal(activeRunForSession([runs[0]!], "chat-current", sessionOfRun), undefined);
});

test("a conversation without a run can start work while other conversations run", () => {
  assert.equal(activeRunForSession(runs, "chat-new", sessionOfRun), undefined);
  assert.equal(activeRunForSession(runs, null, sessionOfRun), undefined);
});

test("settled runs do not block their conversation", () => {
  assert.equal(activeRunForSession([runs[2]!], "chat-current", sessionOfRun), undefined);
});
