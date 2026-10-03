/**
 * The conversation/runtime boundary shared by the web, desktop and backend.
 * This is deliberately deterministic and does not contain model reasoning.
 */
export type TurnDisposition = "answer" | "execute" | "inspect" | "edit_existing" | "continue_execution";
export type ContinuationType = "new_topic" | "follow_up" | "correction" | "refinement" | "artifact_edit" | "task_continuation";
export type ResponseOwner = "conversation" | "single_agent" | "multi_agent";

export interface TurnReference {
  kind: "artifact" | "image" | "file" | "project" | "mission" | "code" | "message";
  id: string;
  confidence: number;
  sourceTurnId?: string;
}

export interface TurnDecision {
  disposition: TurnDisposition;
  continuation: ContinuationType;
  requiresExecution: boolean;
  requiresTool: boolean;
  targetArtifactId?: string;
  targetProjectId?: string;
  targetMissionId?: string;
  references: TurnReference[];
  capabilities: string[];
  confidence: number;
  reasonCode: "answer_only" | "explicit_action" | "artifact_reference" | "project_action" | "mission_continuation" | "ambiguous";
  responseOwner: ResponseOwner;
}

export interface TurnDecisionContext {
  activeArtifactId?: string;
  activeProjectId?: string;
  activeMissionId?: string;
  hasAttachments?: boolean;
  hasPreviousExecution?: boolean;
  lastAssistantText?: string;
  pendingProposal?: string;
  constraints?: string[];
}

const QUESTION = /\?\s*$/;
const QUESTION_OPEN = /^(?:what|why|how|when|who|where|which|explain|describe|compare|tell me|can you|could you|would you)\b/i;
const ACTION_VERB = /\b(?:create|build|fix|edit|update|implement|refactor|deploy|install|run|start|stop|write|inspect|verify|debug|modify|replace|add|remove|change|restyle|connect|configure|set up|setup|delete|rename|move|redesign|generate|export|convert|save|open|read|review|test|check|restart|launch|browse|diagnose|commit|screenshot|make|use|put|insert|research|login|log in|ssh)\b/i;
const CORRECTION = /\b(?:no,? i meant|that's not what i meant|that is not what i meant|wrong (?:one|image|file)|the other (?:one|image|file)|not that one)\b/i;
const CONTINUE = /\b(?:that didn't fix it|still broken|try again|continue|resume|keep going|go ahead|do it|fix the other error|same thing|make it (?:more|less|mobile|responsive))\b/i;
const ARTIFACT = /\b(?:image|ad|logo|banner|document|report|chart|spreadsheet|file|design|artifact|page|website)\b/i;
const PRONOUN = /\b(?:it|this|that|that one|the previous one|same one|same thing)\b/i;
const EXACT_REPLY = /^(?:[^:\n]{1,80}:\s*)?(?:please\s+)?(?:reply|respond|answer|say)\s+(?:with\s+)?exactly\s*:?\s*(?:"([^"\n]+)"|'([^'\n]+)'|(.+?))(?:\s+and\s+nothing\s+else)?[.!]?$/i;

/** A literal echo request is conversation, even when its label/output contains words like "check" or "test". */
export function exactReplyText(text: string): string | null {
  const match = String(text ?? "").trim().match(EXACT_REPLY);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value?.trim() || null;
}

export function isExactReplyRequest(text: string): boolean {
  return exactReplyText(text) !== null;
}


function capabilities(text: string): string[] {
  const out = new Set<string>();
  if (/\b(?:image|picture|photo|logo|ad|banner)\b/i.test(text)) out.add("artifact");
  if (/\b(?:file|code|project|repo|repository|typescript|javascript|component|bug|test)\b/i.test(text)) out.add("code");
  if (/\b(?:server|ssh|nginx|uptime|hostname)\b/i.test(text)) out.add("server");
  if (/\b(?:website|webpage|browser|homepage|preview)\b/i.test(text)) out.add("browser");
  if (/\b(?:search|research|latest|current|today|sources?)\b/i.test(text)) out.add("research");
  if (/\b(?:github|pull request|issue)\b/i.test(text)) out.add("github");
  return [...out];
}

/** Resolve the turn before selecting a model, resource, worker or tool. */
export function decideTurn(text: string, context: TurnDecisionContext = {}): TurnDecision {
  const prompt = String(text ?? "").trim();
  const pendingWork = Boolean(context.pendingProposal?.trim())
    || /\b(do you want me to|would you like(?: me)? to|shall i|want me to|i can (?:update|fix|add|change|make|edit))\b/i.test(String(context.lastAssistantText ?? ""));
  const affirmation = /^(yes|yeah|yep|yup|sure|ok|okay|please do|do it|go ahead|go for it|yeah do (?:that|it)|yes(?:,)? (?:please|do (?:that|it)))[.!]*$/i.test(prompt)
    || /^(yes|yeah|yep)[,.]?\s+(do (?:that|it)|go ahead|add them|please do)\b/i.test(prompt);
  if (affirmation && pendingWork) {
    const references: TurnReference[] = [];
    if (context.activeArtifactId) references.push({ kind: "artifact", id: context.activeArtifactId, confidence: 0.9 });
    if (context.activeMissionId) references.push({ kind: "mission", id: context.activeMissionId, confidence: 0.9 });
    return {
      disposition: context.hasPreviousExecution ? "continue_execution" : (context.activeArtifactId ? "edit_existing" : "execute"),
      continuation: context.hasPreviousExecution ? "task_continuation" : (context.activeArtifactId ? "artifact_edit" : "follow_up"),
      requiresExecution: true,
      requiresTool: true,
      ...(context.activeArtifactId ? { targetArtifactId: context.activeArtifactId } : {}),
      ...(context.activeProjectId ? { targetProjectId: context.activeProjectId } : {}),
      ...(context.activeMissionId ? { targetMissionId: context.activeMissionId } : {}),
      references,
      capabilities: capabilities(context.pendingProposal || context.lastAssistantText || prompt),
      confidence: 0.93,
      reasonCode: context.hasPreviousExecution ? "mission_continuation" : "explicit_action",
      responseOwner: "single_agent",
    };
  }
  if (isExactReplyRequest(prompt)) {
    return {
      disposition: "answer",
      continuation: "new_topic",
      requiresExecution: false,
      requiresTool: false,
      references: [],
      capabilities: [],
      confidence: 0.98,
      reasonCode: "answer_only",
      responseOwner: "conversation",
    };
  }
  const lower = prompt.toLowerCase();
  const correction = CORRECTION.test(prompt);
  const continuation = CONTINUE.test(prompt);
  const explicitImperative = /^(?:please\s+)?(?:create|build|fix|edit|update|implement|refactor|deploy|install|run|start|stop|write|inspect|verify|debug|modify|replace|add|remove|change|restyle|connect|configure|set up|setup|delete|rename|move|redesign|generate|export|convert|save|open|read|review|test|check|restart|launch|browse|diagnose|commit|screenshot|use|put|insert|make|research|login|log in|ssh)\b/i.test(prompt);
  const politeAction = /^(?:please\s+)?(?:can|could|would) you\s+(?:please\s+)?(?:create|build|fix|edit|update|implement|refactor|deploy|install|run|start|stop|write|inspect|verify|debug|modify|replace|add|remove|change|restyle|connect|configure|set up|setup|delete|rename|move|redesign|generate|export|convert|save|open|read|review|test|check|restart|launch|browse|diagnose|commit|screenshot|research|login|log in|ssh)\b/i.test(prompt);
  const useQuestion = !context.hasAttachments && /^(?:can|could|would) you use\b/i.test(prompt) && QUESTION.test(prompt);
  const question = QUESTION.test(prompt) || (QUESTION_OPEN.test(prompt) && !explicitImperative);
  const textDraft = /^(?:please\s+)?(?:write|draft)\s+(?:an?\s+)?(?:email|note|letter|message|reply|post|paragraph|summary)\b/i.test(prompt);
  const attachedAssetUse = Boolean(context.hasAttachments && /^(?:can|could|would) you use\b/i.test(prompt) && /\b(?:for|in|on|as|to)\b/i.test(prompt));
  const isAction = !useQuestion && !textDraft && (attachedAssetUse || explicitImperative || politeAction || (!question && ACTION_VERB.test(prompt)));
  const artifactReference = ARTIFACT.test(prompt) || PRONOUN.test(prompt);
  const references: TurnReference[] = [];
  if (artifactReference && context.activeArtifactId) {
    references.push({ kind: /\b(?:image|picture|photo|ad|logo|banner)\b/i.test(prompt) ? "image" : "artifact", id: context.activeArtifactId, confidence: 0.92 });
  }
  if (context.activeProjectId && /\b(?:project|repo|repository|code|file|it|this|that)\b/i.test(prompt)) {
    references.push({ kind: "project", id: context.activeProjectId, confidence: 0.82 });
  }
  if (context.activeMissionId && continuation) {
    references.push({ kind: "mission", id: context.activeMissionId, confidence: 0.9 });
  }

  let disposition: TurnDisposition = "answer";
  let continuationType: ContinuationType = "new_topic";
  let reasonCode: TurnDecision["reasonCode"] = "answer_only";
  if (correction) continuationType = "correction";
  else if (continuation) continuationType = context.hasPreviousExecution ? "task_continuation" : "follow_up";
  else if (artifactReference && context.activeArtifactId) continuationType = "follow_up";

  if (isAction) {
    disposition = context.activeArtifactId && artifactReference && /\b(?:edit|update|change|make|add|remove|replace|resize|redesign|restyle)\b/i.test(prompt)
      ? "edit_existing"
      : context.hasPreviousExecution && continuation
        ? "continue_execution"
        : /\b(?:why|how|what|which|where)\b/i.test(prompt) ? "inspect" : "execute";
    continuationType = disposition === "edit_existing" ? "artifact_edit" : (context.hasPreviousExecution && continuation ? "task_continuation" : continuationType);
    reasonCode = disposition === "edit_existing" ? "artifact_reference" : (context.activeProjectId ? "project_action" : "explicit_action");
  }
  if (continuation && context.hasPreviousExecution && !useQuestion) {
    disposition = "continue_execution";
    continuationType = correction ? "correction" : "task_continuation";
    reasonCode = "mission_continuation";
  }

  // “Can you use icons in the ad?” asks for advice. “Use icons in the ad.” acts.
  if (useQuestion) {
    disposition = "answer";
    continuationType = context.activeArtifactId ? "follow_up" : "new_topic";
    reasonCode = context.activeArtifactId ? "artifact_reference" : "answer_only";
  }
  const requiresExecution = disposition !== "answer";
  return {
    disposition,
    continuation: continuationType,
    requiresExecution,
    requiresTool: requiresExecution,
    ...(references.find((r) => r.kind === "artifact" || r.kind === "image") ? { targetArtifactId: references.find((r) => r.kind === "artifact" || r.kind === "image")!.id } : {}),
    ...(context.activeProjectId ? { targetProjectId: context.activeProjectId } : {}),
    ...(context.activeMissionId && continuation ? { targetMissionId: context.activeMissionId } : {}),
    references,
    capabilities: capabilities(prompt),
    confidence: useQuestion || question ? 0.9 : isAction ? 0.88 : 0.72,
    reasonCode,
    responseOwner: requiresExecution ? "single_agent" : "conversation",
  };
}
