import test from "node:test";
import assert from "node:assert/strict";
import { VercelToolRunner } from "./VercelToolRunner";
import { VercelExecutionProvider } from "./VercelExecutionProvider";
import {
  __setVercelHelpersForTest,
  type SandboxSessionLike,
  type AgentBrowserCommandResult,
} from "./UpstreamAgentBrowserProvider";

function createMockStore() {
  const events: { runId: string; type: string; data?: any }[] = [];
  const store: any = {
    runs: new Map(),
    events,
    emit(runId: string, type: string, data?: any) {
      events.push({ runId, type, data });
    },
    get(runId: string) {
      return { id: runId, status: "running", events: [] };
    },
    subscribe() {
      return () => {};
    },
  };
  return { store, events };
}

class MockVercelExecutionProvider extends VercelExecutionProvider {
  mockSandbox: any;
  commandsExecuted: string[] = [];

  constructor(mockSandbox: any) {
    super();
    this.mockSandbox = mockSandbox;
  }

  override async startRun(runId: string, projectRoot: string): Promise<any> {
    (this as any).runs.set(runId, {
      projectRoot,
      sandbox: this.mockSandbox,
      sandboxId: "sbx_mock_test",
      cancelled: false,
    });
    return { sandboxId: "sbx_mock_test", persistent: false };
  }

  override getSandbox(_runId: string): any {
    return this.mockSandbox;
  }

  override async executeCommand(_runId: string, command: string): Promise<any> {
    this.commandsExecuted.push(command);
    return { ok: true, output: JSON.stringify({ ok: true, output: "playwright fallback response", meta: {} }), exitCode: 0 };
  }

  override sandboxId(_runId: string): string {
    return "sbx_mock_test";
  }

  override async downloadArtifacts(_runId: string): Promise<{ files: string[] }> {
    return { files: [] };
  }

  override async stopRun(_runId: string): Promise<void> {
    return;
  }
}

function fakeUpstreamHelpers() {
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
      async runAgentBrowserCommand<TJson = unknown>(
        _s: SandboxSessionLike,
        args: readonly string[],
        options?: { session?: string }
      ): Promise<AgentBrowserCommandResult<TJson>> {
        calls.push({ args, session: options?.session });
        const op = args[0] as string;
        let json: any = null;
        if (op === "open" && args[1]) {
          json = {
            url: args[1],
            title: "Example Domain",
            status: 200,
            description: "An example domain description.",
          };
        } else if (op === "snapshot") {
          json = {
            url: "https://example.com",
            title: "Example Domain",
            tree: '- button "Submit" [ref=@e1]\n- link "More information" [ref=@e2]',
            elements: [
              { ref: "@e1", role: "button", name: "Submit" },
              { ref: "@e2", role: "link", name: "More information", href: "https://iana.org" },
            ],
          };
        } else if (op === "screenshot") {
          json = {
            success: true,
            data: {
              id: "shot_123",
              path: "/tmp/orvyn-shot.png",
              mediaType: "image/png",
              width: 1280,
              height: 800,
              sha256: "fake-sha256",
            },
          };
        } else if (op === "click") {
          json = { url: "https://example.com/clicked", message: "Clicked @e1" };
        } else if (op === "fill") {
          json = { url: "https://example.com", message: 'Filled @e1 with "hello"' };
        }
        return {
          command: args.join(" "),
          exitCode: 0,
          json: json as TJson,
          stdout: JSON.stringify(json),
          stderr: "",
        };
      },
    },
  };
}

test.afterEach(() => {
  __setVercelHelpersForTest(null);
  delete process.env.ORVYN_AGENT_BROWSER_UPSTREAM_ENABLED;
  delete process.env.ORVYN_AGENT_BROWSER_UPSTREAM_USERS;
});

test("when enabled and user is allowlisted, browser tools dispatch to UpstreamAgentBrowserProvider", async () => {
  process.env.ORVYN_AGENT_BROWSER_UPSTREAM_ENABLED = "true";
  process.env.ORVYN_AGENT_BROWSER_UPSTREAM_USERS = "rmcknight@virphoneusa.com";

  const fakeSandbox = {
    async runCommand(command: string, args: string[]) {
      assert.equal(command, "base64");
      assert.deepEqual(args, ["-w", "0", "/tmp/orvyn-shot.png"]);
      return { exitCode: 0, stdout: async () => "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", stderr: async () => "" };
    },
  };
  const mockProvider = new MockVercelExecutionProvider(fakeSandbox);
  const runner = new VercelToolRunner(mockProvider);
  const { store, events } = createMockStore();
  const f = fakeUpstreamHelpers();
  __setVercelHelpersForTest(f.helpers);

  const runId = "test_run_upstream_1";
  await runner.start(runId, "/tmp/project", store, {
    tenantId: "tenant_staging",
    organizationId: "org_staging",
    userId: "user_staging_123",
    userEmail: "rmcknight@virphoneusa.com",
    projectId: "proj_1",
    workspaceId: "ws_1",
  });

  try {
    // 1. Dispatch browser_open
    const navResponse = await runner.executeRequest({
      requestId: "req_open_1",
      runId,
      tool: "browser_open",
      arguments: { url: "https://example.com" },
      createdAt: Date.now(),
      timeoutMs: 15000,
    });

    assert.equal(navResponse.ok, true);
    assert.equal(navResponse.exitCode, 0);
    assert.match(navResponse.output || "", /Now at https:\/\/example\.com/);
    assert.match(navResponse.output || "", /Interactive Elements/);
    assert.equal(navResponse.meta?.url, "https://example.com");
    assert.equal(navResponse.meta?.title, "Example Domain");
    assert.equal((navResponse.meta as any)?.interactiveElements?.length, 2);

    // Proves telemetry event browser.ready was emitted with agent-browser-upstream
    const readyEv = events.find((e) => e.type === "browser.ready");
    assert.ok(readyEv, "browser.ready event emitted");
    assert.equal(readyEv.data?.provider, "agent-browser-upstream");
    assert.match(readyEv.data?.browserSessionId, /orvyn-tenant_staging-test_run_upstream_1/);

    // 2. Dispatch browser_click
    const clickResponse = await runner.executeRequest({
      requestId: "req_click_1",
      runId,
      tool: "browser_click",
      arguments: { target: "@e1" },
      createdAt: Date.now(),
      timeoutMs: 15000,
    });
    assert.equal(clickResponse.ok, true);
    assert.equal(f.calls.some((c) => c.args[0] === "click" && c.args[1] === "@e1"), true);

    // 3. Dispatch browser_screenshot
    const shotResponse = await runner.executeRequest({
      requestId: "req_shot_1",
      runId,
      tool: "browser_screenshot",
      arguments: {},
      createdAt: Date.now(),
      timeoutMs: 15000,
    });
    assert.equal(shotResponse.ok, true);
    assert.ok((shotResponse.meta as any)?.screenshot?.b64);
    assert.equal((shotResponse.meta as any)?.screenshot?.mediaType, "image/png");
  } finally {
    // 4. Close session on stop
    await runner.stop(runId);
  }
  assert.equal(f.calls.some((c) => c.args[0] === "close"), true);
});

test("when user is not in allowlist, browser tools do NOT dispatch to upstream adapter", async () => {
  process.env.ORVYN_AGENT_BROWSER_UPSTREAM_ENABLED = "true";
  process.env.ORVYN_AGENT_BROWSER_UPSTREAM_USERS = "rmcknight@virphoneusa.com";

  const fakeSandbox = {
    async runCommand() {
      return { exitCode: 0, stdout: async () => "", stderr: async () => "" };
    },
  };
  const mockProvider = new MockVercelExecutionProvider(fakeSandbox);
  const runner = new VercelToolRunner(mockProvider);
  const { store, events } = createMockStore();
  const f = fakeUpstreamHelpers();
  __setVercelHelpersForTest(f.helpers);

  const runId = "test_run_non_allowlisted";
  await runner.start(runId, "/tmp/project", store, {
    tenantId: "tenant_other",
    organizationId: "org_other",
    userId: "user_admin",
    userEmail: "rmcknight@kernelailabs.com", // production admin account, not in staging allowlist!
    projectId: "proj_1",
    workspaceId: "ws_1",
  });

  try {
    // Dispatch browser_open
    await runner.executeRequest({
      requestId: "req_open_other",
      runId,
      tool: "browser_open",
      arguments: { url: "https://example.com" },
      createdAt: Date.now(),
      timeoutMs: 15000,
    });

    // Upstream helper was NOT called
    assert.equal(f.calls.length, 0, "upstream helper must not be called for non-allowlisted account");
    const readyEv = events.find((e) => e.data?.provider === "agent-browser-upstream");
    assert.equal(readyEv, undefined, "no agent-browser-upstream event emitted for non-allowlisted account");
  } finally {
    await runner.stop(runId);
  }
});

test("when flag is off, browser tools do NOT dispatch to upstream adapter even for allowlisted user", async () => {
  delete process.env.ORVYN_AGENT_BROWSER_UPSTREAM_ENABLED;
  process.env.ORVYN_AGENT_BROWSER_UPSTREAM_USERS = "rmcknight@virphoneusa.com";

  const fakeSandbox = {
    async runCommand() {
      return { exitCode: 0, stdout: async () => "", stderr: async () => "" };
    },
  };
  const mockProvider = new MockVercelExecutionProvider(fakeSandbox);
  const runner = new VercelToolRunner(mockProvider);
  const { store } = createMockStore();
  const f = fakeUpstreamHelpers();
  __setVercelHelpersForTest(f.helpers);

  const runId = "test_run_flag_off";
  await runner.start(runId, "/tmp/project", store, {
    tenantId: "tenant_staging",
    organizationId: "org_staging",
    userId: "user_staging",
    userEmail: "rmcknight@virphoneusa.com",
    projectId: "proj_1",
    workspaceId: "ws_1",
  });

  try {
    await runner.executeRequest({
      requestId: "req_open_off",
      runId,
      tool: "browser_open",
      arguments: { url: "https://example.com" },
      createdAt: Date.now(),
      timeoutMs: 15000,
    });

    assert.equal(f.calls.length, 0, "upstream helper must not be called when flag is off");
  } finally {
    await runner.stop(runId);
  }
});

test("SSRF guard protects upstream browser dispatch before any sandbox command", async () => {
  process.env.ORVYN_AGENT_BROWSER_UPSTREAM_ENABLED = "true";
  process.env.ORVYN_AGENT_BROWSER_UPSTREAM_USERS = "rmcknight@virphoneusa.com";

  const fakeSandbox = {
    async runCommand() {
      return { exitCode: 0, stdout: async () => "", stderr: async () => "" };
    },
  };
  const mockProvider = new MockVercelExecutionProvider(fakeSandbox);
  const runner = new VercelToolRunner(mockProvider);
  const { store } = createMockStore();
  const f = fakeUpstreamHelpers();
  __setVercelHelpersForTest(f.helpers);

  const runId = "test_run_ssrf";
  await runner.start(runId, "/tmp/project", store, {
    tenantId: "tenant_staging",
    organizationId: "org_staging",
    userId: "user_staging",
    userEmail: "rmcknight@virphoneusa.com",
    projectId: "proj_1",
    workspaceId: "ws_1",
  });

  try {
    const res = await runner.executeRequest({
      requestId: "req_ssrf",
      runId,
      tool: "browser_open",
      arguments: { url: "http://169.254.169.254/latest/meta-data/" },
      createdAt: Date.now(),
      timeoutMs: 15000,
    });

    assert.equal(res.ok, false);
    assert.equal(res.exitCode, 1);
    assert.match(res.error || "", /metadata service/i);
    // Verify that the SSRF URL was never passed to any command
    assert.equal(f.calls.some((c) => c.args.some((a) => a.includes("169.254.169.254"))), false);
  } finally {
    await runner.stop(runId);
  }
});
