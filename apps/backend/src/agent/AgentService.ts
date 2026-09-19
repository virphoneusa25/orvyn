import { randomUUID } from "crypto";
import { AIMessage, ToolCall, ToolDefinition } from "@orvyn/ai-core";
import { ModelService } from "../services/ModelService";
import { ToolRegistry } from "../ai/ToolTypes";
import { isDestructiveCommand } from "../ai/tools/terminalTool";

export type AgentStatus = "running" | "pending_approval" | "completed" | "error";

export interface AgentSession {
  id: string;
  projectRoot: string;
  status: AgentStatus;
  messages: AIMessage[];
  stepCount: number;
  maxSteps: number;
  pendingToolCall?: ToolCall & { destructive: boolean };
  finalOutput?: string;
  errorMessage?: string;
  toolLog: {
    tool: string;
    args: unknown;
    result?: string;
    approved?: boolean;
    failed?: boolean;
    recoveryAttempt?: number;
  }[];
  consecutiveFailures: number;
}

export class AgentService {
  constructor(
    private modelService: ModelService,
    private toolRegistry: ToolRegistry,
    private sessions: Map<string, AgentSession>
  ) {}

  private toolDefinitions(): ToolDefinition[] {
    return this.toolRegistry
      .list()
      .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  }

  // Records a tool outcome. When a tool FAILS we feed the real error text back
  // to the model as a tool message so it can diagnose and change approach —
  // this is what turns a one-shot tool caller into a self-correcting agent.
  private recordResult(
    session: AgentSession,
    call: ToolCall,
    ok: boolean,
    output: string,
    approved?: boolean
  ): void {
    if (ok) session.consecutiveFailures = 0;
    else session.consecutiveFailures++;

    session.toolLog.push({
      tool: call.name,
      args: call.arguments,
      result: output,
      approved,
      failed: !ok,
      recoveryAttempt: ok ? undefined : session.consecutiveFailures,
    });

    session.messages.push({
      role: "tool",
      name: call.name,
      toolCallId: call.id,
      content: ok
        ? output
        : [
            `The tool "${call.name}" FAILED with this error:`,
            output,
            "",
            "Diagnose the cause and try a different approach. Do not repeat the",
            "identical call. If you cannot proceed, explain why to the user.",
          ].join("\n"),
    });
  }

  private async step(session: AgentSession): Promise<void> {
    if (session.stepCount >= session.maxSteps) {
      session.status = "error";
      session.errorMessage = `Agent stopped after ${session.maxSteps} steps without finishing.`;
      return;
    }

    // Circuit breaker: stop burning steps and tokens if the model keeps
    // failing the same way instead of recovering.
    if (session.consecutiveFailures >= 4) {
      session.status = "error";
      session.errorMessage =
        "Agent stopped: 4 consecutive tool failures without recovery. See the tool log for the underlying error.";
      return;
    }

    session.stepCount++;

    const provider = this.modelService.router.resolve("agent");
    let response;
    try {
      response = await provider.generate({
        messages: session.messages,
        tools: provider.supportsTools() ? this.toolDefinitions() : undefined,
      });
    } catch (err: any) {
      session.status = "error";
      session.errorMessage = `Model call failed: ${err.message}`;
      return;
    }

    if (response.toolCalls && response.toolCalls.length > 0) {
      const call = response.toolCalls[0];

      // Record the assistant tool_calls turn before any tool result — required
      // by OpenAI-style APIs.
      session.messages.push({ role: "assistant", content: response.content ?? "", toolCalls: [call] });

      const permission = this.toolRegistry.getPermission(call.name);

      if (permission === "denied") {
        this.recordResult(session, call, false, `Tool "${call.name}" is denied by project permissions.`);
        return this.step(session);
      }

      if (permission === "ask") {
        const destructive =
          call.name === "terminal" && isDestructiveCommand(String((call.arguments as any).command ?? ""));
        session.status = "pending_approval";
        session.pendingToolCall = { ...call, destructive };
        return;
      }

      const result = await this.toolRegistry.execute(call.name, call.arguments);
      this.recordResult(session, call, result.ok, result.ok ? result.output ?? "" : result.error ?? "unknown error");
      return this.step(session);
    }

    session.status = "completed";
    session.finalOutput = response.content;
  }

  async start(projectRoot: string, instruction: string, rules?: string, maxSteps = 16): Promise<AgentSession> {
    const session: AgentSession = {
      id: randomUUID(),
      projectRoot,
      status: "running",
      messages: [
        {
          role: "system",
          content: [
            "You are Orvyn's coding Agent. You can read files, search, and — with",
            "user approval — write files, run terminal commands, and use git.",
            "",
            "Work iteratively and verify your own work:",
            "1. Investigate before changing anything (read/search relevant files).",
            "2. Make the change.",
            "3. VERIFY it — run the build or tests via the terminal tool where possible.",
            "4. If verification fails, read the error, diagnose it, and fix it. Do not",
            "   repeat a call that just failed; change your approach.",
            "5. Finish only when the task is done and verified, then summarise what",
            "   you changed and how you confirmed it.",
            rules ? `\nProject rules:\n${rules}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        },
        { role: "user", content: instruction },
      ],
      stepCount: 0,
      maxSteps,
      toolLog: [],
      consecutiveFailures: 0,
    };
    this.sessions.set(session.id, session);
    await this.step(session);
    return session;
  }

  async approve(sessionId: string, approved: boolean): Promise<AgentSession> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown agent session "${sessionId}"`);
    if (session.status !== "pending_approval" || !session.pendingToolCall) {
      throw new Error(`Session "${sessionId}" has no pending approval`);
    }

    const call = session.pendingToolCall;
    if (approved) {
      const result = await this.toolRegistry.execute(call.name, call.arguments);
      this.recordResult(session, call, result.ok, result.ok ? result.output ?? "" : result.error ?? "unknown error", true);
    } else {
      session.toolLog.push({ tool: call.name, args: call.arguments, result: "denied by user", approved: false });
      session.messages.push({
        role: "tool",
        name: call.name,
        toolCallId: call.id,
        content: "The user denied this action. Do not repeat it; consider an alternative or explain why it was needed.",
      });
    }

    session.status = "running";
    session.pendingToolCall = undefined;
    await this.step(session);
    return session;
  }

  get(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }
}
