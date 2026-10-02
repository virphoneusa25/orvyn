import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalStore } from "../persistence/LocalStore";

test("approval grants persist at session, project, and user-wide scopes", () => {
  const dir = mkdtempSync(join(tmpdir(), "orvyn-approval-grants-"));
  const store = new LocalStore("tenant", dir);
  try {
    store.saveToolApprovalGrant("session", "user-a", "fetch_url", "chat-a", "project-a");
    store.saveToolApprovalGrant("project", "user-a", "browser_open", "chat-a", "project-a");
    store.saveToolApprovalGrant("always", "user-a", "web_search", "chat-a", "project-a");

    assert.deepEqual(store.getToolApprovalGrants("user-a", "chat-a", "project-a").sort(), ["browser_open", "fetch_url", "web_search"]);
    assert.deepEqual(store.getToolApprovalGrants("user-a", "chat-b", "project-a").sort(), ["browser_open", "web_search"]);
    assert.deepEqual(store.getToolApprovalGrants("user-a", "chat-b", "project-b"), ["web_search"]);
    assert.deepEqual(store.getToolApprovalGrants("user-b", "chat-a", "project-a"), []);

    store.close();
    const reopened = new LocalStore("tenant", dir);
    try {
      assert.deepEqual(reopened.getToolApprovalGrants("user-a", "chat-b", "project-a").sort(), ["browser_open", "web_search"]);
      reopened.clearToolApprovalGrants("user-a", "web_search");
      assert.deepEqual(reopened.getToolApprovalGrants("user-a", "chat-b", "project-a"), ["browser_open"]);
    }
    finally { reopened.close(); }
  } finally {
    try { store.close(); } catch { /* already closed before restart check */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
