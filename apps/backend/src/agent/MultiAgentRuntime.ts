import { CONVERSATION_STYLE } from "./conversationStyle";
// apps/backend/src/agent/MultiAgentRuntime.ts
//
// The Astra mission loop:
//
//   ASTRA (orchestrator role, planner/reviewer model)
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

import { randomUUID } from "crypto";
import { AIMessage, AIModelProvider, Attachment, ToolDefinition } from "@orvyn/ai-core";
import { ModelService } from "../services/ModelService";
import { ToolGateway } from "../gateway/ToolGateway";
import { AITool, ToolPermission } from "../ai/ToolTypes";
import { DockerSandbox } from "../sandbox/DockerSandbox";
import { makeSandboxTerminalTool, SANDBOX_DENIED_TOOLS, sandboxDenialMessage } from "../ai/tools/sandboxTools";
import { ModelGateway } from "../gateway/ModelGateway";
import type { AgentRole } from "../gateway/PermissionEngine";
import { isDestructiveCommand } from "../ai/tools/terminalTool";
import { playwrightAvailable } from "../ai/tools/browserTools";
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

interface PendingApproval {
  resolve: (approved: boolean) => void;
  /** For "Allow for Mission": which run and tool this approval covers. */
  runId: string;
  tool: string;
}

export type ApprovalScope = "once" | "mission";

const MAX_TASKS = 12;
const MAX_REVISIONS = 2;        // per task, before giving up and moving on
const MAX_EXECUTOR_STEPS = 10;  // tool calls per task attempt

/** Which specialists Astra may delegate to today (browser needs Playwright). */
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

    // A mission still waiting in the queue never reaches the orchestrate()
    // guard below — mark it terminal HERE so "stopped" is immediately true.
    const run = this.store.get(runId);
    if (run && !run.events.some((e) => e.type === "run.started")) {
      this.store.emit(runId, "run.cancelled", { reason: "Stopped by user before it started" });
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

  private finishCancelled(runId: string, missionId?: string): void {
    this.store.emit(runId, "run.cancelled", { reason: "Stopped by user" });
    if (missionId) this.taskEngine.setMissionStatus(missionId, "BLOCKED");
    this.store.setStatus(runId, "cancelled");
    this.missionApproved.delete(runId);
    this.controllers.delete(runId);
  }

  private toolDefinitionsFor(role: AgentRole): ToolDefinition[] {
    return this.tools
      .list()
      .filter((t) => ROLE_TOOLS[role](t.name))
      .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  }

  start(projectRoot: string, goal: string, rules?: string, attachments?: Attachment[]): string {
    const runId = randomUUID();
    this.store.create(runId, projectRoot);
    applyMode(this.tools.registry, "multitask");
    this.tools.applyProfile();
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
      if (this.store.get(runId)?.status !== "cancelled") this.finishCancelled(runId);
      return;
    }
    // The queue slot is ours — flip from queued to genuinely running.
    if (this.store.get(runId)?.status === "queued") this.store.setStatus(runId, "running");
    this.store.emit(runId, "run.started", { instruction: goal, mode: "multitask" });
    const mission = this.taskEngine.createMission(runId, projectRoot, goal);

    // Sandbox mode: command-class tools execute inside a per-mission Docker
    // container, never on the API host (master spec §31). Enabled per
    // environment — cloud deployments set ORVYN_MISSION_EXECUTION=sandbox.
    let sandbox: DockerSandbox | undefined;
    const sandboxMode = process.env.ORVYN_MISSION_EXECUTION?.trim() === "sandbox";
    let originalTerminal: AITool | undefined;
    let originalRunCommand: AITool | undefined;
    const savedPermissions = new Map<string, ToolPermission>();

    if (sandboxMode) {
      sandbox = await DockerSandbox.start(mission.id, projectRoot);
      this.store.emit(runId, "sandbox.started", { container: sandbox.containerId, image: "isolated", network: "none" });
      // Swap the command tools for sandbox-backed equivalents; the swap is
      // undone in the finally below so later host runs are unaffected.
      originalTerminal = this.tools.list().find((t) => t.name === "terminal");
      originalRunCommand = this.tools.list().find((t) => t.name === "run_command");
      for (const t of this.tools.list()) savedPermissions.set(t.name, this.tools.getPermission(t.name));
      const sandboxTerminal = makeSandboxTerminalTool(sandbox);
      this.tools.register(sandboxTerminal);
      this.tools.registerAlias("run_command", "terminal");
      for (const denied of SANDBOX_DENIED_TOOLS) {
        this.tools.setPermission(denied, "denied");
      }
    }

    try {
      // ---------- ASTRA: PLAN ----------
      this.taskEngine.setMissionStatus(mission.id, "PLANNING");
      const astra = this.models.resolveRole("orchestrator");
      this.store.emit(runId, "thinking", { role: "astra", model: astra.config.id });

      const planResponse = await this.modelService.usage.with(
        { missionId: mission.id, agent: "orchestrator" },
        () =>
          generateEnglish(astra, {
        messages: [
          {
            role: "system",
            content: [
              "You are ASTRA, the orchestrator of ORVYN's engineering agents.",
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
              '{"tasks":[{"description":"...","agent":"coder"}]}',
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
          })
      );

      try {
        const parsed = extractJson(planResponse.content);
        const raw: any[] = (parsed.tasks ?? []).slice(0, MAX_TASKS);
        const allowed = delegatable();
        for (const t of raw) {
          const agent = allowed.includes(t.agent) ? (t.agent as AgentRole) : "coder";
          this.taskEngine.addTask(mission.id, String(t.description ?? t), agent);
        }
      } catch (err: any) {
        this.store.emit(runId, "run.error", {
          message: `Astra did not return valid JSON: ${err.message}. Raw: ${planResponse.content.slice(0, 200)}`,
        });
        this.taskEngine.setMissionStatus(mission.id, "FAILED");
        this.store.setStatus(runId, "error");
        return;
      }

      if (mission.tasks.length === 0) {
        // NO_TASK_NEEDED vs PLANNING_FAILED: an empty task list usually means
        // the request was conversational and slipped past the client-side
        // intent router. That is not an engineering failure — complete the
        // mission with an honest explanation instead of an error, so no
        // surface ever shows "ERROR" for "hi".
        const note =
          "This request didn't need engineering steps — it looks conversational. " +
          "Ask it in the Chat tab for a direct answer, or describe the change you want made and run it as Code.";
        for (const chunk of note.match(/.{1,24}/gs) ?? []) {
          this.store.emit(runId, "message.delta", { content: chunk });
        }
        this.store.emit(runId, "message.completed", {});
        this.store.emit(runId, "run.completed", { tasksTotal: 0, tasksCompleted: 0, tasksFailed: 0, missionStatus: "COMPLETED" });
        this.taskEngine.setMissionStatus(mission.id, "COMPLETED");
        this.store.setStatus(runId, "completed");
        return;
      }

      this.store.emit(runId, "plan.created", {
        plannerModel: astra.config.id,
        missionId: mission.id,
        tasks: mission.tasks.map((t) => ({ id: t.id, description: t.description, agent: t.agent })),
      });
      this.taskEngine.setMissionStatus(mission.id, "RUNNING");

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

      // ---------- WORKERS: EXECUTE, ASTRA: REVIEW EACH ----------
      const reviewer = this.models.resolveTask("reviewer");

      for (const task of mission.tasks.slice()) {
        if (this.isCancelled(runId)) return this.finishCancelled(runId, mission.id);
        await this.processTask(runId, mission, task, goal, reviewer, rules);
      }
      if (this.isCancelled(runId)) return this.finishCancelled(runId, mission.id);

      // ---------- MANDATORY FINAL MISSION REVIEW (Review Engine) ----------
      let blocked = false;
      for (;;) {
        this.taskEngine.setMissionStatus(mission.id, "REVIEW");
        this.store.emit(runId, "review.started", {
          missionId: mission.id,
          scope: "mission",
          reviewerModel: reviewer.config.id,
        });

        const verdict = await this.modelService.usage.with(
          { missionId: mission.id, agent: "reviewer" },
          () => this.reviewEngine.reviewMission(mission, rules)
        );

        if (verdict.status === "approved") {
          this.bus.reviewApproved(runId, mission.id, verdict.score);
          if (verdict.warnings.length > 0) {
            this.store.emit(runId, "review.passed", { missionId: mission.id, notes: verdict.warnings.join("; ") });
          }
          break;
        }

        const cycle = this.taskEngine.incrementReviewCycles(mission.id);
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
          this.taskEngine.setMissionStatus(mission.id, "BLOCKED");
          break;
        }

        // Rejected with concrete corrections: Astra assigns rework to the coder.
        for (const change of verdict.requiredChanges.slice(0, 4)) {
          const correction = this.taskEngine.addTask(mission.id, `[review correction] ${change}`, "coder");
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
        this.store.emit(runId, "run.error", { message: err.message });
        this.store.emit(runId, "mission.blocked", { missionId: mission.id, reason: err.message });
        this.taskEngine.setMissionStatus(mission.id, "BLOCKED");
        this.store.setStatus(runId, "error");
        return;
      }
      this.store.emit(runId, "run.error", { message: err.message });
      this.taskEngine.setMissionStatus(mission.id, "FAILED");
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

        // Restore the host tool set exactly as it was.
        if (originalTerminal) this.tools.register(originalTerminal);
        if (originalRunCommand) this.tools.register(originalRunCommand);
        for (const [name, permission] of savedPermissions) this.tools.setPermission(name, permission);
      }
    }
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
    let accepted = false;

    while (task.attempts <= MAX_REVISIONS && !accepted) {
      task.attempts++;
      this.taskEngine.transition(mission.id, task.id, "RUNNING");

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
      task.result = result;

      this.taskEngine.transition(mission.id, task.id, "REVIEW");
      this.store.emit(runId, "review.started", { taskId: task.id, reviewerModel: reviewer.config.id });

      const verdict = await this.modelService.usage.with(
        { missionId: mission.id, taskId: task.id, agent: "reviewer" },
        () => this.reviewTask(runId, reviewer, goal, task)
      );

      if (verdict.approved) {
        accepted = true;
        this.taskEngine.transition(mission.id, task.id, "COMPLETED");
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
          this.taskEngine.transition(mission.id, task.id, "FAILED");
          this.store.emit(runId, "task.failed", { taskId: task.id, reason: verdict.notes });
          this.bus.agentCompleted(runId, task.agent, task.id, false);
        } else {
          this.taskEngine.transition(mission.id, task.id, "REWORK");
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

    const summary = await this.modelService.usage.with(
      { missionId: mission.id, agent: "orchestrator" },
      () =>
        generateEnglish(astra, {
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
        })
    );

    for (const chunk of (summary.content ?? "").match(/.{1,24}/gs) ?? []) {
      this.store.emit(runId, "message.delta", { content: chunk });
    }
    this.store.emit(runId, "message.completed", {});
    this.store.emit(runId, "run.completed", {
      tasksTotal: mission.tasks.length,
      tasksCompleted: done,
      tasksFailed: mission.tasks.length - done,
      missionStatus,
    });
    if (!blocked) {
      this.taskEngine.setMissionStatus(mission.id, "COMPLETED");
    }
    this.missionApproved.delete(runId);
    this.store.setStatus(runId, "completed");
  }

  private workerModelFor(role: AgentRole): AIModelProvider {
    return this.models.resolveRole(role);
  }

  // Runs one task on the worker's model with the worker's tool subset and the
  // standard approval gates. Returns a transcript for the reviewer.
  private async runWorker(
    runId: string,
    worker: AIModelProvider,
    task: Task,
    goal: string,
    projectRoot: string,
    rules?: string
  ): Promise<string> {
    // Targeted context, not the whole repo (Context Engine v1: ripgrep + diff).
    const context = await this.contextEngine.buildTaskContext(
      task.description,
      task.reviewNotes ? task.result : undefined
    );

    // file:// URLs must be absolute; agents can't discover the root themselves.
    const fileUrlRoot = `file:///${projectRoot.replace(/\\/g, "/")}`;

    const messages: AIMessage[] = [
      {
        role: "system",
        content: [
          WORKER_PROMPTS[task.agent] ?? WORKER_PROMPTS.coder,
          CONVERSATION_STYLE,
          LANGUAGE_RULE,
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
    const toolDefs = this.toolDefinitionsFor(task.agent);

    for (let step = 0; step < MAX_EXECUTOR_STEPS; step++) {
      // Unwind promptly rather than burning the worker's remaining steps.
      if (this.isCancelled(runId)) break;
      // Safe boundary: deliver any steered user instructions to the model.
      for (const t of this.store.takeSteer(runId)) {
        messages.push({ role: "user", content: `[User steering instruction — applies from now on] ${t}` });
      }
      let response;
      try {
        response = await generateEnglish(worker, { messages, tools: toolDefs, signal: modelCallSignal(this.signalFor(runId)) });
      } catch (err: any) {
        if (this.isCancelled(runId)) break;
        // Surface it — a silent break here looks like the agent "gave up
        // after one tool call" in the UI, which is undebuggable.
        this.store.emit(runId, "tool.failed", {
          taskId: task.id,
          tool: "model",
          error: `Worker model error: ${String(err.message).slice(0, 300)}`,
        });
        transcript.push(`Worker model error: ${err.message}`);
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

        const permission = this.tools.getPermission(call.name);
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
        if (call.name === "generate_image") {
          this.store.emit(runId, "image.generated", { prompt: (call.arguments as { prompt?: unknown }).prompt });
        }

        const result = await this.tools.execute(call.name, call.arguments, task.agent);
        if (result.ok) {
          const output = result.output ?? "";
          const isTerminal = ["terminal", "run_command", "ssh_exec"].includes(call.name);
          this.store.emit(runId, "tool.completed", {
            callId: call.id,
            tool: call.name,
            preview: output.slice(0, 300),
            ...(isTerminal ? { output: output.slice(-16000), outputTruncated: output.length > 16000 } : {}),
          });
          // The transcript is the reviewer's evidence: include real output, not
          // just "-> ok", or the reviewer will reject verified work as unproven.
          const evidence = (result.output ?? "").replace(/\s+/g, " ").slice(0, 400);
          transcript.push(`${call.name}(${JSON.stringify(call.arguments).slice(0, 160)}) -> ok${evidence ? `: ${evidence}` : ""}`);
          messages.push({ role: "tool", name: call.name, toolCallId: call.id, content: clampToolOutput(result.output ?? "", MAX_TOOL_OUTPUT_CHARS).text });
        } else {
          this.store.emit(runId, "tool.failed", { callId: call.id, tool: call.name, error: result.error });
          transcript.push(`${call.name} -> FAILED: ${result.error}`);
          messages.push({
            role: "tool",
            name: call.name,
            toolCallId: call.id,
            content: `FAILED: ${result.error}. Diagnose and try a different approach.`,
          });
        }
      }
    }

    return transcript.join("\n").slice(0, 8000);
  }

  // Astra (reviewer model) judges each task result strictly. A malformed
  // verdict counts as a rejection — silently approving would disable review.
  private async reviewTask(
    runId: string,
    reviewer: AIModelProvider,
    goal: string,
    task: Task
  ): Promise<{ approved: boolean; notes: string }> {
    try {
      const response = await generateEnglish(reviewer, {
        messages: [
          {
            role: "system",
            content: [
              "You are ASTRA acting as reviewer. Judge whether the task was genuinely completed.",
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
      });
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
    if (approved && scope === "mission") {
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
