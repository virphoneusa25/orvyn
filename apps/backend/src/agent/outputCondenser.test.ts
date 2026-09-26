import { test } from "node:test";
import assert from "node:assert/strict";
import { condenseOutput, shouldCondense, signalLines } from "./outputCondenser";

function journal(lines: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    const t = `Sep 25 10:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")} web1`;
    if (i % 500 === 250) out.push(`${t} nginx[812]: 2026/09/25 10:00:${i % 60} [error] 812#812: *${i} connect() failed (111: Connection refused) while connecting to upstream, upstream: "http://127.0.0.1:3000/"`);
    else if (i === 4000) out.push(`${t} systemd[1]: api.service: Main process exited, code=exited, status=1/FAILURE`);
    else out.push(`${t} nginx[812]: 10.0.0.${i % 250} - - "GET /health HTTP/1.1" 200 2 "-" "kube-probe"`);
  }
  return out.join("\n");
}

test("a big journal is condensed: repeated errors grouped, the failure kept verbatim, first/last lines kept", async () => {
  const raw = journal(8000);
  assert.ok(raw.length > 500_000);
  assert.equal(shouldCondense("ssh_exec", raw), true);
  assert.equal(shouldCondense("read_file", raw), false, "only command output");
  assert.equal(shouldCondense("terminal", "short"), false);
  const signals = signalLines(raw);
  assert.equal(signals.length, 2);
  assert.match(signals[0]!, /^16× .*connect\(\) failed \(111: Connection refused\)/);
  assert.match(signals[1]!, /api\.service: Main process exited, code=exited, status=1\/FAILURE/);

  const calls: string[] = [];
  const model = { async generate(req: any) { calls.push(req.messages[1].content); return { content: "api.service crashed at 10:06:40 (status=1); nginx then got 111 Connection refused from 127.0.0.1:3000 (16×).", usage: { promptTokens: 30000, completionTokens: 60 } }; } };
  const out = await condenseOutput({ raw, command: "journalctl -u nginx -u api --since today", goal: "Why is nginx returning 502?", model, modelId: "mistral:mistral-small-4-0-26-03" });
  assert.equal(out.digested, true);
  assert.ok(out.text.length < 12_000, `condensed to ${out.text.length} chars`);
  assert.match(out.text, /DIGEST \(by mistral:mistral-small-4-0-26-03\):\napi\.service crashed/);
  assert.match(out.text, /16× .*Connection refused/);
  assert.match(out.text, /FIRST LINES:\nSep 25 10:00:00 web1/);
  assert.match(out.text, /LAST LINES:/);
  assert.match(calls[0]!, /^Task: Why is nginx returning 502\?/);
  assert.ok(calls[0]!.length < 130_000, "the utility model gets at most ~120k characters");
});

test("without a model (or if it fails) the verbatim extract still goes through", async () => {
  const out = await condenseOutput({ raw: journal(3000), goal: "x", model: { async generate() { throw new Error("down"); } } });
  assert.equal(out.digested, false);
  assert.match(out.text, /ERROR\/WARNING LINES/);
  assert.doesNotMatch(out.text, /DIGEST/);
});
