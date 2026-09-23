import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAuthPayload, clearSession, currentPrincipal, isStagingBackend } from "./sessionContext.ts";

test("logout clears principal and tenant caches", () => {
  const store = new Map<string, string>([["orvyn:chats", "secret-a"], ["orvyn:artifacts", "file-a"]]);
  applyAuthPayload({
    principal: {
      userId: "u1",
      email: "a@example.com",
      name: "A",
      organizationId: "org_a",
      organizationName: "Personal",
      organizationKind: "personal",
      tenantId: "user_a",
      role: "owner",
    },
    organization: { id: "org_a", name: "Personal", kind: "personal", tenantId: "user_a" },
  });
  assert.equal(currentPrincipal()?.tenantId, "user_a");
  clearSession({
    removeItem(key) { store.delete(key); },
  });
  assert.equal(currentPrincipal(), null);
  assert.equal(store.has("orvyn:chats"), false);
  assert.equal(store.has("orvyn:artifacts"), false);
});

test("staging host detection does not assume one tenant", () => {
  assert.equal(isStagingBackend("https://staging.orvyn.virphoneusa.com"), true);
  assert.equal(isStagingBackend("https://orvyn.virphoneusa.com"), false);
});
