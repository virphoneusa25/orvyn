import { test } from "node:test";
import assert from "node:assert/strict";
import { SkillLoader, builtinSkillsRoot } from "./SkillLoader";
import { matchValidatedSkills, skillsPromptFor } from "../learning/validatedSkills";
import { registeredToolNames } from "./registeredToolNames";

const ORIGINAL = ["skill_deliver_file", "skill_code_with_tests", "skill_visual_verify"];

test("engineering built-ins load and reference only registered tools", () => {
  const report = new SkillLoader(builtinSkillsRoot()).load();
  assert.deepEqual(report.rejected, []);
  const ids = report.skills.map((skill) => skill.id);
  const slugs = report.skills.map((skill) => skill.metadata.slug);
  assert.deepEqual(new Set(ids).size, ids.length);
  assert.deepEqual(new Set(slugs).size, slugs.length);
  for (const id of ORIGINAL) assert.ok(ids.includes(id), id);

  const engineering = report.skills.filter((skill) => skill.metadata.category === "Engineering");
  assert.equal(engineering.length, 12);
  assert.ok(report.skills.length >= 15);
  const tools = registeredToolNames();
  for (const skill of engineering) {
    assert.equal(skill.metadata.publisher, "Kernel AI Labs");
    assert.equal(skill.metadata.source, "builtin");
    assert.equal(skill.metadata.builtIn, true);
    assert.equal(skill.metadata.trusted, true);
    assert.equal(skill.metadata.scope, "builtin");
    assert.match(skill.metadata.version, /^\d+\.\d+\.\d+$/);
    assert.ok(skill.metadata.validation.rule.trim());
    const referenced = [...skill.metadata.requiredTools, ...skill.metadata.optionalTools];
    const unknown = referenced.filter((name) => !tools.has(name));
    assert.deepEqual(unknown, [], `${skill.name} references unknown tools: ${unknown.join(", ")}`);
    const permissionIds = skill.metadata.permissionsRequired.map((item) => item.id);
    assert.deepEqual([...permissionIds].sort(), [...referenced].sort());
  }

  assert.deepEqual(matchValidatedSkills("Generate a virphone logo in png format").map((skill) => skill.id), ["skill_deliver_file"]);
  assert.deepEqual(matchValidatedSkills("Fix the failing tests").map((skill) => skill.id), ["skill_code_with_tests"]);
  assert.deepEqual(matchValidatedSkills("The dashboard layout overflows").map((skill) => skill.id), ["skill_visual_verify"]);
  assert.equal(skillsPromptFor("What time is it?"), "");
});
