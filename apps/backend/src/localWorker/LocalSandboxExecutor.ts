import path from "node:path";
import { DockerSandbox } from "../sandbox/DockerSandbox";
import type { LocalToolRequest, LocalToolResponse } from "./LocalToolExecutor";

/** One project container per run; provider credentials stay in the hosted control plane. */
export class LocalSandboxExecutor {
  private sandbox?: DockerSandbox;
  async start(runId: string, root: string): Promise<void> {
    this.sandbox = await DockerSandbox.start(runId, root);
    try { await this.sandbox.copyRuntimeFile(path.join(__dirname, "sandbox-tools.cjs"), "/tmp/orvyn-sandbox-tools.cjs"); }
    catch (err) { await this.sandbox.stop(); throw err; }
  }
  async execute(req: LocalToolRequest): Promise<LocalToolResponse> {
    if (!this.sandbox) return { ok: false, error: "Project sandbox was not started" };
    const payload = Buffer.from(JSON.stringify({ tool: req.tool, arguments: req.arguments })).toString("base64");
    const result = await this.sandbox.exec(`node /tmp/orvyn-sandbox-tools.cjs ${payload}`, { timeoutS: Math.min(180, (req.timeoutMs ?? 180_000) / 1000), onOutput: req.onOutput });
    const marker = result.output.lastIndexOf("ORVYN_TOOL_RESULT:");
    if (marker < 0) return { ok: false, error: result.timedOut ? "Sandbox tool timed out" : "Sandbox tool did not return a result", output: result.output };
    try { return JSON.parse(result.output.slice(marker + "ORVYN_TOOL_RESULT:".length).split("\n")[0]); }
    catch { return { ok: false, error: "Invalid sandbox tool result" }; }
  }
  async finish(root: string, merge: boolean): Promise<void> {
    try { if (merge) await this.sandbox?.mergeBack(root); }
    finally { await this.sandbox?.stop(); this.sandbox = undefined; }
  }
}
