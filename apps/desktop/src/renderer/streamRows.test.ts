import { test } from "node:test";
import assert from "node:assert/strict";
import { changeTotals, groupToolRuns } from "./streamRows.ts";

const tool = (key: string, op: string, extra: Record<string, unknown> = {}) => ({ kind: "tool", key, op, status: "done", label: key, ...extra });

test("consecutive steps of one kind become one row; others stay single", () => {
  const rows = groupToolRuns([
    tool("t1", "terminal"), tool("t2", "terminal"),
    { kind: "assistant", key: "a1" },
    tool("r1", "read"),
    tool("w1", "create"), tool("w2", "create"),
    tool("s1", "search"), tool("s2", "search"), tool("s3", "search"),
    tool("v1", "read", { verifier: true }), tool("r2", "read"),
  ] as any);
  assert.deepEqual(rows.map((r: any) => r.kind === "toolrun" ? `run:${r.items.map((i: any) => i.key).join(",")}` : r.key), [
    "run:t1,t2", "a1", "r1", "w1", "w2", "run:s1,s2,s3", "v1", "r2",
  ]);
});

test("the Changes pill totals each file once", () => {
  const t = changeTotals([
    { type: "file.edit", data: { preview: { path: "a.css", additions: 10, deletions: 2 } } },
    { type: "file.edit", data: { preview: { path: "a.css", additions: 3, deletions: 1 } } },
    { type: "file.created", data: { path: "index.html", additions: 40 } },
    { type: "tool.completed", data: {} },
  ]);
  assert.deepEqual(t, { files: 2, additions: 53, deletions: 3 });
});
