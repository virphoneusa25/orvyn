import { test } from "node:test";
import assert from "node:assert/strict";
import { SkillLoader, builtinSkillsRoot } from "./SkillLoader";
import { matchValidatedSkills, skillsPromptFor } from "../learning/validatedSkills";
import { registeredToolNames } from "./registeredToolNames";

const PRIOR = [
  "Deliver a generated file",
  "Ship code with proof",
  "Verify the UI you changed",
  "Coding Agent",
  "Bug Diagnosis",
  "Code Review",
  "Refactor Safely",
  "Test & Verify",
  "React Best Practices",
  "Frontend Design",
  "API Development",
  "Database Migration",
  "Dependency Repair",
  "Git Workflow",
  "TypeScript Engineering",
];

test("server and devops built-ins load and reference only registered tools", () => {
  const report = new SkillLoader(builtinSkillsRoot()).load();
  assert.deepEqual(report.rejected, []);
  const ids = report.skills.map((skill) => skill.id);
  const slugs = report.skills.map((skill) => skill.metadata.slug);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(slugs).size, slugs.length);
  assert.equal(report.skills.length, 29);
  for (const name of PRIOR) assert.ok(report.skills.some((skill) => skill.name === name), name);

  const ops = report.skills.filter((skill) => skill.metadata.category === "Server & DevOps");
  assert.equal(ops.length, 14);
  const tools = registeredToolNames();
  for (const skill of ops) {
    assert.equal(skill.metadata.publisher, "Kernel AI Labs");
    assert.equal(skill.metadata.source, "builtin");
    assert.equal(skill.metadata.scope, "builtin");
    assert.equal(skill.metadata.version, "1.0.0");
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

test("ssh, compose recovery, and firewall skills keep their operating rules", () => {
  const report = new SkillLoader(builtinSkillsRoot()).load();
  const body = (name: string) => {
    const skill = report.skills.find((item) => item.name === name);
    assert.ok(skill, name);
    return `${skill!.instructions}\n${skill!.metadata.validation.rule}`;
  };

  const ssh = body("SSH Server Operations");
  assert.match(ssh, /configured/i);
  assert.match(ssh, /server/i);
  assert.match(ssh, /resource/i);
  assert.match(ssh, /ssh_exec/);
  assert.match(ssh, /empty host/i);
  assert.match(ssh, /no server is configured/i);

  const compose = body("Docker Compose Recovery");
  assert.match(compose, /inspect/i);
  assert.match(compose, /before/i);
  assert.match(compose, /verify afterward/i);

  const firewall = body("Firewall Diagnostics");
  assert.match(firewall, /never flush or reset/i);
  assert.match(firewall, /blind flush or reset/i);
});
