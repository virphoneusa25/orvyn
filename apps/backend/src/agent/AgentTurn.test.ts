import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgentTurns, type AgentTurnPolicy, type ModelReply } from "./AgentTurn";

const reply = (calls: string[] = [], content = ""): ModelReply => ({
  content,
  calls: calls.map((name, i) => ({ id: `c${i}`, name, arguments: {} })),
  reasoning: "",
  streamedText: Boolean(content),
});

function policy(script: ModelReply[], over: Partial<AgentTurnPolicy> = {}): AgentTurnPolicy & { log: string[] } {
  const log: string[] = [];
  let i = 0;
  return {
    log,
    maxTurns: 10,
    beforeTurn: () => null,
    requestModelTurn: async () => ({ kind: "reply", reply: script[i++] ?? reply([], "done") }),
    runTools: async (_t, r) => { log.push(`tools:${r.calls.map((c) => c.name).join(",")}`); return { kind: "ok" }; },
    onFinalAnswer: () => ({ kind: "verify" }),
    verify: async () => ({ kind: "approved" }),
    complete: (_t, r) => { log.push(`complete:${r.content}`); },
    onTurnLimit: () => { log.push("limit"); },
    ...over,
  };
}

test("model → tools → model → tools → final answer → evaluator approves → completed", async () => {
  const p = policy([reply(["write_file"]), reply(["write_file"]), reply(["terminal"]), reply([], "a=1, b=2")]);
  const out = await runAgentTurns(p);
  assert.equal(out.outcome, "completed");
  assert.equal(out.turns, 4);
  assert.deepEqual(out.records.map((r) => r.kind), ["tools", "tools", "tools", "final"]);
  assert.deepEqual(p.log, ["tools:write_file", "tools:write_file", "tools:terminal", "complete:a=1, b=2"]);
});

test("a final answer the evaluator rejects sends the same run back to work", async () => {
  let verdicts = 0;
  const p = policy([reply([], "done?"), reply(["terminal"]), reply([], "done")], {
    verify: async () => (++verdicts === 1 ? { kind: "retry", reason: "no test ran" } : { kind: "approved" }),
  });
  const out = await runAgentTurns(p);
  assert.equal(out.outcome, "completed");
  assert.deepEqual(out.records.map((r) => r.kind), ["verify_retry", "tools", "final"]);
});

test("the run ends blocked, failed or cancelled without completing", async () => {
  const blocked = await runAgentTurns(policy([reply(["ssh_exec"])], { runTools: async () => ({ kind: "stop", outcome: "blocked", reason: "needs a server" }) }));
  assert.equal(blocked.outcome, "blocked");
  const failed = await runAgentTurns(policy([reply([], "x")], { verify: async () => ({ kind: "stop", outcome: "failed", reason: "gates" }) }));
  assert.equal(failed.outcome, "failed");
  const cancelled = await runAgentTurns(policy([reply(["read_file"])], { beforeTurn: (t) => (t === 2 ? { outcome: "cancelled", reason: "user" } : null) }));
  assert.equal(cancelled.outcome, "cancelled");
  assert.equal(cancelled.turns, 1);
  for (const o of [blocked, failed, cancelled]) assert.equal(o.records.some((r) => r.kind === "final"), false);
});

test("nudges and provider retries continue; the turn limit fails the run", async () => {
  let n = 0;
  const p = policy([], {
    maxTurns: 3,
    requestModelTurn: async () => (n++ === 0 ? { kind: "retry", reason: "provider swapped" } : { kind: "reply", reply: reply([], "I'll do it next") }),
    onFinalAnswer: () => ({ kind: "continue", reason: "announced work" }),
  });
  const out = await runAgentTurns(p);
  assert.equal(out.outcome, "failed");
  assert.deepEqual(out.records.map((r) => r.kind), ["retry", "continue", "continue"]);
  assert.deepEqual(p.log, ["limit"]);
});
