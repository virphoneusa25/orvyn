import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INITIAL_FACTS,
  describeConnection,
  deriveCloudConnectionState,
  heroStatusLine,
  reduceConnection,
  type ConnectionFacts,
} from "./connectionState.ts";

function signedIn(over: Partial<ConnectionFacts> = {}): ConnectionFacts {
  return {
    ...INITIAL_FACTS,
    accountState: "signed-in",
    accountName: "Royce",
    accountEmail: "royce@virphoneusa.com",
    cloudTarget: true,
    localMode: false,
    localDisplayName: "Royce",
    ...over,
  };
}

test("A. signed out + local engine ready does not say Synced", () => {
  const facts = { ...INITIAL_FACTS, localDisplayName: "Royce", localEngineState: "ready" as const };
  const view = describeConnection(facts);
  assert.equal(deriveCloudConnectionState(facts), "local");
  assert.equal(view.titlePrimary, "Local Mode");
  assert.equal(view.titleSecondary, "Connect account");
  assert.equal(view.userName, "Royce");
  assert.equal(view.userSubtitle, "Local workspace");
  assert.equal(view.modeLabel, "Local");
  assert.deepEqual(
    view.indicators.map((i) => i.label),
    ["Local Engine Ready", "ORVYN Cloud Offline"]
  );
  assert.equal(view.indicators[0].tone, "on");
  assert.equal(view.indicators[1].tone, "off");
  assert.equal(view.userSubtitle.includes("Synced"), false);
});

test("B. signed in + cloud connecting", () => {
  const facts = signedIn({ backendState: "connecting", syncState: "syncing" });
  const view = describeConnection(facts);
  assert.equal(view.state, "connecting");
  assert.equal(view.titlePrimary, "ORVYN Cloud");
  assert.equal(view.titleSecondary, "Connecting…");
  assert.equal(view.userSubtitle, "Connecting to cloud");
  assert.equal(view.indicators.some((i) => i.label === "ORVYN Cloud Connecting" && i.tone === "pending"), true);
  assert.equal(view.indicators.some((i) => i.label === "Local Engine Ready"), true);
});

test("C. signed in + cloud online before sync completes", () => {
  const facts = signedIn({ backendState: "online", syncState: "syncing", workerOnlineCount: 0 });
  const view = describeConnection(facts);
  assert.equal(view.state, "cloud-online");
  assert.equal(view.titlePrimary, "ORVYN Cloud");
  assert.equal(view.titleSecondary, "Royce");
  assert.equal(view.showTitleDot, true);
  assert.equal(view.userSubtitle, "Connected");
  assert.deepEqual(
    view.indicators.map((i) => i.label),
    ["ORVYN Cloud Connected", "Local Engine Ready"]
  );
  assert.equal(view.userSubtitle === "Synced", false);
});

test("D. signed in + synced, and H. worker online is its own indicator", () => {
  const facts = signedIn({ backendState: "online", syncState: "synced", workerOnlineCount: 1 });
  const view = describeConnection(facts);
  assert.equal(view.state, "cloud-synced");
  assert.equal(view.userSubtitle, "Synced");
  assert.equal(view.modeLabel, "Cloud");
  assert.deepEqual(
    view.indicators.map((i) => i.label),
    ["ORVYN Cloud Connected", "Synced", "1 worker online"]
  );
});

test("E. cloud offline keeps the local engine ready", () => {
  const facts = signedIn({ backendState: "offline", syncState: "error" });
  const view = describeConnection(facts);
  assert.equal(view.state, "cloud-offline");
  assert.equal(view.titleSecondary, "Offline");
  assert.equal(view.userSubtitle, "Cloud offline");
  assert.equal(view.indicators[0].label, "ORVYN Cloud Offline");
  assert.equal(view.indicators[1].label, "Local Engine Ready");
  assert.equal(view.indicators[1].tone, "on");
});

test("F. session expired", () => {
  const facts = signedIn({ accountState: "expired", backendState: "offline", syncState: "error" });
  const view = describeConnection(facts);
  assert.equal(view.state, "session-expired");
  assert.equal(view.titlePrimary, "Session expired");
  assert.equal(view.titleSecondary, "Sign in again →");
  assert.equal(view.userSubtitle, "Session expired");
  assert.equal(view.indicators[0].label, "Cloud authentication required");
  assert.equal(view.indicators[1].label, "Local Engine Ready");
});

test("G. worker offline while cloud is online does not claim a worker", () => {
  const facts = signedIn({ backendState: "online", syncState: "synced", workerOnlineCount: 0 });
  const view = describeConnection(facts);
  assert.equal(view.state, "cloud-synced");
  assert.equal(view.indicators.some((i) => /worker/i.test(i.label)), false);
  assert.equal(view.indicators.some((i) => i.label === "ORVYN Cloud Connected"), true);
});

test("hero: offline missions need a connection; cloud sign-in does not", () => {
  const missions = Array.from({ length: 7 }, () => ({ tone: "blocked" }));
  const local = { ...INITIAL_FACTS, localDisplayName: "Royce" };
  assert.equal(
    heroStatusLine(local, missions),
    "7 missions are waiting on you — 7 need a connection."
  );
  const online = signedIn({ backendState: "online", syncState: "synced", workerOnlineCount: 1 });
  assert.equal(heroStatusLine(online, missions), "7 missions ready · 1 worker online");
  assert.equal(
    heroStatusLine(online, []),
    "ORVYN Cloud connected · 1 worker available"
  );
  assert.equal(heroStatusLine(online, []).includes("need a connection"), false);
});

test("stored session validates through connecting before Synced", () => {
  let facts = reduceConnection(INITIAL_FACTS, { type: "config", cloudTarget: true, hasSession: true });
  assert.equal(deriveCloudConnectionState(facts), "connecting");
  assert.equal(describeConnection(facts).userSubtitle === "Synced", false);

  facts = reduceConnection(facts, { type: "session-valid", name: "Royce", email: "royce@virphoneusa.com" });
  assert.equal(facts.accountState, "signed-in");
  assert.equal(deriveCloudConnectionState(facts), "connecting");

  facts = reduceConnection(facts, { type: "backend", state: "online" });
  assert.equal(deriveCloudConnectionState(facts), "cloud-online");
  assert.equal(describeConnection(facts).userSubtitle, "Connected");

  facts = reduceConnection(facts, { type: "workers", online: 1 });
  assert.equal(deriveCloudConnectionState(facts), "cloud-synced");
  assert.equal(describeConnection(facts).userSubtitle, "Synced");
});

test("localhost heartbeat does not mark cloud synced", () => {
  let facts = reduceConnection(INITIAL_FACTS, { type: "backend", state: "online" });
  assert.equal(deriveCloudConnectionState(facts), "local");
  assert.equal(describeConnection(facts).userSubtitle, "Local workspace");
});

test("websocket drop and reconnect", () => {
  let facts = signedIn({ backendState: "online", syncState: "synced", workerOnlineCount: 1 });
  facts = reduceConnection(facts, { type: "backend", state: "offline" });
  assert.equal(deriveCloudConnectionState(facts), "cloud-offline");
  assert.equal(describeConnection(facts).indicators.some((i) => i.label === "Local Engine Ready"), true);

  facts = reduceConnection(facts, { type: "backend", state: "connecting" });
  assert.equal(deriveCloudConnectionState(facts), "connecting");

  facts = reduceConnection(facts, { type: "backend", state: "online" });
  facts = reduceConnection(facts, { type: "workers", online: 1 });
  assert.equal(deriveCloudConnectionState(facts), "cloud-synced");
});

test("/auth/me rejection expires the session and stops claiming cloud", () => {
  let facts = signedIn({ backendState: "online", syncState: "synced" });
  facts = reduceConnection(facts, { type: "session-invalid" });
  assert.equal(facts.accountState, "expired");
  assert.equal(deriveCloudConnectionState(facts), "session-expired");
  facts = reduceConnection(facts, { type: "backend", state: "online" });
  assert.equal(facts.backendState, "offline");
  assert.equal(deriveCloudConnectionState(facts), "session-expired");
});

test("logout returns to local mode without inventing Synced", () => {
  let facts = signedIn({ backendState: "online", syncState: "synced", workerOnlineCount: 2 });
  facts = reduceConnection(facts, { type: "signed-out" });
  const view = describeConnection(facts);
  assert.equal(view.state, "local");
  assert.equal(view.titlePrimary, "Local Mode");
  assert.equal(view.userSubtitle, "Local workspace");
  assert.equal(facts.workerOnlineCount, 0);
  assert.equal(facts.accountEmail, null);
});

test("workspace label is not fabricated", () => {
  const view = describeConnection(signedIn({ workspaceName: null }));
  assert.equal(view.workspaceLabel, "Local workspace");
  const named = describeConnection(signedIn({ workspaceName: "VirPhone" }));
  assert.equal(named.workspaceLabel, "VirPhone");
});
