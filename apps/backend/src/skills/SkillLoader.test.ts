import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SkillLoader, builtinSkillsRoot } from "./SkillLoader";

test("packaged built-ins satisfy the skill contract", () => {
  const report = new SkillLoader(builtinSkillsRoot()).load();
  assert.deepEqual(report.rejected, []);
  const names = report.skills.map((skill) => skill.name);
  for (const name of ["Deliver a generated file", "Ship code with proof", "Verify the UI you changed"]) {
    assert.ok(names.includes(name), name);
  }
  const deliver = report.skills.find((skill) => skill.id === "skill_deliver_file");
  assert.equal(deliver?.trigger, "logo, PNG, image, PDF, document, zip, generate a file");
  assert.equal(deliver?.validation, "artifact.created with status ready + readable bytes");
  assert.equal(deliver?.metadata.scope, "builtin");
  assert.equal(deliver?.metadata.publisher, "ORVYN");
});

test("a malformed package is rejected and the valid package still loads", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orvyn-skills-"));
  const good = path.join(root, "good-skill");
  const bad = path.join(root, "bad-skill");
  fs.mkdirSync(good);
  fs.mkdirSync(bad);
  fs.writeFileSync(path.join(good, "skill.json"), JSON.stringify({
    id: "skill_good",
    slug: "good-skill",
    name: "Good skill",
    version: "1.0.0",
    description: "A valid package.",
    category: "General",
    publisher: "ORVYN",
    source: "built-in",
    builtIn: false,
    trusted: true,
    triggers: ["good"],
    taskDomains: ["test"],
    runModes: ["agent"],
    requiredTools: [],
    optionalTools: [],
    permissionsRequired: [],
    validation: { rule: "present" },
    tags: [],
    scope: "personal",
  }));
  fs.writeFileSync(path.join(good, "SKILL.md"), "# Good skill\n\n1. Do the thing.\n");
  fs.writeFileSync(path.join(bad, "skill.json"), "{ \"name\": \"Broken\" }");
  const report = new SkillLoader(root).load();
  assert.equal(report.skills.length, 1);
  assert.equal(report.skills[0]?.name, "Good skill");
  assert.equal(report.rejected.length, 1);
  assert.equal(report.rejected[0]?.slug, "bad-skill");
  assert.ok(report.rejected[0]?.errors.length);
  fs.rmSync(root, { recursive: true, force: true });
});
