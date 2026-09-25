// apps/desktop/src/renderer/missionPhases.ts
//
// The mission timeline the ORVYN site shows for every task:
//   01 Understand · 02 Inspect · 03 Act · 04 Test · 05 Verify · 06 Deliver
// derived from the run's real events (never invented): which tools ran,
// in what order, and how the run ended.

export type PhaseName = "Understand" | "Inspect" | "Act" | "Test" | "Verify" | "Deliver";
export type PhaseState = "pending" | "active" | "done" | "skipped" | "failed";

export const PHASES: PhaseName[] = ["Understand", "Inspect", "Act", "Test", "Verify", "Deliver"];

export interface MissionView {
  phases: Array<{ name: PhaseName; state: PhaseState }>;
  status: "running" | "verified" | "completed" | "attention";
  active?: PhaseName;
}

interface Ev { type: string; data?: Record<string, any> }

const TEST_COMMAND = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|node\s+--test|npx\s+(?:vitest|jest|mocha)|vitest|jest|mocha|pytest|go\s+test|cargo\s+test)\b/i;
const INSPECT = /^(read_file|read_document|search_files|search_code|search_codebase|find_symbol|find_file|related_files|search_tests|get_project_outline|search|list_directory|list_files|list_symbols|web_search|fetch_url|git_status|git_diff|git_log|artifact_list|artifact_read)$/;
const ACT = /^(write_file|edit_file|apply_edit|delete_file|move_file|rename_file|generate_image|create_document|create_zip|artifact_create|artifact_write|git_commit|git_checkout|git_branch|start_dev_server)$/;

/** Which phase one tool call belongs to. */
export function phaseOfTool(tool: string, input: Record<string, any> | undefined, wrotePaths: Set<string>): PhaseName {
  const command = String(input?.command ?? "");
  if (tool === "run_tests" || tool === "run_typecheck" || tool === "run_linter") return "Test";
  if ((tool === "terminal" || tool === "run_command") && TEST_COMMAND.test(command)) return "Test";
  if (tool.startsWith("browser_") || tool.startsWith("desktop_") || tool.startsWith("computer_") || tool.startsWith("computer.")) return "Verify";
  // Reading back a file this run wrote is checking the result.
  if (tool === "read_file" && typeof input?.path === "string" && wrotePaths.has(norm(input.path))) return "Verify";
  if (INSPECT.test(tool)) return "Inspect";
  if (ACT.test(tool)) return "Act";
  return "Act";
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();

export function deriveMissionPhases(events: Ev[], runStatus: string): MissionView | null {
  const inputs = new Map<string, Record<string, any>>();
  for (const e of events) if (e.type === "tool.input") inputs.set(String(e.data?.callId ?? ""), (e.data?.input ?? {}) as Record<string, any>);
  const touched = new Set<PhaseName>();
  const wrote = new Set<string>();
  let active: PhaseName = "Understand";
  let anyTool = false;
  let verified = false;
  for (const e of events) {
    if (e.type === "tool.started") {
      anyTool = true;
      touched.add("Understand");
      const callId = String(e.data?.callId ?? "");
      const tool = String(e.data?.tool ?? "");
      active = phaseOfTool(tool, inputs.get(callId), wrote);
      touched.add(active);
    } else if (e.type === "tool.completed") {
      const input = inputs.get(String(e.data?.callId ?? ""));
      const tool = String(e.data?.tool ?? "");
      if ((tool === "write_file" || tool === "edit_file") && typeof input?.path === "string") wrote.add(norm(input.path));
    } else if (e.type === "verification.started") {
      touched.add("Verify");
      active = "Verify";
    } else if (e.type === "verification.completed") {
      // Only the independent verifier's PASS (or the desktop check) counts as
      // verified; an HTTP fetch of the preview does not.
      verified = e.data?.verdict === "PASS";
      if (!verified) active = "Act";
    } else if (e.type === "desktop.verification.passed") {
      verified = true;
      touched.add("Verify");
    } else if (e.type === "preview.available") {
      touched.add("Verify");
    }
  }
  if (!anyTool) return null;
  const finished = ["completed", "error", "failed", "cancelled", "blocked", "stopped"].includes(runStatus);
  const ok = runStatus === "completed";
  if (ok) touched.add("Deliver");
  const activeIdx = PHASES.indexOf(active);
  const phases = PHASES.map((name, i) => {
    let state: PhaseState;
    if (finished) state = touched.has(name) ? (ok || name !== active ? "done" : "failed") : "skipped";
    else if (name === active) state = "active";
    else if (touched.has(name)) state = "done";
    else state = i < activeIdx ? "skipped" : "pending";
    return { name, state };
  });
  const status: MissionView["status"] = !finished ? "running" : !ok ? "attention" : verified || touched.has("Test") || touched.has("Verify") ? "verified" : "completed";
  return { phases, status, active: finished ? undefined : active };
}
