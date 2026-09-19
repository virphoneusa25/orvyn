// apps/backend/src/agent/StreamingAgentRuntime.ts
//
// The agent loop, re-expressed as an event producer. Instead of returning a
// session object at the end, it emits typed events as it works, so the UI can
// render "Searching…", "Reading src/auth.ts", "Running npm test" live.
//
// Runs are driven forward in the background; the HTTP layer just subscribes to
// the event stream. That separation is what allows a client to disconnect and
// resume without disturbing the run.

import { randomUUID } from "crypto";
import { AIMessage, Attachment, ToolCall, ToolDefinition } from "@orvyn/ai-core";
import { ModelService } from "../services/ModelService";
import { ToolGateway } from "../gateway/ToolGateway";
import { isDestructiveCommand } from "../ai/tools/terminalTool";
import { RunStore } from "./events";
import { AgentMode, applyMode } from "./modes";
import { clampToolOutput, compactConversation, estimateConversationTokens, MAX_TOOL_OUTPUT_CHARS } from "./contextBudget";
import { EditPreview, isFileMutatingTool, previewToolEdit } from "./editPreview";
import { CheckpointEngine } from "../checkpoint/CheckpointEngine";

interface PendingApproval {
  call: ToolCall;
  destructive: boolean;
  resolve: (approved: boolean) => void;
  /** For "Allow for Run": which run this approval belongs to. */
  runId: string;
}

export type ApprovalScope = "once" | "mission";

/**
 * Per-run state. This used to live on the instance, which meant two concurrent
 * runs in different modes silently shared one another's settings.
 */
interface RunState {
  controller: AbortController;
  toolsEnabled: boolean;
  projectRoot: string;
  /** Tools the user approved for the rest of this run. */
  approvedTools: Set<string>;
  cancelled: boolean;
  /** Tool executions this run, for the runaway guard. */
  toolCalls: number;
  /** Model calls this run — counted directly, since not every provider
   * reports token usage and the cap must fire regardless. */
  modelCalls: number;
}

/**
 * Agentic work is iterative: investigate, change, verify, repeat. A ceiling in
 * the teens cuts real tasks off mid-verification, so the limit is high enough
 * to finish and exists only as a runaway guard. Context pressure is handled by
 * compaction rather than by refusing to continue.
 */
const MAX_STEPS = Number(process.env.ORVYN_AGENT_MAX_STEPS) || 48;
const FAILURE_CIRCUIT_BREAKER = 5;

/**
 * Per-run runaway guards (spec §45), independent of the step ceiling because
 * one step can fan out into several tool calls and a lot of tokens. Read from
 * env on each check so they can be tuned without a restart; 0 disables.
 */
function runCap(name: string): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Tools that own shared external state and therefore cannot be parallelised,
 * even though their capability class looks harmless. One browser session
 * cannot be on two pages at once.
 */
const SERIAL_ONLY_TOOLS = new Set([
  "browser_open",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_screenshot",
]);

export class StreamingAgentRuntime {
  private pending = new Map<string, PendingApproval>();
  private runs = new Map<string, RunState>();

  constructor(
    private modelService: ModelService,
    private tools: ToolGateway,
    private store: RunStore,
    /** When supplied, every run gets a pre-run snapshot that powers Undo. */
    private checkpoints?: CheckpointEngine
  ) {}

  private toolDefinitions(): ToolDefinition[] {
    return this.tools
      .list()
      .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  }

  // Maps a tool call onto the richer domain events the UI renders as cards,
  // so the frontend doesn't have to special-case tool names itself.
  private emitDomainEvent(runId: string, call: ToolCall, preview?: EditPreview): void {
    const args = call.arguments as Record<string, unknown>;
    switch (call.name) {
      case "read_file":
        this.store.emit(runId, "file.read", { path: args.path });
        break;
      case "write_file":
      case "edit_file":
      case "delete_file":
      case "move_file":
        // The diff rides along so the UI can show what changed rather than
        // just naming the file.
        this.store.emit(runId, "file.edit", { path: args.path ?? args.from, preview });
        break;
      case "terminal":
        this.store.emit(runId, "terminal.started", { command: args.command });
        break;
      case "generate_image":
        this.store.emit(runId, "image.generated", { prompt: args.prompt });
        break;
      default:
        break;
    }
  }

  /**
   * Usable history budget for a model: its window, less the space its own
   * reply needs, less headroom for the tool schemas and estimator error.
   */
  private contextBudget(): number {
    const provider = this.modelService.router.resolve("agent");
    const window = provider.config.contextWindow || 32_000;
    const reserved = (provider.config.maxOutputTokens || 4_000) + 4_000;
    return Math.max(8_000, Math.floor(window * 0.9) - reserved);
  }

  /** Read-ish tools may run concurrently; anything that mutates runs in order. */
  private isParallelSafe(name: string): boolean {
    if (SERIAL_ONLY_TOOLS.has(name)) return false;
    const caps = this.tools.permissions.capabilitiesOf(name);
    // Unknown tools resolve to SYSTEM and correctly fail this test.
    return caps.every((c) => c === "READ" || c === "GIT" || c === "NETWORK");
  }

  /** Starts a run and returns immediately; the loop continues in the background. */
  start(
    projectRoot: string,
    instruction: string,
    rules?: string,
    mode: AgentMode = "agent",
    attachments?: Attachment[]
  ): string {
    const runId = randomUUID();
    this.store.create(runId, projectRoot);

    // Mode controls tool permissions as well as prompting, so a read-only
    // mode genuinely cannot write even if the model tries.
    const def = applyMode(this.tools.registry, mode);
    this.tools.applyProfile();

    this.runs.set(runId, {
      controller: new AbortController(),
      toolsEnabled: def.toolsEnabled,
      projectRoot,
      approvedTools: new Set(),
      cancelled: false,
      toolCalls: 0,
      modelCalls: 0,
    });

    // Snapshot the dirty tree before the agent touches anything, so a
    // one-click Undo can put it back. Best-effort: a non-git folder simply
    // has no undo (gitHead is null there — an empty snapshot would make Undo
    // a silent no-op, so it is skipped and the button reports why).
    if (this.checkpoints) {
      void this.checkpoints
        .create(projectRoot, { note: `pre-run: ${instruction.slice(0, 80)}` })
        .then((cp) => {
          if (!cp.gitRepo) return;
          this.store.setCheckpoint(runId, cp.id);
          this.store.emit(runId, "checkpoint.created", {
            id: cp.id,
            note: "pre-run snapshot (Undo available)",
            files: cp.files.length,
          });
        })
        .catch(() => {
          // No checkpoint, no Undo — not worth failing the run over.
        });
    }

    const messages: AIMessage[] = [
      {
        role: "system",
        content: [
          def.systemPrompt,
          // Without the root the agent has no anchor: vague instructions used
          // to produce a greeting instead of an investigation.
          `Project root (absolute): ${projectRoot}`,
          "File tools take paths relative to the project root. Start vague tasks with list_directory on \".\".",
          "You may request several independent tools in one turn — they are executed together, which is faster than one per turn.",
          rules ? `\nProject rules:\n${rules}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      },
      { role: "user", content: instruction, attachments },
    ];

    // Deliberately not awaited: the caller gets a runId synchronously and
    // subscribes to events. Errors are surfaced as run.error events.
    void this.loop(runId, messages, instruction, mode);
    return runId;
  }

  /**
   * Stops a run: aborts the in-flight model request, denies anything waiting on
   * approval, and marks the run cancelled. Safe to call more than once.
   */
  cancel(runId: string): boolean {
    const state = this.runs.get(runId);
    if (!state || state.cancelled) return false;
    state.cancelled = true;

    // Release the loop if it is parked on an approval, otherwise it would hang
    // forever holding the abort it can no longer observe.
    for (const [callId, p] of this.pending) {
      if (p.runId === runId) {
        this.pending.delete(callId);
        p.resolve(false);
      }
    }

    state.controller.abort();
    return true;
  }

  private finishCancelled(runId: string, steps: number): void {
    this.store.emit(runId, "run.cancelled", { steps, reason: "Stopped by user" });
    this.store.setStatus(runId, "cancelled");
  }

  private async loop(
    runId: string,
    messages: AIMessage[],
    instruction: string,
    mode: AgentMode = "agent"
  ): Promise<void> {
    const state = this.runs.get(runId);
    if (!state) return;
    const signal = state.controller.signal;

    this.store.emit(runId, "run.started", { instruction, mode, maxSteps: MAX_STEPS });

    let steps = 0;
    let consecutiveFailures = 0;

    try {
      while (steps < MAX_STEPS) {
        if (state.cancelled) return this.finishCancelled(runId, steps);

        if (consecutiveFailures >= FAILURE_CIRCUIT_BREAKER) {
          this.store.emit(runId, "run.error", {
            message: `Stopped after ${FAILURE_CIRCUIT_BREAKER} consecutive tool failures without recovery.`,
          });
          this.store.setStatus(runId, "error");
          return;
        }
        steps++;

        // Runaway guards (spec §45): stop the run with a clear reason before
        // the next model call rather than failing opaquely mid-mission.
        const capRequests = runCap("ORVYN_RUN_MAX_MODEL_REQUESTS");
        if (capRequests > 0 && state.modelCalls >= capRequests) {
          this.store.emit(runId, "run.error", {
            message: `Run budget exceeded — model requests: ${state.modelCalls}/${capRequests}. Set ORVYN_RUN_MAX_MODEL_REQUESTS higher (0 disables).`,
          });
          this.store.setStatus(runId, "error");
          return;
        }
        const capTokens = runCap("ORVYN_RUN_MAX_TOKENS");
        const runUsage = this.store.get(runId)?.usage;
        const spent = runUsage ? runUsage.promptTokens + runUsage.completionTokens : 0;
        if (capTokens > 0 && spent >= capTokens) {
          this.store.emit(runId, "run.error", {
            message: `Run budget exceeded — tokens: ${spent}/${capTokens}. Set ORVYN_RUN_MAX_TOKENS higher (0 disables).`,
          });
          this.store.setStatus(runId, "error");
          return;
        }
        state.modelCalls++;

        this.store.emit(runId, "thinking", { step: steps, maxSteps: MAX_STEPS });

        // Keep the conversation inside the window before asking, not after
        // the server rejects it.
        const compaction = compactConversation(messages, this.contextBudget());
        if (compaction.compacted) {
          messages.splice(0, messages.length, ...compaction.messages);
          this.store.emit(runId, "context.compacted", {
            tokensBefore: compaction.tokensBefore,
            tokensAfter: compaction.tokensAfter,
            droppedTurns: compaction.droppedTurns,
            elidedResults: compaction.elidedResults,
          });
        }

        const provider = this.modelService.router.resolve("agent");
        let content = "";
        let reasoning = "";
        let streamedText = false;
        const streamedCalls: ToolCall[] = [];

        for await (const chunk of provider.stream({
          messages,
          tools: state.toolsEnabled && provider.supportsTools() ? this.toolDefinitions() : undefined,
          stream: true,
          signal,
        })) {
          if (chunk.delta) {
            content += chunk.delta;
            streamedText = true;
            this.store.emit(runId, "message.delta", { content: chunk.delta });
          }
          if (chunk.toolCall) streamedCalls.push(chunk.toolCall);
          if (chunk.reasoning) reasoning = chunk.reasoning;
          if (chunk.usage) {
            const total = this.store.addUsage(runId, chunk.usage);
            if (total) {
              this.store.emit(runId, "usage.updated", {
                ...total,
                contextTokens: estimateConversationTokens(messages),
                contextBudget: this.contextBudget(),
                modelId: provider.config.id,
              });
            }
          }
          if (chunk.done) break;
        }

        if (state.cancelled) return this.finishCancelled(runId, steps);

        // Drop malformed calls rather than sending the model a reply to a tool
        // it never named; keep duplicates out so one id is answered once.
        const seen = new Set<string>();
        const calls = streamedCalls.filter((c) => {
          if (!c?.name || seen.has(c.id)) return false;
          seen.add(c.id);
          return true;
        });

        if (calls.length > 0) {
          // Record the assistant turn that requested the tools BEFORE pushing
          // any tool result. OpenAI-style APIs reject a tool message that is
          // not preceded by the matching assistant tool_calls message, and
          // every call listed here must get exactly one reply below. Thinking
          // models additionally require their reasoning echoed back.
          messages.push({
            role: "assistant",
            content: content || "",
            ...(reasoning ? { reasoningContent: reasoning } : {}),
            toolCalls: calls,
          });
          // Narration ("I'll check the auth flow first…") used to land only in
          // history. Close it as its own utterance so the UI can pin it above
          // the tool card instead of waiting for the final answer.
          this.emitNarration(runId, content, streamedText);

          // Tool-call runaway guard, checked before the batch so no call is
          // left unanswered by stopping mid-batch.
          const capTools = runCap("ORVYN_RUN_MAX_TOOL_CALLS");
          if (capTools > 0 && state.toolCalls >= capTools) {
            this.store.emit(runId, "run.error", {
              message: `Run budget exceeded — tool calls: ${state.toolCalls}/${capTools}. Set ORVYN_RUN_MAX_TOOL_CALLS higher (0 disables).`,
            });
            this.store.setStatus(runId, "error");
            return;
          }
          state.toolCalls += calls.length;

          const outcome = await this.executeToolCalls(runId, state, calls, messages);
          if (outcome === "cancelled") return this.finishCancelled(runId, steps);
          consecutiveFailures = outcome === "all_failed" ? consecutiveFailures + 1 : 0;
          continue;
        }

        // No tool call: token deltas were already emitted while streaming.
        this.emitNarration(runId, content, streamedText);
        this.store.emit(runId, "run.completed", { steps });
        this.store.setStatus(runId, "completed");
        return;
      }

      this.store.emit(runId, "run.error", { message: `Stopped after ${MAX_STEPS} steps without finishing.` });
      this.store.setStatus(runId, "error");
    } catch (err: any) {
      // An abort surfaces here as a fetch rejection; it is a cancellation, not
      // a failure, and must not be reported as one.
      if (state.cancelled || err?.name === "AbortError") {
        return this.finishCancelled(runId, steps);
      }
      this.store.emit(runId, "run.error", { message: err.message });
      this.store.setStatus(runId, "error");
    } finally {
      this.runs.delete(runId);
    }
  }

  /**
   * Runs every tool the model asked for in this turn, and appends exactly one
   * reply per call in the order requested.
   *
   * Approvals are collected first and strictly in sequence — the user sees one
   * prompt at a time — and only then is the approved set executed, with the
   * read-only subset overlapped. Interleaving the two would show a second
   * prompt while the first tool was already running.
   */
  private async executeToolCalls(
    runId: string,
    state: RunState,
    calls: ToolCall[],
    messages: AIMessage[]
  ): Promise<"ok" | "all_failed" | "cancelled"> {
    const replies = new Map<string, string>();
    const runnable: ToolCall[] = [];
    const previews = new Map<string, EditPreview | undefined>();

    for (const call of calls) {
      if (state.cancelled) return "cancelled";

      const permission = this.tools.getPermission(call.name);
      if (permission === "denied") {
        this.store.emit(runId, "tool.failed", { callId: call.id, tool: call.name, error: "Denied by project permissions" });
        replies.set(call.id, `Tool "${call.name}" is denied by project permissions. Try another approach.`);
        continue;
      }

      // Computed before execution because the "before" state is gone after.
      const preview = isFileMutatingTool(call.name)
        ? await previewToolEdit(state.projectRoot, call.name, call.arguments as Record<string, unknown>)
        : undefined;
      previews.set(call.id, preview);

      // Hard boundary: destructive shell commands require approval no matter
      // what the mode/profile granted — a prior "Allow for Run" does not cover
      // them either.
      const destructive =
        (call.name === "terminal" || call.name === "run_command") &&
        isDestructiveCommand(String((call.arguments as any).command ?? ""));
      const runApproved = !destructive && state.approvedTools.has(call.name);

      if ((permission === "ask" && !runApproved) || destructive) {
        this.store.emit(runId, "approval.required", {
          callId: call.id,
          tool: call.name,
          input: call.arguments,
          destructive,
          preview,
        });
        this.store.setStatus(runId, "awaiting_approval");

        const approved = await new Promise<boolean>((resolve) => {
          this.pending.set(call.id, { call, destructive, resolve, runId });
        });

        if (state.cancelled) return "cancelled";

        this.store.emit(runId, "approval.resolved", { callId: call.id, approved });
        this.store.setStatus(runId, "running");

        if (!approved) {
          replies.set(call.id, "The user denied this action. Do not repeat it; consider an alternative.");
          continue;
        }
      }

      runnable.push(call);
    }

    if (state.cancelled) return "cancelled";

    const parallel = runnable.filter((c) => this.isParallelSafe(c.name));
    const serial = runnable.filter((c) => !this.isParallelSafe(c.name));
    let anySucceeded = false;

    const runOne = async (call: ToolCall): Promise<void> => {
      this.store.emit(runId, "tool.started", { callId: call.id, tool: call.name });
      this.store.emit(runId, "tool.input", { callId: call.id, input: call.arguments });
      this.emitDomainEvent(runId, call, previews.get(call.id));

      // Single-agent runs act as the coding worker, so its capability set applies.
      const result = await this.tools.execute(call.name, call.arguments, "coder");

      if (result.ok) {
        anySucceeded = true;
        const raw = result.output ?? "";
        // The model gets the clamped text, not the raw output: one oversized
        // result would otherwise consume the whole window.
        const { text, truncated } = clampToolOutput(raw, MAX_TOOL_OUTPUT_CHARS);
        this.store.emit(runId, "tool.completed", {
          callId: call.id,
          tool: call.name,
          preview: raw.slice(0, 400),
          truncated,
          bytes: raw.length,
        });
        if (call.name === "terminal" || call.name === "run_command") {
          this.store.emit(runId, "terminal.output", { data: raw.slice(0, 2000) });
          this.store.emit(runId, "terminal.completed", { exitOk: true });
        }
        replies.set(call.id, text);
      } else {
        const error = result.error ?? "unknown error";
        this.store.emit(runId, "tool.failed", { callId: call.id, tool: call.name, error });
        if (call.name === "terminal" || call.name === "run_command") {
          this.store.emit(runId, "terminal.completed", { exitOk: false });
        }
        replies.set(
          call.id,
          `The tool "${call.name}" FAILED:\n${error}\n\nDiagnose and try a different approach. Do not repeat the identical call.`
        );
      }
    };

    if (parallel.length > 0) {
      await Promise.all(parallel.map(runOne));
    }
    for (const call of serial) {
      if (state.cancelled) return "cancelled";
      await runOne(call);
    }

    // One reply per requested call, in the order the model asked — anything
    // missing here would be an unanswered tool_call and a hard API error.
    for (const call of calls) {
      messages.push({
        role: "tool",
        name: call.name,
        toolCallId: call.id,
        content: replies.get(call.id) ?? `Tool "${call.name}" produced no result.`,
      });
    }

    return anySucceeded || runnable.length === 0 ? "ok" : "all_failed";
  }

  // Tool-call turns often include a sentence of intent. If the adapter did
  // not stream it as deltas, emit it now; either way, message.completed lets
  // the UI flush that sentence before the next tool card.
  private emitNarration(runId: string, text: string, alreadyStreamed: boolean): void {
    const trimmed = text.trimEnd();
    if (!trimmed) return;
    if (!alreadyStreamed) {
      this.store.emit(runId, "message.delta", { content: trimmed });
    }
    this.store.emit(runId, "message.completed", {});
  }

  /** Resolves a pending approval, unblocking the paused loop. */
  resolveApproval(callId: string, approved: boolean, scope: ApprovalScope = "once"): boolean {
    const p = this.pending.get(callId);
    if (!p) return false;
    this.pending.delete(callId);
    if (approved && scope === "mission" && !p.destructive) {
      this.runs.get(p.runId)?.approvedTools.add(p.call.name);
    }
    p.resolve(approved);
    return true;
  }
}
