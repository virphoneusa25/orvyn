import { CONVERSATION_STYLE } from "./conversationStyle";
// apps/backend/src/agent/MultiAgentRuntime.ts
//
// The ORION mission loop:
//
//   ORION (orchestrator role, planner/reviewer model)
//     → decomposes the goal into tasks, each ASSIGNED TO A SPECIALIST
//     → monitors execution, judges every result, sends rework
//     → never writes code itself
//   WORKERS (coder / tester / research / git — executor or chat model)
//     → do exactly one task at a time through the Tool Gateway
//     → never talk to each other; results return via the Task Engine
//
// State lives in the TaskEngine (missions + task state machine); telemetry
// flows through the EventBus over the existing RunStore SSE protocol, so the
// UI needs no second socket.

import { envelopeForEvent } from "../gateway/toolResultEnvelope";
import { randomUUID } from "crypto";
import { AIMessage, AIModelProvider, Attachment, ToolDefinition } from "@orvyn/ai-core";
import { ModelService } from "../services/ModelService";
import { ToolGateway } from "../gateway/ToolGateway";
import { ToolRegistry } from "../ai/ToolTypes";
import { DockerSandbox } from "../sandbox/DockerSandbox";
import { makeSandboxTerminalTool, makeSandboxVerificationTools, makeSandboxProcessTools, SANDBOX_DENIED_TOOLS, sandboxDenialMessage, SandboxExec } from "../ai/tools/sandboxTools";
import { ModelGateway } from "../gateway/ModelGateway";
import type { AgentRole } from "../gateway/PermissionEngine";
import { isDestructiveCommand } from "../ai/tools/terminalTool";
import { playwrightAvailable, closeBrowserSession } from "../ai/tools/browserTools";
import { RunStore, isTerminal } from "./events";
import { EventBus } from "./EventBus";
import { TaskEngine, Mission, Task } from "./TaskEngine";
import { ReviewEngine } from "../review/ReviewEngine";
import { CheckpointEngine } from "../checkpoint/CheckpointEngine";
import { ContextEngine } from "../context/ContextEngine";
import { applyMode } from "./modes";
import { clampToolOutput, MAX_TOOL_OUTPUT_CHARS } from "./contextBudget";
import { MissionBudgetExceededError } from "../services/UsageService";
import { MissionQueue } from "../queue/MissionQueue";
import { raceApprovalTimeout } from "./approvals";
import { LANGUAGE_RULE, generateEnglish, isMostlyChinese } from "./languageRule";
import { modelCallSignal } from "./modelTimeout";
import { creditsFor } from "../models/routingPolicy";
import { FILE_PRODUCING_TOOLS, parsePersistedArtifacts, requirePersistedArtifacts } from "../artifacts/artifactContract";
import { inferTaskIntent } from "./taskIntent";
import { classifyToolError, recoveryGuidance } from "./toolErrors";
import { settleResult, settlementCriteria, SettlementCriterion } from "./resultContract";
import { isModelUnavailable, markModelUnavailable } from "../models/modelAvailability";

interface PendingApproval {
  resolve: (approved: boolean) => void;
  /** For "Allow for Mission": which run and tool this approval covers. */
  runId: string;
  tool: string;
}

export type ApprovalScope = "once" | "mission" | "session" | "project" | "always";

const MAX_TASKS = 12;

/**
 * The sandbox surface a mission consumes — provider-neutral, so the runtime
 * is decoupled from the Docker implementation. Docker satisfies this today;
 * the OpenShell provider slots in behind the same seam (see
 * execution/SandboxRegistry for provider selection).
 */
interface MissionSandbox extends SandboxExec {
  readonly containerId: string;
  mergeBack(projectRoot: string): Promise<{ mergedFiles: number }>;
  /** Re-sync the host tree into the sandbox so verification sees fresh writes. */
  refresh?(projectRoot: string): Promise<void>;
  stop(): Promise<void>;
}

/** Single seam for sandbox creation — provider selection lives here. */
async function startMissionSandbox(missionId: string, projectRoot: string): Promise<MissionSandbox> {
  return DockerSandbox.start(missionId, projectRoot);
}

/**
 * Structured result contract for delegated workers. ORION receives the
 * SUMMARY, never the worker's full context — the parent's own context
 * stays small and independent.
 */
export interface WorkerResult {
  workerId: string;
  role: string;
  task: string;
  status: "completed" | "failed" | "rejected" | "cancelled";
  /** One-paragraph summary of what the worker did and found. */
  summary: string;
  /** Evidence URLs/screenshots/console output (for browser workers). */
  evidence: string[];
  /** Files the worker changed. */
  artifacts: string[];
  /** Errors encountered (empty when successful). */
  errors: string[];
  tokensUsed: number;
  /** Billing-weighted token cost of this task (routingPolicy credits). */
  creditsUsed: number;
  /** Model calls this task consumed against its allowance. */
  modelCalls: number;
  durationMs: number;
}

/**
 * Delegation policy: ORION delegates only when work genuinely benefits.
 * Simple tasks run in the parent; complex/parallel work spawns workers.
 */
const DELEGATION_POLICY = {
  /** Always delegate: browser verification needs an isolated session. */
  browser: true,
  /** Delegate tests when >3 test files or the suite takes >60s. */
  tests: { minFiles: 3 },
  /** Delegate research when >5 files to read. */
  research: { minFiles: 5 },
  /** Never delegate single-file edits or quick fixes. */
  code: { minFiles: 2 },
  /** Max concurrent workers per mission. */
  maxWorkers: Number(process.env.ORVYN_MAX_WORKERS) || 3,
  /** Worker time limit (ms). */
  workerTimeoutMs: Number(process.env.ORVYN_WORKER_TIMEOUT_MS) || 300_000,
  /** Worker token budget per task. */
  workerTokenBudget: Number(process.env.ORVYN_WORKER_TOKEN_BUDGET) || 50_000,
  /** Worker credit budget per task (billing-weighted tokens — a heavy model spends the same task's allowance faster). */
  workerCreditBudget: Number(process.env.ORVYN_WORKER_CREDIT_BUDGET) || 400,
  /** Worker model-call allowance per task — the step ceiling, named for what it meters. */
  workerMaxModelCalls: Number(process.env.ORVYN_WORKER_MAX_MODEL_CALLS) || 10,
};

/** Decides whether a task type should be delegated to a worker. */
function shouldDelegate(agent: string, scope: { files?: number; estDurationMs?: number }): boolean {
  if (agent === "browser") return DELEGATION_POLICY.browser;
  if (agent === "tester") return (scope.files ?? 0) >= (DELEGATION_POLICY.tests as { minFiles: number }).minFiles;
  if (agent === "research") return (scope.files ?? 0) >= (DELEGATION_POLICY.research as { minFiles: number }).minFiles;
  if (agent === "coder") return (scope.files ?? 0) >= (DELEGATION_POLICY.code as { minFiles: number }).minFiles;
  return false;
}
const MAX_REVISIONS = 2;        // per task, before giving up and moving on


/** Which specialists ORION may delegate to today (browser needs Playwright). */
function delegatable(): AgentRole[] {
  const base: AgentRole[] = ["coder", "tester", "research", "git", "security"];
  return playwrightAvailable() ? [...base, "browser"] : base;
}

/** Tool subset each worker role sees. The capability engine enforces this again at execution. */
const ROLE_TOOLS: Record<AgentRole, (name: string) => boolean> = {
  orchestrator: (n) => ["read_file", "list_directory", "search_files", "search_code", "list_symbols", "git_status", "git_diff", "git_log"].includes(n),
  coder: () => true,
  tester: (n) =>
    ["read_file", "list_directory", "search_files", "search_code", "list_symbols", "get_diagnostics", "run_tests", "run_typecheck", "run_linter", "terminal", "run_command", "read_process_logs", "list_processes"].includes(n),
  research: (n) => ["read_document", "read_file", "list_directory", "search_files", "search_code", "list_symbols", "fetch_url", "web_search"].includes(n),
  git: (n) => n.startsWith("git_"),
  browser: (n) => n.startsWith("browser_"),
  security: (n) => ["read_file", "list_directory", "search_files", "search_code", "list_symbols", "git_diff", "git_log"].includes(n),
};

const WORKER_PROMPTS: Partial<Record<AgentRole, string>> = {
  coder: [
    "You are the CODING AGENT. Complete ONLY the assigned task using the tools.",
    "Work iteratively: inspect, change, then VERIFY (diagnostics/tests/build).",
    "Do not attempt other tasks. When finished, state plainly what you changed and how you verified it.",
  ].join("\n"),
  tester: [
    "You are the TESTING AGENT. You verify — you never fix.",
    "Run the relevant diagnostics/tests/typecheck for the assigned task and report",
    "exactly what passed and what failed, with the failing output quoted.",
  ].join("\n"),
  research: [
    "You are the RESEARCH AGENT. Investigate the assigned question by reading and",
    "searching the codebase (and fetching docs when allowed). You cannot edit anything.",
    "Report findings with concrete file paths and evidence.",
  ].join("\n"),
  git: [
    "You are the GIT AGENT. You may only use git tools.",
    "Inspect status/diff/log, manage branches, and commit when the task requires it.",
    "NEVER push to a remote.",
  ].join("\n"),
  browser: [
    "You are the BROWSER QA AGENT. You verify web UIs — you never edit code.",
    "Method: browser_open the target URL (file:// URLs work for static pages),",
    "interact with browser_click / browser_type, take a browser_screenshot as",
    "evidence, and ALWAYS finish by checking browser_console_errors.",
    "Report exactly what you saw: page title, elements found or missing,",
    "behavior after interactions, console errors, and the screenshot path.",
  ].join("\n"),
  security: [
    "You are the SECURITY AGENT. You review — you never edit code or run commands.",
    "Inspect the relevant code with read_file/search_code and the current changes",
    "with git_diff (and git_log for context). Look for: injection (SQL/command/path),",
    "XSS, missing input validation at boundaries, secrets or credentials in code,",
    "auth/session weaknesses, unsafe deserialization, SSRF, and dependency risks.",
    "Report findings as a list, each with: severity (critical/high/medium/low/info),",
    "the file and location, the issue, and a concrete remediation. If you find",
    "nothing, say exactly what you inspected and that no issues were found —",
    "never invent findings to look useful.",
  ].join("\n"),
};

function extractJson(raw: string): any {
  const cleaned = raw.replace(/```json|```/g, "").trim();
  // Models sometimes wrap JSON in prose; grab the outermost object/array.
  const start = cleaned.search(/[{[]/);
  if (start === -1) throw new Error("No JSON found in model output");
  return JSON.parse(cleaned.slice(start));
}

export class MultiAgentRuntime {
  private pending = new Map<string, PendingApproval>();
  /** runId → tools the user approved for the whole mission ("Allow for Mission"). */
  private missionApproved = new Map<string, Set<string>>();
  /** Missions the user stopped. Checked at every phase boundary. */
  private cancelled = new Set<string>();
  /** Aborts the in-flight model request so Stop takes effect mid-generation. */
  private controllers = new Map<string, AbortController>();
  private models: ModelGateway;
  private reviewEngine: ReviewEngine;
  private checkpoints = new CheckpointEngine();
  private contextEngine: ContextEngine;
  private queue: MissionQueue;
  /** Per-mission tool surface: mode/profile/sandbox changes never mutate the shared registry. */
  private runTools = new Map<string, ToolGateway>();
  /** Planner-reported scope estimates (files to touch), keyed by task id. */
  private taskScope = new Map<string, number>();

  constructor(
    private modelService: ModelService,
    private tools: ToolGateway,
    private store: RunStore,
    private taskEngine: TaskEngine,
    private bus: EventBus,
    queue?: MissionQueue
  ) {
    this.models = new ModelGateway(modelService);
    this.reviewEngine = new ReviewEngine(this.models, this.tools);
    this.contextEngine = new ContextEngine(this.tools);
    this.queue = queue ?? new MissionQueue();
  }

  queueStats(): { running: number; waiting: number; concurrency: number } {
    return this.queue.stats();
  }

  /**
   * Stops a mission: aborts the current model call, denies anything waiting on
   * approval, and marks the run cancelled. Phase boundaries check `cancelled`,
   * so a mission mid-task unwinds at the next checkpoint rather than finishing.
   */
  cancel(runId: string): boolean {
    if (this.cancelled.has(runId)) return false;
    this.cancelled.add(runId);

    for (const [callId, p] of this.pending) {
      if (p.runId === runId) {
        this.pending.delete(callId);
        p.resolve(false);
      }
    }

    this.controllers.get(runId)?.abort();

    // Stop is immediate for a queued mission and for one already in a model
    // or tool call. The in-flight call unwinds on the abort; the status does
    // not wait for that call to return.
    const run = this.store.get(runId);
    if (run && run.status !== "cancelled" && !run.events.some((e) => e.type === "run.cancelled")) {
      const started = run.events.some((e) => e.type === "run.started");
      this.store.emit(runId, "run.cancelled", {
        reason: started ? "Stopped by user" : "Stopped by user before it started",
      });
      this.store.setStatus(runId, "cancelled");
    }
    return true;
  }

  private isCancelled(runId: string): boolean {
    return this.cancelled.has(runId);
  }

  private signalFor(runId: string): AbortSignal {
    let c = this.controllers.get(runId);
    if (!c) {
      c = new AbortController();
      this.controllers.set(runId, c);
    }
    return c.signal;
  }

   private async finishCancelled(runId: string, missionId?: string): Promise<void> {
    const run = this.store.get(runId);
    if (!run?.events.some((event) => event.type === "run.cancelled")) {
      this.store.emit(runId, "run.cancelled", { reason: "Stopped by user" });
    }
    if (missionId) (await this.taskEngine.setMissionStatus(missionId, "BLOCKED"));
    this.store.setStatus(runId, "cancelled");
    this.missionApproved.delete(runId);
    this.controllers.delete(runId);
  }

  private toolDefinitionsFor(role: AgentRole, runId?: string): ToolDefinition[] {
    return this.gatewayFor(runId)
      .list()
      .filter((t) => ROLE_TOOLS[role](t.name))
      .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  }

  /**
   * The ToolGateway this run sees. Missions get a scoped registry so sandbox
   * tool swaps and permission changes cannot leak into a concurrent mission —
   * ORVYN_MAX_CONCURRENT_MISSIONS > 1 makes a shared-mutable gateway a
   * cross-run race, not just untidy.
   */
  private gatewayFor(runId?: string): ToolGateway {
    return (runId && this.runTools.get(runId)) || this.tools;
  }

  /** A per-run copy of the shared gateway (tools by reference, permissions copied). */
  private scopedGateway(): ToolGateway {
    const registry = new ToolRegistry();
    for (const t of this.tools.list()) {
      registry.register(t);
      registry.setPermission(t.name, this.tools.getPermission(t.name));
    }
    const gateway = new ToolGateway(registry, this.tools.permissions);
    gateway.profile = this.tools.profile;
    return gateway;
  }

  start(projectRoot: string, goal: string, rules?: string, attachments?: Attachment[]): string {
    const runId = randomUUID();
    this.store.create(runId, projectRoot);
    // Bounded concurrency: beyond ORVYN_MAX_CONCURRENT_MISSIONS the mission
    // waits its turn instead of piling more agent loops onto the box.
    const position = this.queue.enqueue(() => this.orchestrate(runId, projectRoot, goal, rules, attachments));
    if (position > 0) {
      // Truthful state: the run EXISTS but has not started — say so, or the
      // UI shows RUNNING while nothing at all is executing.
      this.store.setStatus(runId, "queued");
      this.store.emit(runId, "run.queued", {
        position,
        maxConcurrent: this.queue.concurrency,
        note: `Mission queued at position ${position} (max ${this.queue.concurrency} concurrent). It starts automatically when a slot frees up.`,
      });
    }
    return runId;
  }

  private async orchestrate(
    runId: string,
    projectRoot: string,
    goal: string,
    rules?: string,
    attachments?: Attachment[]
  ): Promise<void> {
    // Stopped while queued: cancel() already marked the run terminal; do not
    // burn a planner call — or a slot — on work nobody asked for anymore.
    if (this.isCancelled(runId)) {
      if (this.store.get(runId)?.status !== "cancelled") await this.finishCancelled(runId);
      return;
    }
    // The queue slot is ours — flip from queued to genuinely running.
    if (this.store.get(runId)?.status === "queued") this.store.setStatus(runId, "running");
    this.store.emit(runId, "run.started", { instruction: goal, mode: "multitask" });
    const mission = (await this.taskEngine.createMission(runId, projectRoot, goal));

    // Mission-scoped tool surface: mode/profile application, sandbox swaps and
    // per-run denials happen on a private copy — a concurrent mission can never
    // observe (or inherit) this run's tool mutations.
    const runGateway = this.scopedGateway();
    applyMode(runGateway.registry, "multitask");
    runGateway.applyProfile();
    this.runTools.set(runId, runGateway);

    // Sandbox mode: command-class tools execute inside a per-mission Docker
    // container, never on the API host (master spec §31). Enabled per
    // environment — cloud deployments set ORVYN_MISSION_EXECUTION=sandbox.
    let sandbox: MissionSandbox | undefined;
    const sandboxMode = process.env.ORVYN_MISSION_EXECUTION?.trim() === "sandbox";

    if (sandboxMode) {
      const sb = await startMissionSandbox(mission.id, projectRoot);
      sandbox = sb;
      this.store.emit(runId, "sandbox.started", { container: sb.containerId, image: "isolated", network: "none" });
      // Swap the command tools for sandbox-backed equivalents on the mission's
      // OWN registry — the scope is discarded at settle, so nothing restores.
      runGateway.register(makeSandboxTerminalTool(sb));
      runGateway.registerAlias("run_command", "terminal");
      // Semantic verification runs inside the sandbox too — run_tests,
      // run_typecheck and run_linter would otherwise execute project code on
      // the API host. The host tree drives detection; a refresh before each
      // verification run makes the sandbox copy see the files just written.
      for (const tool of makeSandboxVerificationTools(sb, projectRoot, {
        beforeRun: () => sb.refresh?.(projectRoot),
      })) {
        runGateway.register(tool);
      }
      // Provider-native process lifecycle — a dev server started inside the
      // sandbox is managed there too, never on the host ServiceManager.
      for (const tool of makeSandboxProcessTools(sb)) {
        runGateway.register(tool);
      }
      // Anything left without a sandbox equivalent stays denied — the list
      // is the migration surface, not a permanent feature.
      for (const denied of SANDBOX_DENIED_TOOLS) {
        runGateway.setPermission(denied, "denied");
      }
    }

    try {
      // ---------- ORION: PLAN ----------
      (await this.taskEngine.setMissionStatus(mission.id, "PLANNING"));
      const astra = this.models.resolveRole("orchestrator");
      this.store.emit(runId, "thinking", { role: "orion", model: astra.config.id });

      const planResponse = await this.modelService.usage.with(
        { missionId: mission.id, agent: "orchestrator" },
        () =>
          this.callWithFailover(runId, astra, {
        messages: [
          {
            role: "system",
            content: [
              "You are ORION, the orchestrator of ORVYN's engineering agents.",
              "You NEVER write code yourself. You decompose the user's goal into a short",
              "ordered list of concrete, independently-verifiable tasks and assign each",
              "to exactly one specialist:",
              '- "coder": edits files, runs commands, implements',
              '- "tester": runs tests/diagnostics and reports pass/fail (verification-only)',
              '- "research": reads/searches code and docs to answer a question (no edits)',
              '- "git": branch/commit operations only',
              '- "security": reviews code/diffs for vulnerabilities and reports findings (no edits)',
            LANGUAGE_RULE,
              ...(playwrightAvailable()
                ? ['- "browser": browser QA — open pages, click, type, screenshot (Playwright)']
                : []),
              "Respond with ONLY JSON, no prose, no fences:",
              '{"tasks":[{"id":"t1","description":"...","agent":"coder","files":1,"dependsOn":[]}]}',
              '"files" is your estimate of how many files the task will touch — it sizes the work.',
              '"dependsOn" lists the ids of tasks that must COMPLETE before this one runs.',
              "Independent read-only investigations (research/security) SHOULD have no dependencies so they run in parallel.",
              "A task that reads or verifies another task's changes MUST depend on it.",
              `Use at most ${MAX_TASKS} tasks. Prefer fewer, larger tasks over many tiny ones.`,
              "Most missions end with one tester task verifying the whole change.",
              rules ? `\nProject rules:\n${rules}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          },
          { role: "user", content: goal, attachments },
        ],
        signal: modelCallSignal(this.signalFor(runId)),
          }, "planner")
      );

      try {
        const parsed = extractJson(planResponse.content);
        const raw: any[] = (parsed.tasks ?? []).slice(0, MAX_TASKS);
        const allowed = delegatable();
        // Two passes: the planner names dependencies with its own ids
        // ("t1"), so create all tasks first, then resolve the dep names to
        // the TaskEngine ids. Unknown dep names are dropped — a dependency on
        // nothing must not silently become a dependency on everything.
        const created: Task[] = [];
        const plannerIds = new Map<string, Task>();
        for (const [i, t] of raw.entries()) {
          const agent = allowed.includes(t?.agent) ? (t.agent as AgentRole) : "coder";
          const task = (await this.taskEngine.addTask(mission.id, String(t?.description ?? t), agent));
          if (!task) continue;
          created.push(task);
          plannerIds.set(String(t?.id ?? `t${i + 1}`), task);
          const files = Number(t?.files);
          if (Number.isFinite(files) && files > 0) this.taskScope.set(task.id, files);
        }
        raw.forEach((t, i) => {
          const task = created[i];
          if (!task || !Array.isArray(t?.dependsOn)) return;
          const deps = t.dependsOn
            .map((d: unknown) => plannerIds.get(String(d))?.id)
            .filter((d: string | undefined): d is string => Boolean(d) && d !== task.id);
          if (deps.length) task.dependsOn = deps;
        });
      } catch (err: any) {
        this.store.emit(runId, "run.error", {
          message: `ORION did not return valid JSON: ${err.message}. Raw: ${planResponse.content.slice(0, 200)}`,
        });
        (await this.taskEngine.setMissionStatus(mission.id, "FAILED"));
        this.store.setStatus(runId, "error");
        return;
      }

      if (mission.tasks.length === 0) {
        // NO_TASK_NEEDED vs PLANNING_FAILED: an empty task list is only benign
        // when the request was genuinely conversational. An engineering goal
        // that produced zero tasks is a planner failure — "Completed" there is
        // the false-completion bug all over again.
        const intent = inferTaskIntent(goal);
        const engineering =
          !intent.informational &&
          (intent.requiresWorkspace || intent.requiresFrontend || intent.requiresTerminal ||
            intent.requiresBrowser || intent.requiresArtifact || intent.requiresRemoteResource ||
            ["code", "deploy", "database", "server", "artifact", "automation"].includes(intent.category));
        if (engineering) {
          const message = "ORION could not break this request into executable tasks (planning failed). Please retry.";
          this.store.emit(runId, "run.error", { message, code: "PLANNING_FAILED" });
          (await this.taskEngine.setMissionStatus(mission.id, "FAILED"));
          this.store.setStatus(runId, "error");
          return;
        }
        const note =
          "This request didn't need engineering steps — it looks conversational. " +
          "Ask it in the Chat tab for a direct answer, or describe the change you want made and run it as Code.";
        for (const chunk of note.match(/.{1,24}/gs) ?? []) {
          this.store.emit(runId, "message.delta", { content: chunk });
        }
        this.store.emit(runId, "message.completed", {});
        this.store.emit(runId, "run.completed", { tasksTotal: 0, tasksCompleted: 0, tasksFailed: 0, missionStatus: "COMPLETED" });
        (await this.taskEngine.setMissionStatus(mission.id, "COMPLETED"));
        this.store.setStatus(runId, "completed");
        return;
      }

      this.store.emit(runId, "plan.created", {
        plannerModel: astra.config.id,
        missionId: mission.id,
        tasks: mission.tasks.map((t) => ({ id: t.id, description: t.description, agent: t.agent })),
      });
      (await this.taskEngine.setMissionStatus(mission.id, "RUNNING"));

      // Snapshot dirty files before any worker writes, so the user can roll
      // the mission back from the SCM panel.
      if (mission.tasks.some((t) => t.agent === "coder" || t.agent === "git")) {
        try {
          const cp = await this.checkpoints.create(projectRoot, {
            note: `pre-mission: ${goal.slice(0, 80)}`,
            missionId: mission.id,
          });
          this.bus.checkpointCreated(runId, cp.id, cp.files.length);
        } catch {
          // Snapshot is best-effort; a failure must not stop the mission.
        }
      }

      // ---------- WORKERS: EXECUTE, ORION: REVIEW EACH ----------
      const reviewer = this.models.resolveTask("reviewer");

      // Dependency-aware scheduling: a task runs when every dependsOn entry
      // reached COMPLETED. Read-only roles (research, security) cannot
      // conflict, so all ready read-only tasks run concurrently up to the
      // worker cap; mutating roles run one at a time — a test or browser task
      // must observe the writes it verifies, never run mid-write.
      const READ_ONLY_ROLES = new Set<AgentRole>(["research", "security"]);
      const pending = new Set<Task>(mission.tasks);
      while (pending.size > 0) {
        if (this.isCancelled(runId)) return this.finishCancelled(runId, mission.id);

        // A task whose dependency can never complete (FAILED/SKIPPED) is
        // unreachable — mark it SKIPPED instead of waiting forever.
        for (const task of pending) {
          if ((task.dependsOn ?? []).some((d) => {
            const dep = mission.tasks.find((t) => t.id === d);
            return dep && (dep.status === "FAILED" || dep.status === "SKIPPED");
          })) {
            (await this.taskEngine.transition(mission.id, task.id, "SKIPPED"));
            this.store.emit(runId, "task.skipped", { taskId: task.id, reason: "a dependency did not complete" });
            pending.delete(task);
          }
        }
        if (pending.size === 0) break;

        const ready = [...pending].filter((t) =>
          (t.dependsOn ?? []).every((d) => mission.tasks.find((x) => x.id === d)?.status === "COMPLETED")
        );
        if (ready.length === 0) {
          // Cycle or a dep that can never satisfy — better a truthful skip
          // than a silent hang.
          for (const task of pending) {
            (await this.taskEngine.transition(mission.id, task.id, "SKIPPED"));
            this.store.emit(runId, "task.skipped", { taskId: task.id, reason: "dependency cycle in the plan" });
            pending.delete(task);
          }
          break;
        }

        const readOnly = ready.filter((t) => READ_ONLY_ROLES.has(t.agent)).slice(0, DELEGATION_POLICY.maxWorkers);
        const batch = readOnly.length > 0 ? readOnly : ready.filter((t) => !READ_ONLY_ROLES.has(t.agent)).slice(0, 1);
        for (const task of batch) pending.delete(task);
        await Promise.all(batch.map((task) => this.processTask(runId, mission, task, goal, reviewer, rules)));
      }
      if (this.isCancelled(runId)) return this.finishCancelled(runId, mission.id);

      // ---------- MANDATORY FINAL MISSION REVIEW (Review Engine) ----------
      let blocked = false;
      for (;;) {
        (await this.taskEngine.setMissionStatus(mission.id, "REVIEW"));
        this.store.emit(runId, "review.started", {
          missionId: mission.id,
          scope: "mission",
          reviewerModel: reviewer.config.id,
        });

        // The review model resolves through the ModelGateway each call — a
        // provider failure retries once and lands on a live route instead of
        // killing the mission at the gate.
        let verdict;
        try {
          verdict = await this.modelService.usage.with(
            { missionId: mission.id, agent: "reviewer" },
            () => this.reviewEngine.reviewMission(mission, rules)
          );
        } catch (err) {
          if (this.isCancelled(runId)) return this.finishCancelled(runId, mission.id);
          this.store.emit(runId, "model.fallback", {
            role: "mission_reviewer",
            reason: String((err as Error)?.message ?? err).slice(0, 200),
            failure: "provider",
          });
          verdict = await this.modelService.usage.with(
            { missionId: mission.id, agent: "reviewer" },
            () => this.reviewEngine.reviewMission(mission, rules)
          );
        }

        if (verdict.status === "approved") {
          this.bus.reviewApproved(runId, mission.id, verdict.score);
          if (verdict.warnings.length > 0) {
            this.store.emit(runId, "review.passed", { missionId: mission.id, notes: verdict.warnings.join("; ") });
          }
          break;
        }

        const cycle = (await this.taskEngine.incrementReviewCycles(mission.id));
        this.store.emit(runId, "review.rejected", {
          missionId: mission.id,
          scope: "mission",
          cycle,
          blockingIssues: verdict.blockingIssues,
          requiredChanges: verdict.requiredChanges,
          willRetry: cycle < ReviewEngine.MAX_CYCLES && verdict.requiredChanges.length > 0,
        });

        if (cycle >= ReviewEngine.MAX_CYCLES || verdict.requiredChanges.length === 0) {
          // Do not loop forever — hand the decision to the human.
          blocked = true;
          (await this.taskEngine.setMissionStatus(mission.id, "BLOCKED"));
          break;
        }

        // Rejected with concrete corrections: Astra assigns rework to the coder.
        for (const change of verdict.requiredChanges.slice(0, 4)) {
          const correction = (await this.taskEngine.addTask(mission.id, `[review correction] ${change}`, "coder"));
          if (correction) await this.processTask(runId, mission, correction, goal, reviewer, rules);
        }
      }

      await this.finishMission(runId, mission, astra, goal, blocked);
    } catch (err: any) {
      // An abort arrives here as a rejected fetch; a stopped mission is not a
      // failed one and must not be reported as an error.
      if (this.isCancelled(runId) || err?.name === "AbortError") {
        return this.finishCancelled(runId, mission.id);
      }
      // A blown runaway-guard budget is BLOCKED (needs a human decision, e.g.
      // raising the cap), not FAILED — the work may be nearly done.
      if (err instanceof MissionBudgetExceededError) {
        // One truth: the mission is BLOCKED (a human can resume it or raise
        // the allowance) — the run status must agree, not say "error".
        this.store.emit(runId, "run.blocked", { terminal: true, message: err.message, code: "BUDGET_EXCEEDED" });
        this.store.emit(runId, "mission.blocked", { missionId: mission.id, reason: err.message });
        (await this.taskEngine.setMissionStatus(mission.id, "BLOCKED"));
        this.store.setStatus(runId, "blocked");
        return;
      }
      this.store.emit(runId, "run.error", { message: err.message });
      (await this.taskEngine.setMissionStatus(mission.id, "FAILED"));
      this.missionApproved.delete(runId);
      this.store.setStatus(runId, "error");
    } finally {
      this.cancelled.delete(runId);
      this.controllers.delete(runId);
      // Budget counters are per-mission; a finished mission frees them.
      this.modelService.usage.forgetMission(mission.id);

      if (sandbox) {
        try {
          // The sandbox tree is authoritative for files commands created or
          // modified; merge it back so checkpoints, diffs and Undo on the
          // host see the real end state.
          const { mergedFiles } = await sandbox.mergeBack(projectRoot);
          this.store.emit(runId, "sandbox.stopped", { mergedFiles });
        } catch {
          this.store.emit(runId, "sandbox.stopped", { mergedFiles: 0, note: "merge-back failed; container discarded" });
        }
        await sandbox.stop().catch(() => {});

      }
    }
    this.runTools.delete(runId);
  }

  // One task through the worker + Astra's per-task review, with rework retries.
  private async processTask(
    runId: string,
    mission: Mission,
    task: Task,
    goal: string,
    reviewer: AIModelProvider,
    rules?: string
  ): Promise<void> {
    // Delegation policy BEFORE any execution: a task the planner sized below
    // its role's threshold does not spawn a specialist worker at all. The
    // orchestrator model executes it directly in the same bounded tool loop
    // and skips the dedicated review round — the mission-level Review Engine
    // still gates the end. No `files` estimate means "unknown", and unknown
    // always delegates.
    const scopedFiles = this.taskScope.get(task.id);
    const delegated = scopedFiles === undefined ? true : shouldDelegate(task.agent, { files: scopedFiles });

    if (!delegated) {
      task.attempts++;
      (await this.taskEngine.transition(mission.id, task.id, "RUNNING"));
      const executor = this.models.resolveRole("orchestrator");
      this.bus.agentStarted(runId, task.agent, task.id, executor.config.id);
      this.store.emit(runId, "task.started", {
        taskId: task.id,
        description: task.description,
        agent: task.agent,
        attempt: task.attempts,
        executorModel: executor.config.id,
        direct: true,
      });
      const result = await this.modelService.usage.with(
        { missionId: mission.id, taskId: task.id, agent: task.agent },
        () => this.runWorker(runId, executor, task, goal, mission.projectRoot, rules, { direct: true })
      );
      task.result = result.summary;
      if (result.status === "completed") {
        (await this.taskEngine.transition(mission.id, task.id, "COMPLETED"));
        this.store.emit(runId, "review.skipped", {
          taskId: task.id,
          reason: `below delegation threshold (${scopedFiles} file(s)) — direct execution, covered by the mission review`,
        });
        this.bus.agentCompleted(runId, task.agent, task.id, true);
      } else {
        (await this.taskEngine.transition(mission.id, task.id, result.status === "cancelled" ? "BLOCKED" : "FAILED"));
        this.store.emit(runId, "task.failed", { taskId: task.id, reason: result.errors[0] ?? "direct execution did not finish" });
        this.bus.agentCompleted(runId, task.agent, task.id, false);
      }
      this.store.emit(runId, "task.completed", { taskId: task.id, status: task.status });
      return;
    }

    let accepted = false;

    while (task.attempts <= MAX_REVISIONS && !accepted) {
      task.attempts++;
      (await this.taskEngine.transition(mission.id, task.id, "RUNNING"));

      const worker = this.workerModelFor(task.agent);
      this.bus.agentStarted(runId, task.agent, task.id, worker.config.id);
      this.store.emit(runId, "task.started", {
        taskId: task.id,
        description: task.description,
        agent: task.agent,
        attempt: task.attempts,
        executorModel: worker.config.id,
      });

      const result = await this.modelService.usage.with(
        { missionId: mission.id, taskId: task.id, agent: task.agent },
        () => this.runWorker(runId, worker, task, goal, mission.projectRoot, rules)
      );
      task.result = result.summary;

      // A worker that died (deadline, budget, exhausted failover) did not
      // finish — failing the task is more truthful than reviewing a corpse.
      if (result.status !== "completed") {
        if (result.status === "cancelled") {
          (await this.taskEngine.transition(mission.id, task.id, "BLOCKED"));
        } else {
          (await this.taskEngine.transition(mission.id, task.id, "FAILED"));
          this.store.emit(runId, "task.failed", { taskId: task.id, reason: result.errors[0] ?? "worker did not finish" });
        }
        this.bus.agentCompleted(runId, task.agent, task.id, false);
        break;
      }

      (await this.taskEngine.transition(mission.id, task.id, "REVIEW"));
      this.store.emit(runId, "review.started", { taskId: task.id, reviewerModel: reviewer.config.id });

      const verdict = await this.modelService.usage.with(
        { missionId: mission.id, taskId: task.id, agent: "reviewer" },
        () => this.reviewTask(runId, reviewer, goal, task)
      );

      if (verdict.approved) {
        accepted = true;
        (await this.taskEngine.transition(mission.id, task.id, "COMPLETED"));
        this.store.emit(runId, "review.passed", { taskId: task.id, notes: verdict.notes });
        this.bus.agentCompleted(runId, task.agent, task.id, true);
      } else {
        task.reviewNotes = verdict.notes;
        this.store.emit(runId, "review.rejected", {
          taskId: task.id,
          notes: verdict.notes,
          willRetry: task.attempts <= MAX_REVISIONS,
        });
        if (task.attempts > MAX_REVISIONS) {
          (await this.taskEngine.transition(mission.id, task.id, "FAILED"));
          this.store.emit(runId, "task.failed", { taskId: task.id, reason: verdict.notes });
          this.bus.agentCompleted(runId, task.agent, task.id, false);
        } else {
          (await this.taskEngine.transition(mission.id, task.id, "REWORK"));
        }
      }
    }

    this.store.emit(runId, "task.completed", { taskId: task.id, status: task.status });
  }

  // Final wrap-up after the Review Engine gate: Astra summarises the outcome.
  private async finishMission(
    runId: string,
    mission: Mission,
    astra: AIModelProvider,
    goal: string,
    blocked: boolean
  ): Promise<void> {
    const done = mission.tasks.filter((t) => t.status === "COMPLETED").length;
    // The Review Engine is the gate: the loop only exits approved or blocked.
    // If it approved, the goal is verified — task rows superseded by review
    // corrections must not drag the mission to FAILED (approved-yet-FAILED
    // is a contradiction the user rightly reads as "it doesn't work").
    const missionStatus = blocked ? "BLOCKED" : "COMPLETED";
    if (this.isCancelled(runId) || this.store.get(runId)?.status === "cancelled") return;

    const summary = await this.modelService.usage.with(
      { missionId: mission.id, agent: "orchestrator" },
      () =>
        this.callWithFailover(runId, astra, {
      messages: [
        {
          role: "system",
          content:
            (blocked
              ? "You are ASTRA. The mission failed final review after the maximum rework cycles. In 1-3 short sentences, tell the user what was attempted, what the blocking issues are, and that their decision is needed to proceed."
              : "You are ASTRA. Summarise what was accomplished in 1-3 short sentences, including anything that failed.") +
            "\n" +
            LANGUAGE_RULE,
        },
        {
          role: "user",
          content: `Goal: ${goal}\n\nOutcome:\n${mission.tasks
            .map((t) => `- [${t.status}] (${t.agent}) ${t.description}${t.reviewNotes ? ` (notes: ${t.reviewNotes})` : ""}`)
            .join("\n")}`,
        },
      ],
        signal: modelCallSignal(this.signalFor(runId)),
        }, "summarizer")
    );

    if (this.isCancelled(runId) || this.store.get(runId)?.status === "cancelled") return;

    for (const chunk of (summary.content ?? "").match(/.{1,24}/gs) ?? []) {
      this.store.emit(runId, "message.delta", { content: chunk });
    }
    this.store.emit(runId, "message.completed", {});

    // ── Settlement: review approval is evidence, not the verdict ─────────
    // The Review Engine is an LLM judgment; the terminal status is decided by
    // machine criteria — every task completed, the mission review passed,
    // AND the intent-derived evidence exists (files written, tests run,
    // browser verification for UI work). A requested "completed" that fails
    // the criteria settles as partial — never upgraded.
    const intent = inferTaskIntent(goal);
    const events = this.store.get(runId)?.events ?? [];
    const wroteFiles = mission.tasks.some((t) => t.agent === "coder" || t.agent === "git");
    const criteria: SettlementCriterion[] = [
      {
        id: "tasks",
        required: true,
        status: mission.tasks.every((t) => t.status === "COMPLETED")
          ? "pass"
          : mission.tasks.some((t) => t.status === "FAILED")
            ? "fail"
            : "unverified",
        detail: `${done}/${mission.tasks.length} tasks completed`,
      },
      {
        id: "review",
        required: true,
        status: blocked ? "fail" : "pass",
        detail: blocked ? "the mission review was not approved" : undefined,
      },
      // Evidence criteria derived from the classified intent — the same
      // machine checks the single-agent settlement runs.
      ...settlementCriteria({
        instruction: goal,
        events,
        needsArtifact: intent.requiresArtifact,
        // A workspace write is required only when the plan actually contained
        // file-mutating work — a remote deploy produces no local file events.
        needsWorkspaceWrite: intent.requiresWorkspace && wroteFiles,
        needsTests: /\b(test|typecheck|lint|build)\b/i.test(goal),
        website: false,
        needsVisual: intent.requiresDesktop,
        verifierVerdict: null,
        implementationWork: false,
      }),
    ];
    if (intent.requiresBrowserVerification) {
      // UI work must be verified in a browser — a code diff alone is not
      // evidence the page behaves. The browser worker's tools supply it.
      const verified = events.some(
        (e) =>
          e.type === "verification.completed" ||
          (e.type === "tool.completed" && /^browser_/.test(String(e.data?.tool ?? "")))
      );
      criteria.push({
        id: "browser_verification",
        required: true,
        status: verified ? "pass" : "not_run",
        detail: verified ? undefined : "the UI change was never checked in a browser",
      });
    }
    const summaryText = (summary.content ?? "").trim();
    const verdict = settleResult({
      request: { status: blocked ? "blocked" : "completed", summary: summaryText || "The mission ended." },
      criteria,
    });
    const settled = verdict.accepted ? verdict.status : "partial";
    this.store.emit(runId, "mission.settled", {
      missionId: mission.id,
      requested: blocked ? "blocked" : "completed",
      status: settled,
      summary: (verdict.accepted ? verdict.summary : summaryText).slice(0, 500),
      criteria,
      viaContract: false,
    });

    // The terminal event names the outcome — a listener that trusts the event
    // name can never render ✓ Completed for a blocked or partial mission.
    if (settled === "completed") {
      this.store.emit(runId, "run.completed", {
        tasksTotal: mission.tasks.length,
        tasksCompleted: done,
        tasksFailed: mission.tasks.length - done,
        missionStatus,
      });
      (await this.taskEngine.setMissionStatus(mission.id, "COMPLETED"));
    } else if (settled === "blocked") {
      this.store.emit(runId, "run.blocked", {
        terminal: true,
        message: "Mission failed final review — your decision is needed.",
        tasksTotal: mission.tasks.length,
        tasksCompleted: done,
        tasksFailed: mission.tasks.length - done,
        missionStatus,
      });
      (await this.taskEngine.setMissionStatus(mission.id, "BLOCKED"));
    } else if (settled === "partial") {
      this.store.emit(runId, "run.partial", {
        outcome: "partial",
        tasksTotal: mission.tasks.length,
        tasksCompleted: done,
        tasksFailed: mission.tasks.length - done,
        missionStatus,
      });
      // Work ended but incompletely — the mission ledger needs a decision.
      (await this.taskEngine.setMissionStatus(mission.id, "BLOCKED"));
    } else {
      this.store.emit(runId, "run.error", { message: summaryText.slice(0, 300) || "The mission failed.", code: "MISSION_FAILED" });
      (await this.taskEngine.setMissionStatus(mission.id, "FAILED"));
    }
    this.missionApproved.delete(runId);
    for (const t of mission.tasks) this.taskScope.delete(t.id);
    this.store.setStatus(
      runId,
      settled === "completed" ? "completed" : settled === "blocked" ? "blocked" : settled === "failed" ? "error" : "partial"
    );
  }

  private workerModelFor(role: AgentRole): AIModelProvider {
    return this.models.resolveRole(role);
  }

  /**
   * Every mission model call goes through the same provider failover the
   * worker loop uses: planner, task reviewers and the summarizer are not
   * exempt — a provider dying mid-mission must fail over to a compatible
   * provider, not fail the mission.
   */
  private async callWithFailover(
    runId: string,
    provider: AIModelProvider,
    request: Parameters<typeof generateEnglish>[1],
    role: string
  ): Promise<Awaited<ReturnType<typeof generateEnglish>>> {
    try {
      return await generateEnglish(provider, request);
    } catch (err) {
      if (this.isCancelled(runId)) throw err;
      const fallback = this.fallbackWorker(provider);
      if (!fallback) throw err;
      markModelUnavailable(provider.config.id, String((err as Error)?.message ?? err).slice(0, 200));
      this.store.emit(runId, "model.fallback", {
        role,
        previousModel: provider.config.id,
        actualModel: fallback.config.id,
        reason: String((err as Error)?.message ?? err).slice(0, 200),
        failure: "provider",
      });
      return generateEnglish(fallback, request);
    }
  }

  /**
   * A compatible replacement when the worker's model fails mid-task: prefer
   * the SAME model on another provider, then any agent-capable tool model —
   * the same ordering the main runtime's failover uses.
   */
  private fallbackWorker(current: AIModelProvider): AIModelProvider | undefined {
    const registered = this.modelService.registry.list();
    const usable = (p: AIModelProvider) =>
      p.config.id !== current.config.id &&
      p.config.capabilities?.agent !== false &&
      p.supportsTools() &&
      !isModelUnavailable(p.config.id);
    const sameModel = registered.find((p) => usable(p) && p.config.apiModelId && p.config.apiModelId === current.config.apiModelId);
    return sameModel ?? registered.find(usable);
  }

  // Runs one task on the worker's model with the worker's tool subset and the
  // standard approval gates. Returns the structured WorkerResult — the
  // reviewer consumes its summary/evidence, never a raw transcript it must
  // parse for claims. `direct` mode: the orchestrator executes a small task
  // itself — same bounded loop, no specialist framing.
  private async runWorker(
    runId: string,
    worker: AIModelProvider,
    task: Task,
    goal: string,
    projectRoot: string,
    rules?: string,
    opts?: { direct?: boolean }
  ): Promise<WorkerResult> {
    const workerStart = Date.now();
    const direct = opts?.direct === true;
    const workerId = `${direct ? "direct" : "w"}_${task.agent}_${task.id.slice(-6)}`;
    this.store.emit(runId, "worker.started", { workerId, role: task.agent, task: task.description.slice(0, 120), ...(direct ? { direct: true } : {}) });
    // Targeted context, not the whole repo (Context Engine v1: ripgrep + diff).
    const context = await this.contextEngine.buildTaskContext(
      task.description,
      task.reviewNotes ? task.result : undefined
    );

    // file:// URLs must be absolute; agents can't discover the root themselves.
    const fileUrlRoot = `file:///${projectRoot.replace(/\\/g, "/")}`;

    // WORKER CONTEXT ISOLATION: each worker receives ONLY the scoped inputs
    // for its task — role prompt, the specific task, project root, targeted
    // context (from ContextEngine), and review notes if reworking. The
    // parent conversation, full tool history, and other workers' outputs
    // are NEVER included. This keeps worker context small and independent.
    const scopedContext = task.agent === "browser"
      ? `Browser verification task. Target the URL described in YOUR TASK. Do NOT receive or use the parent conversation.`
      : `Code task. Scope: ${task.description.slice(0, 120)}`;

    const rolePrompt = direct
      ? [
          "You are ORION executing a small task directly — no delegation ceremony.",
          "Complete ONLY the assigned task with the tools, then state plainly what you did.",
          "Keep it tight: this task was sized small enough to skip specialist delegation.",
        ].join("\n")
      : WORKER_PROMPTS[task.agent] ?? WORKER_PROMPTS.coder;

    const messages: AIMessage[] = [
      {
        role: "system",
        content: [
          rolePrompt,
          CONVERSATION_STYLE,
          LANGUAGE_RULE,
          scopedContext,
          rules ? `\nProject rules:\n${rules}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      },
      {
        role: "user",
        content: [
          `Overall goal (for context only): ${goal}`,
          `YOUR TASK: ${task.description}`,
          `Project root (absolute): ${projectRoot}`,
          `File tools take paths relative to the project root. For browser verification: check the entry file first (list_directory). Static HTML opens as ${fileUrlRoot}/<entry>.html; server-side projects (index.php/asp) MUST be verified over their HTTP URL (e.g. http://localhost/<site>) — file:// cannot execute them.`,
          task.reviewNotes ? `\nA previous attempt was REJECTED by review:\n${task.reviewNotes}\nAddress these specifically.` : "",
          context ? `\n${context}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ];

    const transcript: string[] = [];
    const evidence: string[] = [];
    const artifacts: string[] = [];
    const errors: string[] = [];
    let failedReason: string | undefined;
    const tools = this.gatewayFor(runId);
    const toolDefs = this.toolDefinitionsFor(task.agent, runId);

    // Per-worker wall-clock deadline and token budget — a hung or runaway
    // worker unwinds the task instead of holding the mission slot forever.
    const deadline = Date.now() + DELEGATION_POLICY.workerTimeoutMs;
    const workerSignal = () =>
      AbortSignal.any([this.signalFor(runId), AbortSignal.timeout(Math.max(1, deadline - Date.now()))]);
    let workerTokens = 0;
    let workerCredits = 0;
    let modelCalls = 0;
    let modelRetries = 0;
    const MAX_MODEL_RETRIES = 2;

    let step = 0;
    for (; step < DELEGATION_POLICY.workerMaxModelCalls; step++) {
      // Unwind promptly rather than burning the worker's remaining steps.
      if (this.isCancelled(runId)) break;
      if (Date.now() >= deadline) {
        failedReason = `worker deadline exceeded (${Math.round(DELEGATION_POLICY.workerTimeoutMs / 1000)}s)`;
        this.store.emit(runId, "worker.timeout", { workerId, taskId: task.id, kind: "wall_clock", budgetMs: DELEGATION_POLICY.workerTimeoutMs });
        transcript.push(`Worker timed out after ${Math.round(DELEGATION_POLICY.workerTimeoutMs / 1000)}s`);
        errors.push(failedReason);
        break;
      }
      // Safe boundary: deliver any steered user instructions to the model.
      for (const t of this.store.takeSteer(runId)) {
        messages.push({ role: "user", content: `[User steering instruction — applies from now on] ${t}` });
      }
      let response;
      try {
        // Mission-scoped metering: worker calls count against the mission's
        // runaway-guard budget (and the tenant ledger) like every other call.
        response = await this.modelService.usage.with(
          { missionId: task.missionId, taskId: task.id, agent: task.agent },
          () => generateEnglish(worker, { messages, tools: toolDefs, signal: modelCallSignal(workerSignal()) })
        );
        modelCalls++;
        modelRetries = 0;
      } catch (err: any) {
        if (this.isCancelled(runId)) break;
        // Provider/model failure: failover to a compatible model before
        // giving up — same model on another provider first, like the main
        // runtime. A worker that dies on a transient provider error is a
        // false failure, not a task failure.
        if (modelRetries < MAX_MODEL_RETRIES && Date.now() < deadline) {
          const fallback = this.fallbackWorker(worker);
          if (fallback) {
            markModelUnavailable(worker.config.id, String(err?.message ?? err).slice(0, 200));
            this.store.emit(runId, "model.fallback", {
              taskId: task.id,
              workerId,
              previousModel: worker.config.id,
              actualModel: fallback.config.id,
              reason: String(err?.message ?? err).slice(0, 200),
              failure: "provider",
            });
            worker = fallback;
            modelRetries++;
            continue;
          }
        }
        // Surface it — a silent break here looks like the agent "gave up
        // after one tool call" in the UI, which is undebuggable.
        this.store.emit(runId, "tool.failed", {
          taskId: task.id,
          tool: "model",
          error: `Worker model error: ${String(err.message).slice(0, 300)}`,
        });
        failedReason = `worker model error: ${String(err.message).slice(0, 300)}`;
        errors.push(failedReason);
        transcript.push(`Worker model error: ${err.message}`);
        break;
      }

      const usage = (response as { usage?: { promptTokens?: number; completionTokens?: number } }).usage;
      if (usage) {
        workerTokens += (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
        workerCredits += creditsFor(worker.config.id, usage);
      }
      if (workerTokens > DELEGATION_POLICY.workerTokenBudget) {
        failedReason = `worker token budget exhausted (${workerTokens}/${DELEGATION_POLICY.workerTokenBudget})`;
        this.store.emit(runId, "worker.budget", { workerId, taskId: task.id, kind: "tokens", used: workerTokens, limit: DELEGATION_POLICY.workerTokenBudget });
        transcript.push(`Worker token budget exhausted (${workerTokens}/${DELEGATION_POLICY.workerTokenBudget})`);
        errors.push(failedReason);
        break;
      }
      if (workerCredits > DELEGATION_POLICY.workerCreditBudget) {
        failedReason = `worker credit budget exhausted (${Math.round(workerCredits)}/${DELEGATION_POLICY.workerCreditBudget})`;
        this.store.emit(runId, "worker.budget", { workerId, taskId: task.id, kind: "credits", used: Math.round(workerCredits), limit: DELEGATION_POLICY.workerCreditBudget });
        transcript.push(`Worker credit budget exhausted (${Math.round(workerCredits)}/${DELEGATION_POLICY.workerCreditBudget})`);
        errors.push(failedReason);
        break;
      }

      const calls = (response.toolCalls ?? []).filter((c: any) => c?.name && c.id);
      if (calls.length === 0) {
        const said = (response.content ?? "").trimEnd();
        if (said) {
          this.store.emit(runId, "message.delta", { content: said, taskId: task.id });
          this.store.emit(runId, "message.completed", { taskId: task.id });
        }
        transcript.push(response.content ?? "");
        break;
      }

      // Record every requested call, not just the first: an unanswered
      // tool_calls entry makes the next request a hard 400 on OpenAI-style
      // APIs, and dropping the extras also wastes a model turn per tool.
      messages.push({
        role: "assistant",
        content: response.content ?? "",
        // Thinking models (DeepSeek) require reasoning_content echoed back;
        // omitting it fails the next request with HTTP 400.
        ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
        toolCalls: calls,
      });
      const said = (response.content ?? "").trimEnd();
      if (said) {
        this.store.emit(runId, "message.delta", { content: said, taskId: task.id });
        this.store.emit(runId, "message.completed", { taskId: task.id });
      }

      for (const call of calls) {
        if (this.isCancelled(runId)) break;

        this.bus.agentToolCall(runId, task.agent, call.name, task.id);

        const permission = tools.getPermission(call.name);
        if (permission === "denied") {
          // In sandbox mode the denial is a redirection, not a flat no — tell
          // the agent the sandbox path instead of leaving it to guess.
          const sandboxed = process.env.ORVYN_MISSION_EXECUTION?.trim() === "sandbox";
          const message =
            sandboxed && SANDBOX_DENIED_TOOLS.includes(call.name)
              ? sandboxDenialMessage(call.name)
              : "Denied by project permissions.";
          messages.push({ role: "tool", name: call.name, toolCallId: call.id, content: message });
          continue;
        }
        // Hard boundary: destructive shell commands require approval no matter
        // what the mode/profile granted — AUTONOMOUS cannot pre-approve them,
        // and neither can a prior "Allow for Mission".
        const destructive =
          (call.name === "terminal" || call.name === "run_command") &&
          isDestructiveCommand(String((call.arguments as any).command ?? ""));
        const missionApproved = !destructive && (this.missionApproved.get(runId)?.has(call.name) ?? false);
        if ((permission === "ask" && !missionApproved) || destructive) {
          this.store.emit(runId, "approval.required", {
            callId: call.id,
            tool: call.name,
            input: call.arguments,
            destructive,
            taskId: task.id,
            agent: task.agent,
          });
          this.store.setStatus(runId, "awaiting_approval");
          const { approved, timedOut, seconds } = await raceApprovalTimeout((settle) => {
            this.pending.set(call.id, { resolve: settle, runId, tool: call.name });
            return () => this.pending.delete(call.id);
          });
          this.store.emit(runId, "approval.resolved", {
            callId: call.id,
            approved,
            ...(timedOut ? { reason: `no decision within ${seconds}s — denied automatically` } : {}),
          });
          this.store.setStatus(runId, "running");
          if (!approved) {
            messages.push({
              role: "tool",
              name: call.name,
              toolCallId: call.id,
              content: timedOut
                ? "The approval was not answered in time and was denied automatically. Do not repeat the identical action; continue with an alternative."
                : "User denied this action.",
            });
            transcript.push(`${call.name} denied${timedOut ? " (approval timeout)" : ""}`);
            continue;
          }
        }

        this.store.emit(runId, "tool.started", { callId: call.id, tool: call.name, taskId: task.id });
        this.store.emit(runId, "tool.input", { callId: call.id, input: call.arguments });

        const terminalLike = ["terminal", "run_command"].includes(call.name);
        if (terminalLike) this.store.emit(runId, "terminal.started", { callId: call.id, command: (call.arguments as any).command, taskId: task.id });
        let result = await tools.execute(call.name, call.arguments, task.agent, {
          signal: Date.now() < deadline ? workerSignal() : this.signalFor(runId),
          onOutput: terminalLike ? (chunk) => this.store.emit(runId, "terminal.output", { callId: call.id, content: chunk, taskId: task.id }) : undefined,
          // Reaching execute() with permission "ask" means the call was
          // sanctioned above — interactively approved or covered by an earlier
          // "Allow for Mission". The registry boundary requires that evidence.
          approval: permission === "ask"
            ? { granted: true, scope: missionApproved ? "mission" : "once", approvalId: call.id, grantedBy: "user" }
            : undefined,
        });
        result = requirePersistedArtifacts(call.name, result);
        if (terminalLike) this.store.emit(runId, "terminal.completed", { callId: call.id, exitCode: result.ok ? 0 : 1, taskId: task.id });
        if (result.ok) {
          const output = result.output ?? "";
          const isTerminal = ["terminal", "run_command", "ssh_exec"].includes(call.name);
          const persisted = FILE_PRODUCING_TOOLS.has(call.name) ? parsePersistedArtifacts(output, result.artifacts) : [];
          for (const art of persisted) {
            artifacts.push(art.artifactId);
            this.store.emit(runId, "artifact.created", {
              artifactId: art.artifactId,
              id: art.artifactId,
              name: art.name,
              mimeType: art.mimeType,
              size: art.size,
              sha256: art.sha256,
              previewable: Boolean(art.previewUrl) || (art.mimeType ?? "").startsWith("image/"),
              downloadable: true,
              kind: art.kind ?? (call.name === "generate_image" ? "generated" : "file"),
              downloadPath: art.downloadUrl ?? `/artifacts/${art.artifactId}/download`,
              previewUrl: art.previewUrl,
              runId,
              tool: call.name,
            });
          }
          this.store.emit(runId, "tool.completed", {
            callId: call.id,
            tool: call.name,
            preview: output.slice(0, 300),
            artifactId: persisted[0]?.artifactId,
            artifactName: persisted[0]?.name,
            ...(isTerminal ? { output: output.slice(-16000), outputTruncated: output.length > 16000 } : {}),
            ...(result.envelope ? { envelope: envelopeForEvent({ ...result.envelope, toolUseId: call.id }) } : {}),
          });
          // The transcript is the reviewer's evidence: include real output, not
          // just "-> ok", or the reviewer will reject verified work as unproven.
          const evidenceLine = (result.output ?? "").replace(/\s+/g, " ").slice(0, 400);
          if (evidenceLine) evidence.push(`${call.name}: ${evidenceLine}`);
          transcript.push(`${call.name}(${JSON.stringify(call.arguments).slice(0, 160)}) -> ok${evidenceLine ? `: ${evidenceLine}` : ""}`);
          messages.push({ role: "tool", name: call.name, toolCallId: call.id, content: clampToolOutput(result.output ?? "", MAX_TOOL_OUTPUT_CHARS).text });
        } else {
          // Typed error taxonomy — the same recovery model the main runtime
          // uses: repairable args, retryable transients, permission/policy
          // denials and capability gaps each carry distinct guidance, so the
          // worker isn't told to "try a different approach" for a transient
          // timeout (or to retry a flat denial).
          const classified = classifyToolError({ tool: call.name, error: result.error, errorType: result.errorType });
          this.store.emit(runId, "tool.error.classified", {
            callId: call.id,
            tool: call.name,
            taskId: task.id,
            errorClass: classified.toolErrorClass,
            code: classified.code,
          });
          this.store.emit(runId, "tool.failed", { callId: call.id, tool: call.name, error: result.error, errorClass: classified.toolErrorClass, ...(result.envelope ? { envelope: envelopeForEvent({ ...result.envelope, toolUseId: call.id }) } : {}) });
          errors.push(`${call.name} [${classified.toolErrorClass}]: ${result.error}`);
          transcript.push(`${call.name} -> FAILED [${classified.toolErrorClass}]: ${result.error}`);
          messages.push({
            role: "tool",
            name: call.name,
            toolCallId: call.id,
            content: `FAILED: ${result.error}. ${recoveryGuidance(classified)}`,
          });
        }
      }
    }

    // A worker that burned its whole model-call allowance without finishing
    // did not complete — "the loop simply ended" must never read as success.
    if (!failedReason && !this.isCancelled(runId) && step >= DELEGATION_POLICY.workerMaxModelCalls) {
      failedReason = `worker model-call budget exhausted (${modelCalls}/${DELEGATION_POLICY.workerMaxModelCalls})`;
      this.store.emit(runId, "worker.budget", { workerId, taskId: task.id, kind: "model_calls", used: modelCalls, limit: DELEGATION_POLICY.workerMaxModelCalls });
      transcript.push(`Worker model-call budget exhausted (${modelCalls}/${DELEGATION_POLICY.workerMaxModelCalls})`);
      errors.push(failedReason);
    }

    const status: WorkerResult["status"] = this.isCancelled(runId)
      ? "cancelled"
      : failedReason
        ? "failed"
        : "completed";
    // The structured result is what the orchestrator, reviewer and ledger
    // consume — a string transcript alone loses what the machine knows.
    const outcome: WorkerResult = {
      workerId,
      role: task.agent,
      task: task.description,
      status,
      summary: transcript.join("\n").slice(0, 8000) || "(no output)",
      evidence: evidence.slice(0, 20),
      artifacts,
      errors: errors.slice(0, 20),
      tokensUsed: workerTokens,
      creditsUsed: Math.round(workerCredits * 100) / 100,
      modelCalls,
      durationMs: Date.now() - workerStart,
    };
    this.store.emit(runId, status === "completed" ? "worker.completed" : status === "cancelled" ? "worker.cancelled" : "worker.failed", {
      workerId,
      role: task.agent,
      taskId: task.id,
      status,
      tokensUsed: outcome.tokensUsed,
      creditsUsed: outcome.creditsUsed,
      modelCalls: outcome.modelCalls,
      durationMs: outcome.durationMs,
      artifactCount: artifacts.length,
      errorCount: errors.length,
      ...(failedReason ? { reason: failedReason } : {}),
    });
    return outcome;
  }

  // ORION (reviewer model) judges each task result strictly. A malformed
  // verdict counts as a rejection — silently approving would disable review.
  private async reviewTask(
    runId: string,
    reviewer: AIModelProvider,
    goal: string,
    task: Task
  ): Promise<{ approved: boolean; notes: string }> {
    try {
      const response = await this.callWithFailover(runId, reviewer, {
        messages: [
          {
            role: "system",
            content: [
              "You are ORION acting as reviewer. Judge whether the task was genuinely completed.",
              "Be strict: reject vague claims, unverified work, or partial completion.",
              "The worker log lists each tool call with its REAL output — successful tool",
              "outputs (file contents, command output, page titles, click results, console",
              "reports) ARE evidence; do not demand re-proof of what the log already shows.",
              "Judge only the assigned task, not the rest of the goal.",
              'Respond with ONLY JSON: {"approved": true|false, "notes": "specific, actionable"}',
              LANGUAGE_RULE,
            ].join("\n"),
          },
          {
            role: "user",
            content: `Goal: ${goal}\nTask (${task.agent}): ${task.description}\n\nWhat the worker did:\n${task.result ?? "(nothing)"}`,
          },
        ],
        signal: modelCallSignal(this.signalFor(runId)),
      }, "task_reviewer");
      const parsed = extractJson(response.content);
      return {
        approved: parsed.approved === true,
        notes: String(parsed.notes ?? ""),
      };
    } catch (err: any) {
      return { approved: false, notes: `Reviewer output could not be parsed (${err.message}); treating as rejected.` };
    }
  }

  resolveApproval(callId: string, approved: boolean, scope: ApprovalScope = "once"): boolean {
    const p = this.pending.get(callId);
    if (!p) return false;
    this.pending.delete(callId);
    if (approved && scope !== "once") {
      // Future calls to this tool in this run skip the prompt (destructive
      // commands excepted — they always ask).
      const set = this.missionApproved.get(p.runId) ?? new Set<string>();
      set.add(p.tool);
      this.missionApproved.set(p.runId, set);
    }
    p.resolve(approved);
    return true;
  }
}
