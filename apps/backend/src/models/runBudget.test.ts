import { test } from "node:test";
import assert from "node:assert/strict";
import { budgetWarnLevel, budgetWrapNote, pickVisionFallback, BUDGET_WARN_SHARE } from "./runBudget";

test("the soft budget warning fires once at 75% of the cap", () => {
  assert.equal(budgetWarnLevel(0.5 * 2_000_000, 2_000_000, false), null);
  assert.equal(budgetWarnLevel(Math.floor(BUDGET_WARN_SHARE * 2_000_000), 2_000_000, false), "warn");
  assert.equal(budgetWarnLevel(1_900_000, 2_000_000, true), null, "warned runs are not nagged again");
  assert.equal(budgetWarnLevel(500, 0, false), null, "no cap configured");
  assert.match(budgetWrapNote(78), /78% of its execution budget/);
  assert.match(budgetWrapNote(78), /Wrap up now/);
});

test("an image attachment routes to a vision-capable platform model", () => {
  const mk = (id: string, vision: boolean, agent = true, tools = true) => ({
    config: { id, capabilities: { agent, vision } },
    supportsTools: () => tools,
    supportsVision: () => vision,
  }) as never;
  const providers = [mk("text-code", false), mk("vision-a", true), mk("own:vision", true)];
  const picked = pickVisionFallback(providers, "text-code", (id) => id.startsWith("own:"));
  assert.ok(picked, "a vision platform model is found");
  assert.equal((picked as { config: { id: string } }).config.id, "vision-a");
  assert.equal(pickVisionFallback([mk("only-text", false)], "only-text", () => false), null, "no vision model → stay put (file note still applies)");
});
