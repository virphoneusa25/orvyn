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
  "Document Builder",
  "Spreadsheet Builder",
  "Presentation Builder",
  "PDF Handling",
  "Image Generation",
  "Image Editing",
  "File Conversion",
  "Structured Data Analysis",
  "Technical Report Builder",
  "Archive / ZIP Builder",
  "Export Deliverable",
  "Artifact Verification",
];

const RESEARCH = [
  "Web Research",
  "Technical Research",
  "Source Comparison",
  "Long Document Analysis",
  "Requirements Analysis",
  "Architecture Analysis",
  "Root Cause Analysis",
  "Incident Analysis",
  "Implementation Planning",
  "Competitive Research",
  "Evidence Synthesis",
  "Decision Support",
];

const MUTATION = new Set([
  "write_file",
  "edit_file",
  "delete_file",
  "move_file",
  "terminal",
  "ssh_exec",
  "git_commit",
  "git_checkout",
  "start_process",
  "create_document",
  "create_zip",
  "artifact_create",
  "artifact_write",
  "generate_image",
]);

function body(name: string): string {
  const report = new SkillLoader(builtinSkillsRoot()).load();
  const skill = report.skills.find((item) => item.name === name);
  assert.ok(skill, name);
  return `${skill!.instructions}\n${skill!.metadata.validation.rule}`;
}

test("research and analysis built-ins load beside the existing 53 skills", () => {
  const report = new SkillLoader(builtinSkillsRoot()).load();
  assert.deepEqual(report.rejected, []);
  const ids = report.skills.map((skill) => skill.id);
  const slugs = report.skills.map((skill) => skill.metadata.slug);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(slugs).size, slugs.length);
  assert.ok(report.skills.length >= 65);
  for (const name of PRIOR) assert.ok(report.skills.some((skill) => skill.name === name), name);

  const research = report.skills.filter((skill) => skill.metadata.category === "Research & Analysis");
  assert.equal(research.length, 12);
  assert.deepEqual(research.map((skill) => skill.name).sort(), [...RESEARCH].sort());
  const tools = registeredToolNames();
  for (const skill of research) {
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
    const mutating = skill.metadata.requiredTools.filter((name) => MUTATION.has(name));
    assert.deepEqual(mutating, [], `${skill.name} requires mutation tools`);
    const text = `${skill.instructions}\n${skill.metadata.validation.rule}`;
    assert.match(text, /never fabricate sources, citations, quotations, facts, or evidence/i);
    assert.match(text, /sourced fact/i);
    assert.match(text, /model inference/i);
    assert.match(text, /hypothesis/i);
    assert.match(text, /recommendation/i);
    assert.match(text, /unless the user explicitly asks for implementation/i);
  }

  assert.deepEqual(matchValidatedSkills("Generate a virphone logo in png format").map((skill) => skill.id), ["skill_deliver_file"]);
  assert.deepEqual(matchValidatedSkills("Fix the failing tests").map((skill) => skill.id), ["skill_code_with_tests"]);
  assert.deepEqual(matchValidatedSkills("The dashboard layout overflows").map((skill) => skill.id), ["skill_visual_verify"]);
  assert.equal(skillsPromptFor("What time is it?"), "");
});

test("web, technical, document, root cause, and planning skills keep their research rules", () => {
  const web = body("Web Research");
  assert.match(web, /web_search/);
  assert.match(web, /fetch_url/);
  assert.match(web, /authoritative/i);
  assert.match(web, /source attribution/i);

  const technical = body("Technical Research");
  assert.match(technical, /official documentation/i);
  assert.match(technical, /primary technical sources/i);
  assert.match(technical, /deprecated/i);

  const document = body("Long Document Analysis");
  assert.match(document, /full section/i);
  assert.match(document, /do not draw a conclusion from an isolated snippet or from disconnected snippets/i);
  assert.match(document, /read_document/);

  const cause = body("Root Cause Analysis");
  assert.match(cause, /symptom from the root cause/i);
  assert.match(cause, /contributing factors/i);
  assert.match(cause, /do not claim a root cause when the evidence is incomplete/i);

  const plan = body("Implementation Planning");
  assert.match(plan, /sequenced/i);
  assert.match(plan, /verification gate/i);
  assert.match(plan, /does not claim the work was executed/i);
  assert.doesNotMatch(plan, /the implementation is complete/i);
});
