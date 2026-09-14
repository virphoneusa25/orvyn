// apps/backend/src/agent/AgentService.ts
import { randomUUID } from "crypto";
import { AIMessage, ToolCall, ToolDefinition } from "@viride/ai-core";
import { ModelService } from "../services/ModelService";
import { toolRegistry } from "../ai/ToolTypes";
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
  toolLog: { tool: string; args: unknown; result?: string; approved?: boolean }[];
}

const sessions = new Map<string, AgentSession>();

function toolDefinitions(): ToolDefinition[] {
  return toolRegistry.list().map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

export class AgentService {
  constructor(private modelService: ModelService) {}

  private async step(session: AgentSession): Promise<void> {
    if (session.stepCount >= session.maxSteps) {
      session.status = "error";
      session.errorMessage = `Agent stopped after ${session.maxSteps} steps without finishing.`;
      return;
    }
    session.stepCount++;

    const provider = this.modelService.router.resolve("agent");
    let response;
    try {
      response = await provider.generate({ messages: session.messages, tools: toolDefinitions() });
    } catch (err: any) {
      session.status = "error";
      session.errorMessage = err.message;
      return;
    }

    if (response.toolCalls && response.toolCalls.length > 0) {
      const call = response.toolCalls[0];
      const permission = toolRegistry.getPermission(call.name);

      if (permission === "denied") {
        session.messages.push({
          role: "tool",
          name: call.name,
          toolCallId: call.id,
          content: `Tool "${call.name}" is denied by project permissions.`,
        });
        session.toolLog.push({ tool: call.name, args: call.arguments, result: "denied by permissions" });
        return this.step(session); // let the model react and try something else
      }

      if (permission === "ask") {
        const destructive = call.name === "terminal" && isDestructiveCommand(String((call.arguments as any).command ?? ""));
        session.status = "pending_approval";
        session.pendingToolCall = { ...call, destructive };
        return;
      }

      // "allowed" — execute immediately
      const result = await toolRegistry.execute(call.name, call.arguments);
      session.toolLog.push({ tool: call.name, args: call.arguments, result: result.output ?? result.error });
      session.messages.push({
        role: "tool",
        name: call.name,
        toolCallId: call.id,
        content: result.ok ? result.output ?? "" : `Error: ${result.error}`,
      });
      return this.step(session);
    }

    session.status = "completed";
    session.finalOutput = response.content;
  }

  async start(projectRoot: string, instruction: string, rules?: string, maxSteps = 8): Promise<AgentSession> {
    const session: AgentSession = {
      id: randomUUID(),
      projectRoot,
      status: "running",
      messages: [
        {
          role: "system",
          content: [
            "You are VirIDE's Agent. You can use tools to read files, search, and (with approval) write files or run commands.",
            rules ? `Project rules:\n${rules}` : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
        { role: "user", content: instruction },
      ],
      stepCount: 0,
      maxSteps,
      toolLog: [],
    };
    sessions.set(session.id, session);
    await this.step(session);
    return session;
  }

  async approve(sessionId: string, approved: boolean): Promise<AgentSession> {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Unknown agent session "${sessionId}"`);
    if (session.status !== "pending_approval" || !session.pendingToolCall) {
      throw new Error(`Session "${sessionId}" has no pending approval`);
    }

    const call = session.pendingToolCall;
    if (approved) {
      const result = await toolRegistry.execute(call.name, call.arguments);
      session.toolLog.push({ tool: call.name, args: call.arguments, result: result.output ?? result.error, approved: true });
      session.messages.push({
        role: "tool",
        name: call.name,
        toolCallId: call.id,
        content: result.ok ? result.output ?? "" : `Error: ${result.error}`,
      });
    } else {
      session.toolLog.push({ tool: call.name, args: call.arguments, result: "denied by user", approved: false });
      session.messages.push({
        role: "tool",
        name: call.name,
        toolCallId: call.id,
        content: "The user denied this action. Do not repeat it; consider an alternative or explain to the user why it was needed.",
      });
    }

    session.status = "running";
    session.pendingToolCall = undefined;
    await this.step(session);
    return session;
  }

  get(sessionId: string): AgentSession | undefined {
    return sessions.get(sessionId);
  }
}
