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
  "Linux Server Diagnostics",
  "SSH Server Operations",
  "Docker Operations",
  "Docker Compose Recovery",
  "systemd Service Management",
  "Nginx Operations",
  "Caddy Operations",
  "PostgreSQL Operations",
  "Redis Operations",
  "Network Diagnostics",
  "Firewall Diagnostics",
  "Deployment Verification",
  "Safe Rollback",
  "Log Analysis",
];

const UI = [
  "Browser QA",
  "Responsive UI Testing",
  "Visual Verification",
  "Console Error Diagnosis",
  "Network Request Diagnosis",
  "Form Testing",
  "Accessibility Review",
  "Frontend Regression Check",
  "Website Build Verification",
  "Preview Validation",
  "Navigation Flow Testing",
  "Authentication Flow Testing",
];

function body(name: string): string {
  const report = new SkillLoader(builtinSkillsRoot()).load();
  const skill = report.skills.find((item) => item.name === name);
  assert.ok(skill, name);
  return `${skill!.instructions}\n${skill!.metadata.validation.rule}`;
}

test("browser and ui built-ins load beside the existing 29 skills", () => {
  const report = new SkillLoader(builtinSkillsRoot()).load();
  assert.deepEqual(report.rejected, []);
  const ids = report.skills.map((skill) => skill.id);
  const slugs = report.skills.map((skill) => skill.metadata.slug);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(slugs).size, slugs.length);
  assert.equal(report.skills.length, 41);
  for (const name of PRIOR) assert.ok(report.skills.some((skill) => skill.name === name), name);

  const ui = report.skills.filter((skill) => skill.metadata.category === "Browser & UI");
  assert.equal(ui.length, 12);
  assert.deepEqual(ui.map((skill) => skill.name).sort(), [...UI].sort());
  const tools = registeredToolNames();
  for (const skill of ui) {
    assert.equal(skill.metadata.publisher, "Kernel AI Labs");
    assert.equal(skill.metadata.source, "builtin");
    assert.equal(skill.metadata.builtIn, true);
    assert.equal(skill.metadata.trusted, true);
    assert.equal(skill.metadata.scope, "builtin");
    assert.equal(skill.metadata.version, "1.0.0");
    assert.ok(skill.metadata.triggers.length > 0);
    assert.ok(skill.metadata.taskDomains.length > 0);
    assert.ok(skill.metadata.runModes.length > 0);
    assert.ok(skill.metadata.validation.rule.trim());
    const referenced = [...skill.metadata.requiredTools, ...skill.metadata.optionalTools];
    const unknown = referenced.filter((name) => !tools.has(name));
    assert.deepEqual(unknown, [], `${skill.name} references unknown tools: ${unknown.join(", ")}`);
    const permissionIds = skill.metadata.permissionsRequired.map((item) => item.id);
    assert.deepEqual([...permissionIds].sort(), [...referenced].sort());
    const text = `${skill.instructions}\n${skill.metadata.validation.rule}`;
    assert.match(text, /existing ORVYN Browser session/i);
    assert.match(text, /do not create a second browser/i);
  }

  assert.deepEqual(matchValidatedSkills("Generate a virphone logo in png format").map((skill) => skill.id), ["skill_deliver_file"]);
  assert.deepEqual(matchValidatedSkills("Fix the failing tests").map((skill) => skill.id), ["skill_code_with_tests"]);
  assert.deepEqual(matchValidatedSkills("The dashboard layout overflows").map((skill) => skill.id), ["skill_visual_verify"]);
  assert.equal(skillsPromptFor("What time is it?"), "");
});

test("visual, responsive, website build, and auth skills keep their evidence rules", () => {
  for (const name of ["Browser QA", "Visual Verification", "Website Build Verification"]) {
    const text = body(name);
    assert.match(text, /real browser evidence/i, name);
    assert.match(text, /browser_screenshot/, name);
  }

  const responsive = body("Responsive UI Testing");
  assert.match(responsive, /desktop/);
  assert.match(responsive, /tablet/);
  assert.match(responsive, /mobile/);
  assert.match(responsive, /do not judge responsiveness from CSS source alone/i);
  assert.match(responsive, /browser_set_viewport/);
  assert.match(responsive, /real browser evidence/i);

  const website = body("Website Build Verification");
  assert.match(website, /started process is not verification/i);
  assert.match(website, /HTTP response alone is not full verification/i);
  assert.match(website, /browser_console_errors/);

  const auth = body("Authentication Flow Testing");
  assert.match(auth, /never invent credentials/i);
  assert.match(auth, /password or token/i);
  assert.match(auth, /browser_screenshot/);
  assert.match(auth, /existing ORVYN Browser session/i);
});
