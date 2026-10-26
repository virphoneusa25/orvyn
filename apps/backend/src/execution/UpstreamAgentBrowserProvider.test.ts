import assert from "node:assert/strict";
import test from "node:test";
import {
  UPSTREAM_AGENT_BROWSER_SPEC,
  UpstreamAgentBrowserProvider,
  __setVercelHelpersForTest,
  isUpstreamEnabledFor,
  type SandboxSessionLike,
} from "./UpstreamAgentBrowserProvider";

/** Records every command the adapter sends, so we can assert on the real argv. */
function fakeHelpers(replies: Record<string, { exitCode?: number; json?: unknown; stdout?: string; stderr?: string }> = {}) {
  const calls: { args: readonly string[]; session?: string }[] = [];
  const installs: unknown[] = [];
  return {
    calls,
    installs,
    helpers: {
      async installAgentBrowserInVercelSandbox(_s: SandboxSessionLike, options?: unknown) {
        installs.push(options);
        return [];
      },
      async runAgentBrowserCommand(_s: SandboxSessionLike, args: readonly string[], options?: { session?: string }) {
        calls.push({ args, session: options?.session });
        const reply = replies[args[0] as string] ?? {};
        return {
          command: args.join(" "),
          exitCode: reply.exitCode ?? 0,
          json: reply.json ?? null,
          stdout: reply.stdout ?? "",
          stderr: reply.stderr ?? "",
        };
      },
    },
  };
}

const sandbox: SandboxSessionLike = {
  async runCommand() {
    throw new Error("the adapter must go through the upstream helpers, never runCommand directly");
  },
};

test.afterEach(() => __setVercelHelpersForTest(null));

test("the feature flag is off by default and an empty allowlist grants nobody", () => {
  assert.equal(isUpstreamEnabledFor("rmcknight@virphoneusa.com", {}), false);
  assert.equal(isUpstreamEnabledFor("rmcknight@virphoneusa.com", { ORVYN_AGENT_BROWSER_UPSTREAM_ENABLED: "1" }), false);
  assert.equal(isUpstreamEnabledFor("", { ORVYN_AGENT_BROWSER_UPSTREAM_ENABLED: "1", ORVYN_AGENT_BROWSER_UPSTREAM_USERS: "rmcknight@virphoneusa.com" }), false);
});

test("the flag and the allowlist are both required, and the allowlist is exact", () => {
  const env = { ORVYN_AGENT_BROWSER_UPSTREAM_ENABLED: "true", ORVYN_AGENT_BROWSER_UPSTREAM_USERS: "rmcknight@virphoneusa.com" };
  assert.equal(isUpstreamEnabledFor("rmcknight@virphoneusa.com", env), true);
  assert.equal(isUpstreamEnabledFor("RMcKnight@VirPhoneUSA.com", env), true, "identity match is case-insensitive");
  assert.equal(isUpstreamEnabledFor("someone@else.com", env), false);
  assert.equal(isUpstreamEnabledFor("rmcknight@virphoneusa.com", { ...env, ORVYN_AGENT_BROWSER_UPSTREAM_ENABLED: "0" }), false);
});

test("startSession installs the pinned spec into the sandbox it was given", async () => {
  const f = fakeHelpers();
  __setVercelHelpersForTest(f.helpers);
  const p = new UpstreamAgentBrowserProvider(sandbox);
  const started = await p.startSession({ runId: "run1", tenantId: "tenantA" });

  assert.equal(started.ok, true);
  assert.equal(f.installs.length, 1, "installs once");
  assert.equal((f.installs[0] as { installSpec: string }).installSpec, UPSTREAM_AGENT_BROWSER_SPEC);
  assert.deepEqual(f.calls[0]?.args, ["open"], "launches the browser without navigating");
});

test("the session name isolates tenants and runs from each other", async () => {
  const f = fakeHelpers();
  __setVercelHelpersForTest(f.helpers);
  const a = new UpstreamAgentBrowserProvider(sandbox);
  const b = new UpstreamAgentBrowserProvider(sandbox);
  const first = await a.startSession({ runId: "run1", tenantId: "tenantA" });
  const second = await b.startSession({ runId: "run1", tenantId: "tenantB" });

  assert.notEqual(first.sessionId, second.sessionId);
  assert.match(first.sessionId, /tenantA/);
  assert.match(second.sessionId, /tenantB/);
  assert.equal(f.calls[0]?.session, first.sessionId, "every command carries the namespaced session");
});

test("SSRF validation runs before the URL reaches the sandbox", async () => {
  const f = fakeHelpers();
  __setVercelHelpersForTest(f.helpers);
  const p = new UpstreamAgentBrowserProvider(sandbox);
  await p.startSession({ runId: "run1", tenantId: "t" });
  const before = f.calls.length;

  for (const blocked of ["http://169.254.169.254/latest/meta-data/", "http://localhost:8080", "http://10.0.0.5", "file:///etc/passwd"]) {
    const result = await p.navigate(blocked);
    assert.equal(result.ok, false, `${blocked} must be refused`);
    assert.ok(result.error, "the refusal states a reason");
  }
  assert.equal(f.calls.length, before, "no blocked URL was ever sent to the sandbox");
});

test("navigate reports the resolved URL and surfaces a non-zero exit as a failure", async () => {
  const ok = fakeHelpers({ open: { json: { url: "https://example.com/home", title: "Home", status: 200 } } });
  __setVercelHelpersForTest(ok.helpers);
  const p = new UpstreamAgentBrowserProvider(sandbox);
  await p.startSession({ runId: "r", tenantId: "t" });
  const good = await p.navigate("example.com");
  assert.equal(good.ok, true);
  assert.equal(good.url, "https://example.com/home");
  assert.equal(good.status, 200);

  const bad = fakeHelpers({ open: { exitCode: 1, stderr: "net::ERR_NAME_NOT_RESOLVED" } });
  __setVercelHelpersForTest(bad.helpers);
  const q = new UpstreamAgentBrowserProvider(sandbox);
  await q.startSession({ runId: "r", tenantId: "t" });
  const failed = await q.navigate("https://does-not-exist.example");
  assert.equal(failed.ok, false, "a failed navigation is never reported as ok");
  assert.match(failed.error ?? "", /ERR_NAME_NOT_RESOLVED/);
});

test("snapshot maps upstream refs into ORVYN interactive elements", async () => {
  const f = fakeHelpers({
    snapshot: { json: { url: "https://example.com", title: "Example", tree: "- button @e1", elements: [{ ref: "@e1", role: "button", name: "Get started", href: "/start" }] } },
    console: { json: { messages: [{ text: "Uncaught TypeError" }] } },
    errors: { json: { requests: [{ method: "GET", url: "https://example.com/missing.js", status: 404 }] } },
  });
  __setVercelHelpersForTest(f.helpers);
  const p = new UpstreamAgentBrowserProvider(sandbox);
  await p.startSession({ runId: "r", tenantId: "t" });

  const snap = await p.snapshot(true);
  assert.equal(snap.title, "Example");
  assert.deepEqual(snap.interactiveElements, [{ ref: "@e1", role: "button", name: "Get started", value: undefined, selector: undefined, href: "/start" }]);
  assert.deepEqual(snap.consoleErrors, ["Uncaught TypeError"]);
  assert.equal(snap.networkErrors[0]?.status, 404);
});

test("a snapshot survives console and network collection failing", async () => {
  const f = fakeHelpers({
    snapshot: { json: { url: "https://example.com", title: "Example", elements: [] } },
    console: { exitCode: 1, stderr: "unsupported" },
    errors: { exitCode: 1, stderr: "unsupported" },
  });
  __setVercelHelpersForTest(f.helpers);
  const p = new UpstreamAgentBrowserProvider(sandbox);
  await p.startSession({ runId: "r", tenantId: "t" });

  const snap = await p.snapshot();
  assert.equal(snap.title, "Example", "the page is still reported");
  assert.deepEqual(snap.consoleErrors, [], "missing extras are empty, not invented");
});

test("click and fill accept refs and selectors but refuse coordinates", async () => {
  const f = fakeHelpers({ click: { json: { url: "https://example.com/next" } }, fill: { json: {} } });
  __setVercelHelpersForTest(f.helpers);
  const p = new UpstreamAgentBrowserProvider(sandbox);
  await p.startSession({ runId: "r", tenantId: "t" });

  assert.equal((await p.click({ ref: "@e2" })).ok, true);
  assert.deepEqual(f.calls.at(-1)?.args, ["click", "@e2"]);

  assert.equal((await p.fill({ selector: "#email" }, "a@b.com")).ok, true);
  assert.deepEqual(f.calls.at(-1)?.args, ["fill", "#email", "a@b.com"]);

  const byPoint = await p.click({ x: 10, y: 20 });
  assert.equal(byPoint.ok, false, "coordinates are not supported upstream");
  assert.match(byPoint.error ?? "", /ref or selector/);
});

test("scroll converts a signed delta into the direction and distance upstream expects", async () => {
  const f = fakeHelpers({ scroll: { json: {} } });
  __setVercelHelpersForTest(f.helpers);
  const p = new UpstreamAgentBrowserProvider(sandbox);
  await p.startSession({ runId: "r", tenantId: "t" });

  await p.scroll({ deltaY: 400 });
  assert.deepEqual(f.calls.at(-1)?.args, ["scroll", "down", "400"]);
  await p.scroll({ deltaY: -250 });
  assert.deepEqual(f.calls.at(-1)?.args, ["scroll", "up", "250"]);
  await p.scroll({ deltaX: -120 });
  assert.deepEqual(f.calls.at(-1)?.args, ["scroll", "left", "120"]);
});

test("a screenshot with no image data is a failure, not an empty success", async () => {
  const f = fakeHelpers({ screenshot: { json: {} } });
  __setVercelHelpersForTest(f.helpers);
  const p = new UpstreamAgentBrowserProvider(sandbox);
  await p.startSession({ runId: "r", tenantId: "t" });

  const shot = await p.screenshot(true);
  assert.equal(shot.ok, false);
  assert.ok(shot.error, "the reason is reported rather than an empty ok result");
});

test("closeSession is idempotent and never throws", async () => {
  const f = fakeHelpers({ close: { exitCode: 1, stderr: "already gone" } });
  __setVercelHelpersForTest(f.helpers);
  const p = new UpstreamAgentBrowserProvider(sandbox);
  await p.startSession({ runId: "r", tenantId: "t" });

  await p.closeSession();
  const after = f.calls.length;
  await p.closeSession();
  assert.equal(f.calls.length, after, "closing twice sends one close");
});

test("the adapter never provisions its own sandbox", async () => {
  // createAgentBrowserSandbox would bill a second sandbox. The fake helpers
  // expose only install and run; if the adapter reached for anything else it
  // would throw here rather than silently double-provision.
  const f = fakeHelpers({ open: { json: {} } });
  __setVercelHelpersForTest(f.helpers);
  const p = new UpstreamAgentBrowserProvider(sandbox);
  const started = await p.startSession({ runId: "r", tenantId: "t" });
  assert.equal(started.ok, true);
  assert.ok(f.calls.every((c) => c.args[0] !== "sandbox"), "no sandbox provisioning command");
});
