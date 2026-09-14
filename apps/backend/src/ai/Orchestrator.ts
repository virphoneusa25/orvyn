// apps/backend/src/ai/Orchestrator.ts
import { AIMessage, AIChunk, TaskType } from "@viride/ai-core";
import { ModelService } from "../services/ModelService";
import { IndexService } from "../indexing/IndexService";

export interface ChatContext {
  currentFile?: { path: string; content: string };
  selectedCode?: string;
  projectRules?: string; // contents of .viride/rules.md
  useRag?: boolean;
  projectRoot?: string;
}

export interface ChatTurnRequest {
  task: TaskType;
  history: AIMessage[];
  userMessage: string;
  context?: ChatContext;
}

// Builds the final message list sent to the model: system rules,
// then relevant context, then conversation history, then the new turn.
// RAG retrieval (when enabled and the index is ready) injects the
// top-ranked repository chunks here as additional system context —
// this IS the "context ranking" step from the master spec's RAG pipeline.
async function buildMessages(req: ChatTurnRequest, indexService?: IndexService): Promise<AIMessage[]> {
  const messages: AIMessage[] = [];

  const systemParts: string[] = [
    "You are VirIDE's AI assistant, running on a self-hosted model the user controls.",
  ];
  if (req.context?.projectRules) {
    systemParts.push(`Project rules (.viride/rules.md):\n${req.context.projectRules}`);
  }
  messages.push({ role: "system", content: systemParts.join("\n\n") });

  if (req.context?.currentFile) {
    messages.push({
      role: "system",
      content: `Current file: ${req.context.currentFile.path}\n\n${req.context.currentFile.content}`,
    });
  }
  if (req.context?.selectedCode) {
    messages.push({ role: "system", content: `Selected code:\n${req.context.selectedCode}` });
  }

  if (req.context?.useRag && indexService) {
    const hits = await indexService.search(req.userMessage, 5);
    if (hits.length > 0) {
      const formatted = hits
        .map((h) => `--- ${h.path} (lines ${h.startLine}-${h.endLine}, relevance ${h.score.toFixed(2)}) ---\n${h.snippet}`)
        .join("\n\n");
      messages.push({ role: "system", content: `Relevant code from repository index:\n\n${formatted}` });
    }
  }

  messages.push(...req.history);
  messages.push({ role: "user", content: req.userMessage });
  return messages;
}

export class Orchestrator {
  constructor(private modelService: ModelService, private indexService?: IndexService) {}

  async *streamChat(req: ChatTurnRequest): AsyncIterable<AIChunk> {
    const provider = this.modelService.router.resolve(req.task);
    const messages = await buildMessages(req, this.indexService);
    try {
      yield* provider.stream({ messages, stream: true });
    } catch (err: any) {
      yield { delta: `\n\n[Error: ${err.message}]`, done: true };
    }
  }

  async chat(req: ChatTurnRequest) {
    const provider = this.modelService.router.resolve(req.task);
    const messages = await buildMessages(req, this.indexService);
    return provider.generate({ messages });
  }
}
