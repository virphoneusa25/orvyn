// One owner per user turn: an answer-only prompt ("Hi", "What can you do?",
// "How do I configure nginx?") is a chat turn — never a run. Creating a run
// for it is what produced "chat reply + unrelated run.blocked" doubles.
// The desktop classifier makes this call before submitting; this gate is the
// same decision server-side for every caller of the run endpoints.

import { decideTurn, type TurnDecisionContext } from "@orvyn/ai-core";
import { inferTaskIntent } from "./taskIntent";
import { looksLikeCloudArtifactRequest } from "../ai/coreCapabilityHits";

export type TurnRoute = "chat" | "run";

export function routeTurn(instruction: string, composerMode?: string, context: TurnDecisionContext = {}): TurnRoute {
  const intent = inferTaskIntent(instruction, composerMode);
  // Looking at a live URL belongs in the cloud workspace even when phrased as
  // a question ("can you view snch.com and tell me what it is"). Chat-only
  // research never binds a runId, so the Browser pane stays empty.
  if (intent.requiresBrowser || intent.requiresDesktop) return "run";
  const decision = decideTurn(instruction, context);
  if (!decision.requiresExecution) return "chat";
  if (decision.disposition === "continue_execution") return "run";
  // Pictures, PDFs, spreadsheets, and zips on Cloud (no project) use chat
  // tools — never an engineering run that hunts MCP for a missing generator.
  if (looksLikeCloudArtifactRequest(instruction) && !intent.requiresWorkspace && !intent.requiresFrontend) {
    return "chat";
  }
  // Keep text-only requests on the normal chat stream. Phrases like “write an
  // email” contain an action verb, but do not need an agent run unless they
  // require a project, tool, external integration, or generated artifact.
  const needsAgent = intent.requiresWorkspace
    || intent.requiresRemoteResource
    || intent.requiresTerminal
    || intent.requiresBrowser
    || intent.requiresDesktop
    || intent.requiresArtifact
    || intent.requiresExternalIntegration;
  const contextualWork = decision.requiresExecution && decision.capabilities.some((capability) => ["artifact", "code", "server", "browser", "github"].includes(capability));
  return intent.executionComplexity === "answer" || (!needsAgent && !contextualWork) ? "chat" : "run";
}
