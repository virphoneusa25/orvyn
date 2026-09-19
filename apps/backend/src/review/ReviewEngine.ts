// apps/backend/src/review/ReviewEngine.ts
//
// The mandatory final gate for Build missions. Astra (reviewer model) sees the
// original request, the task graph and outcomes, and the actual git evidence,
// and must return a structured verdict. A verdict that cannot be parsed is a
// REJECTION — defaulting to approval would silently disable the gate.
//
// Chat/Ask conversations are not missions and never pass through here.

import { AIModelProvider } from "@orvyn/ai-core";
import { ModelGateway } from "../gateway/ModelGateway";
import { ToolGateway } from "../gateway/ToolGateway";
import type { Mission } from "../agent/TaskEngine";

export interface ReviewVerdict {
  status: "approved" | "rejected";
  /** 0–100 confidence in the delivered result. */
  score: number;
  blockingIssues: string[];
  warnings: string[];
  requiredChanges: string[];
}

const MAX_DIFF_CHARS = 12_000;

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x)).filter(Boolean);
}

function extractJson(raw: string): any {
  const cleaned = raw.replace(/```json|```/g, "").trim();
  const start = cleaned.search(/[{[]/);
  if (start === -1) throw new Error("No JSON found in reviewer output");
  return JSON.parse(cleaned.slice(start));
}

export class ReviewEngine {
  constructor(
    private models: ModelGateway,
    private tools: ToolGateway
  ) {}

  /** Max full-mission review cycles before the mission is BLOCKED for a human. */
  static readonly MAX_CYCLES = 3;

  async reviewMission(mission: Mission, rules?: string): Promise<ReviewVerdict> {
    const reviewer: AIModelProvider = this.models.resolveTask("reviewer");

    // Real evidence, not agent claims: what actually changed in the repo.
    const gitStatus = await this.tools.execute("git_status", {}, "orchestrator");
    const gitDiff = await this.tools.execute("git_diff", {}, "orchestrator");
    const diffText = (gitDiff.output ?? gitDiff.error ?? "").slice(0, MAX_DIFF_CHARS);

    const taskReport = mission.tasks
      .map(
        (t) =>
          `- [${t.status}] (${t.agent}) ${t.description}\n  result: ${(t.result ?? "(none)").slice(0, 500)}${
            t.reviewNotes ? `\n  prior review notes: ${t.reviewNotes}` : ""
          }`
      )
      .join("\n");

    const response = await reviewer.generate({
      messages: [
        {
          role: "system",
          content: [
            "You are ASTRA performing the FINAL REVIEW of an autonomous coding mission.",
            "Judge the delivered work against the original request using the evidence",
            "(task outcomes, git status, git diff). Be strict about unverified claims.",
            "Respond with ONLY JSON, no prose, no fences:",
            '{"status":"approved"|"rejected","score":0-100,"blockingIssues":["..."],"warnings":["..."],"requiredChanges":["..."]}',
            "requiredChanges must be concrete, actionable correction tasks (empty when approved).",
            rules ? `\nProject rules:\n${rules}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        },
        {
          role: "user",
          content: [
            `ORIGINAL REQUEST:\n${mission.goal}`,
            `TASK GRAPH AND OUTCOMES:\n${taskReport}`,
            `GIT STATUS:\n${gitStatus.output ?? gitStatus.error ?? "(unavailable)"}`,
            `GIT DIFF (truncated):\n${diffText || "(no diff)"}`,
            "Browser QA: pending (not run). Security review: pending (not run).",
          ].join("\n\n"),
        },
      ],
    });

    try {
      const parsed = extractJson(response.content);
      const status = parsed.status === "approved" ? "approved" : "rejected";
      return {
        status,
        score: Math.min(Math.max(Number(parsed.score) || 0, 0), 100),
        blockingIssues: toStringArray(parsed.blockingIssues),
        warnings: toStringArray(parsed.warnings),
        requiredChanges: toStringArray(parsed.requiredChanges),
      };
    } catch (err: any) {
      return {
        status: "rejected",
        score: 0,
        blockingIssues: [`Reviewer output could not be parsed (${err.message}); treating as rejected.`],
        warnings: [],
        requiredChanges: [],
      };
    }
  }
}
