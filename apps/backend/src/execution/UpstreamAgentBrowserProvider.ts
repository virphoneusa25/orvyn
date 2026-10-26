// apps/backend/src/execution/UpstreamAgentBrowserProvider.ts
//
// BrowserProvider backed by the official Vercel Labs agent-browser CLI,
// executed inside an ORVYN execution sandbox that already exists.
//
// Why it attaches rather than provisions:
//   @agent-browser/sandbox exposes installAgentBrowserInVercelSandbox(sandbox, …)
//   and runAgentBrowserCommand(sandbox, args, …), both of which take an existing
//   session as their first argument. The session is a structural interface —
//   { runCommand(command, args), snapshot(), stop() } — so ORVYN's own sandbox
//   handle satisfies it without adapting. createAgentBrowserSandbox() is NOT
//   used: it would provision a second sandbox and bill for it twice.
//
// Loading: @agent-browser/sandbox is ESM-only ("type": "module", exports expose
// only an `import` condition). This backend compiles to CommonJS, where TS
// rewrites a plain `import()` into `require()` and the load fails at runtime.
// loadVercelHelpers() therefore uses an indirect dynamic import that survives
// downlevelling. See the note on that function.
//
// Scope: this file adds a provider. It changes no tool name, no tool schema,
// no routing, no permission check, and no UI.

import {
  validateBrowserUrl,
  type ActionResult,
  type BrowserProvider,
  type BrowserSessionContext,
  type BrowserTab,
  type BrowserTarget,
  type InteractiveElement,
  type NavigationResult,
  type PageSnapshot,
  type ScreenshotResult,
  type ScrollOptions,
} from "./BrowserProvider";

/** The subset of a Vercel Sandbox session the upstream helpers require. */
export interface SandboxSessionLike {
  runCommand(command: string, args: readonly string[]): Promise<{
    readonly exitCode?: number;
    stdout(): Promise<string>;
    stderr(): Promise<string>;
  }>;
}

export function createSandboxSessionLike(
  sandbox: any,
  fallbackCommand?: (cmd: string) => Promise<{ ok: boolean; output: string; exitCode?: number }>,
): SandboxSessionLike {
  return {
    async runCommand(command: string, args: readonly string[]) {
      if (sandbox && typeof sandbox.runCommand === "function") {
        try {
          const res = await sandbox.runCommand(command, args as string[]);
          if (res && (typeof res.stdout === "function" || typeof res.stdout === "string")) {
            return {
              exitCode: typeof res.exitCode === "number" ? res.exitCode : 0,
              stdout: async () => (typeof res.stdout === "function" ? res.stdout() : String(res.stdout ?? "")),
              stderr: async () => (typeof res.stderr === "function" ? res.stderr() : String(res.stderr ?? "")),
            };
          }
        } catch {
          try {
            const res = await sandbox.runCommand({ cmd: command, args: args as string[] });
            return {
              exitCode: typeof res.exitCode === "number" ? res.exitCode : 0,
              stdout: async () => (typeof res.stdout === "function" ? res.stdout() : String(res.stdout ?? "")),
              stderr: async () => (typeof res.stderr === "function" ? res.stderr() : String(res.stderr ?? "")),
            };
          } catch {
            /* fall through to fallbackCommand */
          }
        }
      }
      if (fallbackCommand) {
        const full = [command, ...args].join(" ");
        const res = await fallbackCommand(full);
        return {
          exitCode: res.exitCode ?? (res.ok ? 0 : 1),
          stdout: async () => (res.ok ? res.output : ""),
          stderr: async () => (!res.ok ? res.output : ""),
        };
      }
      throw new Error(`Cannot execute "${command}": no sandbox session available.`);
    },
  };
}

export interface AgentBrowserCommandResult<TJson = unknown> {
  readonly command: string;
  readonly exitCode: number;
  readonly json: TJson | null;
  readonly stderr: string;
  readonly stdout: string;
}

interface VercelHelpers {
  installAgentBrowserInVercelSandbox(
    sandbox: SandboxSessionLike,
    options?: { installBrowser?: boolean; installSpec?: string; installSystemDependencies?: boolean; onStep?: (e: { step: string; status: string; elapsed?: number }) => void },
  ): Promise<AgentBrowserCommandResult[]>;
  runAgentBrowserCommand<TJson = unknown>(
    sandbox: SandboxSessionLike,
    args: readonly string[],
    options?: { json?: boolean; session?: string; stepLabel?: string },
  ): Promise<AgentBrowserCommandResult<TJson>>;
}

/**
 * Pinned deliberately. agent-browser ships frequently; an unpinned range would
 * let a release land in a customer sandbox with no review. Bump this together
 * with the package.json entry, never independently.
 */
export const UPSTREAM_AGENT_BROWSER_SPEC = "agent-browser@0.39.0";

/** Environment flag. Off unless explicitly set; see isUpstreamEnabledFor(). */
export const UPSTREAM_FLAG = "ORVYN_AGENT_BROWSER_UPSTREAM_ENABLED";
/** Comma-separated identities allowed to use the upstream provider while it is in staging. */
export const UPSTREAM_ALLOWLIST = "ORVYN_AGENT_BROWSER_UPSTREAM_USERS";

/**
 * Two gates, both required: the flag must be on AND the identity must be in the
 * allowlist. An empty allowlist grants nobody, so turning the flag on by itself
 * cannot widen access — including in production.
 */
export function isUpstreamEnabledFor(
  identity: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const flag = String(env[UPSTREAM_FLAG] ?? "").trim().toLowerCase();
  if (flag !== "1" && flag !== "true") return false;
  const allowed = String(env[UPSTREAM_ALLOWLIST] ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.length) return false;
  const who = String(identity ?? "").trim().toLowerCase();
  return who.length > 0 && allowed.includes(who);
}

/**
 * ESM-only module loaded from a CommonJS build.
 *
 * `new Function("s", "return import(s)")` keeps a genuine dynamic import in the
 * emitted JavaScript: TypeScript cannot see it and so cannot rewrite it into a
 * require(). Remove this indirection only once the backend itself emits ESM.
 */
let helpersPromise: Promise<VercelHelpers> | null = null;
export function loadVercelHelpers(): Promise<VercelHelpers> {
  if (!helpersPromise) {
    const dynamicImport = new Function("specifier", "return import(specifier);") as (s: string) => Promise<unknown>;
    helpersPromise = dynamicImport("@agent-browser/sandbox/vercel").then((mod) => mod as VercelHelpers);
  }
  return helpersPromise;
}

/** Test seam: inject helpers instead of loading the real package. */
export function __setVercelHelpersForTest(h: VercelHelpers | null): void {
  helpersPromise = h ? Promise.resolve(h) : null;
}

/** `@e1` / `#css` / `text` → a selector the CLI accepts. Coordinates are unsupported upstream. */
function targetToSelector(target: BrowserTarget): { ok: true; selector: string } | { ok: false; error: string } {
  if (typeof target === "string") return { ok: true, selector: target };
  if ("ref" in target && target.ref) return { ok: true, selector: target.ref };
  if ("selector" in target && target.selector) return { ok: true, selector: target.selector };
  if ("x" in target && "y" in target) {
    return { ok: false, error: "agent-browser targets elements by ref or selector, not coordinates. Take a snapshot and use the @ref." };
  }
  return { ok: false, error: "Unrecognised browser target." };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** Upstream reports elements as refs with a role and an accessible name. */
function toInteractiveElements(raw: unknown): InteractiveElement[] {
  const list = Array.isArray(raw) ? raw : [];
  return list.map((entry, i) => {
    const e = asRecord(entry);
    return {
      ref: str(e.ref, `@e${i + 1}`),
      role: str(e.role, "element"),
      name: str(e.name ?? e.text),
      value: typeof e.value === "string" ? e.value : undefined,
      selector: typeof e.selector === "string" ? e.selector : undefined,
      href: typeof e.href === "string" ? e.href : undefined,
    };
  });
}

export class UpstreamAgentBrowserProvider implements BrowserProvider {
  readonly name = "agent-browser-upstream";

  private sandbox: SandboxSessionLike;
  private helpers: VercelHelpers | null = null;
  private sessionName = "";
  private installed = false;
  private lastUrl = "";
  private closed = false;

  constructor(sandbox: SandboxSessionLike) {
    this.sandbox = sandbox;
  }

  private async run<TJson = unknown>(args: readonly string[], json = true): Promise<AgentBrowserCommandResult<TJson>> {
    if (!this.helpers) this.helpers = await loadVercelHelpers();
    return this.helpers.runAgentBrowserCommand<TJson>(this.sandbox, args, { json, session: this.sessionName || undefined });
  }

  async startSession(context: BrowserSessionContext): Promise<{ ok: boolean; sessionId: string; error?: string }> {
    // Session names are namespaced per tenant AND per run, so two tenants can
    // never address one another's browser session inside a shared sandbox.
    this.sessionName = `orvyn-${context.tenantId}-${context.runId}`;
    this.closed = false;
    try {
      this.helpers = await loadVercelHelpers();
      if (!this.installed) {
        try {
          await this.helpers.installAgentBrowserInVercelSandbox(this.sandbox, {
            installSpec: UPSTREAM_AGENT_BROWSER_SPEC,
            installBrowser: true,
            installSystemDependencies: true,
          });
        } catch (err: any) {
          const msg = String(err?.message ?? err) + " " + String(err?.stderr ?? "");
          if (msg.includes("dnf: command not found") || msg.includes("sudo: dnf") || msg.includes("dnf")) {
            await this.helpers.installAgentBrowserInVercelSandbox(this.sandbox, {
              installSpec: UPSTREAM_AGENT_BROWSER_SPEC,
              installBrowser: false,
              installSystemDependencies: false,
            });
            await this.sandbox.runCommand("agent-browser", ["install", "--with-deps"]);
          } else {
            throw err;
          }
        }
        this.installed = true;
      }
      // `open` with no URL launches the browser and stays on about:blank.
      const result = await this.run(["open"]);
      if (result.exitCode !== 0) {
        return { ok: false, sessionId: this.sessionName, error: result.stderr || `agent-browser open exited ${result.exitCode}` };
      }
      return { ok: true, sessionId: this.sessionName };
    } catch (err: any) {
      return { ok: false, sessionId: this.sessionName, error: `Could not start the upstream browser: ${err?.message ?? String(err)}` };
    }
  }

  async navigate(url: string, timeoutMs?: number): Promise<NavigationResult> {
    // SSRF validation runs here, before the URL reaches the sandbox. The guard
    // is ORVYN's, not upstream's, and it is not delegated.
    const checked = validateBrowserUrl(url);
    if (!checked.ok) {
      return { ok: false, url, title: "", error: checked.error };
    }
    try {
      const args = ["open", checked.normalizedUrl];
      if (timeoutMs && Number.isFinite(timeoutMs)) args.push("--timeout", String(Math.max(1000, Math.floor(timeoutMs))));
      const result = await this.run(args);
      const data = asRecord(result.json);
      const finalUrl = str(data.url, checked.normalizedUrl);
      this.lastUrl = finalUrl;
      if (result.exitCode !== 0) {
        return { ok: false, url: finalUrl, title: str(data.title), status: typeof data.status === "number" ? data.status : undefined, error: result.stderr || `Navigation failed (exit ${result.exitCode}).` };
      }
      return {
        ok: true,
        url: finalUrl,
        title: str(data.title),
        status: typeof data.status === "number" ? data.status : undefined,
        metaDesc: typeof data.description === "string" ? data.description : undefined,
      };
    } catch (err: any) {
      return { ok: false, url, title: "", error: err?.message ?? String(err) };
    }
  }

  async snapshot(interactiveOnly = true): Promise<PageSnapshot> {
    const base: PageSnapshot = { url: this.lastUrl, title: "", interactiveElements: [], consoleErrors: [], networkErrors: [] };
    try {
      const args = ["snapshot"];
      if (interactiveOnly) args.push("--interactive");
      const result = await this.run(args);
      const data = asRecord(result.json);
      const url = str(data.url, this.lastUrl);
      this.lastUrl = url || this.lastUrl;

      // Console and network errors come from separate upstream commands. A
      // failure to collect them must not discard the snapshot itself, so they
      // are gathered best-effort and reported empty if unavailable.
      const [consoleErrors, networkErrors] = await Promise.all([
        this.collectConsoleErrors(),
        this.collectNetworkErrors(),
      ]);

      return {
        url,
        title: str(data.title),
        accessibilityTree: typeof data.tree === "string" ? data.tree : (typeof data.snapshot === "string" ? data.snapshot : result.stdout || undefined),
        interactiveElements: toInteractiveElements(data.elements ?? data.refs),
        consoleErrors,
        networkErrors,
      };
    } catch {
      return base;
    }
  }

  private async collectConsoleErrors(): Promise<string[]> {
    try {
      const r = await this.run(["console", "--level", "error"]);
      const data = asRecord(r.json);
      const list = Array.isArray(data.messages) ? data.messages : Array.isArray(r.json) ? (r.json as unknown[]) : [];
      return list.map((m) => (typeof m === "string" ? m : str(asRecord(m).text))).filter(Boolean);
    } catch {
      return [];
    }
  }

  private async collectNetworkErrors(): Promise<Array<{ method: string; url: string; status: number; error?: string }>> {
    try {
      const r = await this.run(["errors"]);
      const data = asRecord(r.json);
      const list = Array.isArray(data.requests) ? data.requests : Array.isArray(r.json) ? (r.json as unknown[]) : [];
      return list.map((entry) => {
        const e = asRecord(entry);
        return {
          method: str(e.method, "GET"),
          url: str(e.url),
          status: typeof e.status === "number" ? e.status : 0,
          error: typeof e.error === "string" ? e.error : undefined,
        };
      }).filter((e) => e.url);
    } catch {
      return [];
    }
  }

  async screenshot(fullPage = false): Promise<ScreenshotResult> {
    const empty: ScreenshotResult = { ok: false, screenshotId: "", mediaType: "image/png", width: 0, height: 0 };
    try {
      // --base64 keeps the image in the command result; writing to the sandbox
      // filesystem would need a second round trip to read it back out.
      const args = ["screenshot", "--base64"];
      if (fullPage) args.push("--full");
      const result = await this.run(args);
      const data = asRecord(result.json);
      const b64 = str(data.base64 ?? data.data ?? data.image);
      if (result.exitCode !== 0 || !b64) {
        return { ...empty, error: result.stderr || "agent-browser returned no image data." };
      }
      return {
        ok: true,
        screenshotId: str(data.id, `${this.sessionName}-${Date.now()}`),
        b64,
        mediaType: str(data.mediaType, "image/png"),
        width: typeof data.width === "number" ? data.width : 0,
        height: typeof data.height === "number" ? data.height : 0,
        sha256: typeof data.sha256 === "string" ? data.sha256 : undefined,
      };
    } catch (err: any) {
      return { ...empty, error: err?.message ?? String(err) };
    }
  }

  async click(target: BrowserTarget): Promise<ActionResult> {
    const sel = targetToSelector(target);
    if (!sel.ok) return { ok: false, error: sel.error };
    return this.action(["click", sel.selector]);
  }

  async fill(target: BrowserTarget, value: string): Promise<ActionResult> {
    const sel = targetToSelector(target);
    if (!sel.ok) return { ok: false, error: sel.error };
    return this.action(["fill", sel.selector, value]);
  }

  async scroll(options: ScrollOptions): Promise<ActionResult> {
    const dy = options.deltaY ?? 0;
    const dx = options.deltaX ?? 0;
    // Upstream scrolls by direction plus a pixel count, not a signed delta.
    const [direction, pixels] = dy !== 0
      ? [dy > 0 ? "down" : "up", Math.abs(dy)]
      : [dx > 0 ? "right" : "left", Math.abs(dx)];
    if (!pixels) return { ok: true, output: "No scroll distance given.", currentUrl: this.lastUrl };
    return this.action(["scroll", direction, String(Math.round(pixels))]);
  }

  private async action(args: readonly string[]): Promise<ActionResult> {
    try {
      const result = await this.run(args);
      const data = asRecord(result.json);
      const currentUrl = str(data.url, this.lastUrl);
      if (currentUrl) this.lastUrl = currentUrl;
      if (result.exitCode !== 0) {
        return { ok: false, error: result.stderr || `${args[0]} failed (exit ${result.exitCode}).`, currentUrl };
      }
      return { ok: true, output: str(data.message, result.stdout.trim()), currentUrl };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err), currentUrl: this.lastUrl };
    }
  }

  async getTabs(): Promise<BrowserTab[]> {
    try {
      const result = await this.run(["tab", "list"]);
      const data = asRecord(result.json);
      const list = Array.isArray(data.tabs) ? data.tabs : Array.isArray(result.json) ? (result.json as unknown[]) : [];
      return list.map((entry, index) => {
        const t = asRecord(entry);
        return {
          id: typeof t.id === "string" || typeof t.id === "number" ? t.id : index,
          index: typeof t.index === "number" ? t.index : index,
          url: str(t.url),
          title: str(t.title),
          active: t.active === true,
        };
      });
    } catch {
      return [];
    }
  }

  async switchTab(index: number): Promise<ActionResult> {
    return this.action(["tab", "select", String(index)]);
  }

  async closeSession(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      // Cleanup must not throw: a failed close would otherwise mask the real
      // error that ended the run, and leave the caller unable to settle costs.
      await this.run(["close"], false);
    } catch {
      /* session already gone */
    }
  }
}
