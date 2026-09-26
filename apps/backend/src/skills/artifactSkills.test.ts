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
];

const CONTENT = [
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

function body(name: string): string {
  const report = new SkillLoader(builtinSkillsRoot()).load();
  const skill = report.skills.find((item) => item.name === name);
  assert.ok(skill, name);
  return `${skill!.instructions}\n${skill!.metadata.validation.rule}`;
}

test("artifacts and content built-ins load beside the existing 41 skills", () => {
  const report = new SkillLoader(builtinSkillsRoot()).load();
  assert.deepEqual(report.rejected, []);
  const ids = report.skills.map((skill) => skill.id);
  const slugs = report.skills.map((skill) => skill.metadata.slug);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(slugs).size, slugs.length);
  assert.equal(report.skills.length, 53);
  for (const name of PRIOR) assert.ok(report.skills.some((skill) => skill.name === name), name);

  const content = report.skills.filter((skill) => skill.metadata.category === "Artifacts & Content");
  assert.equal(content.length, 12);
  assert.deepEqual(content.map((skill) => skill.name).sort(), [...CONTENT].sort());
  const tools = registeredToolNames();
  for (const skill of content) {
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
    assert.match(text, /do not invent a filename, an artifactId, a sandbox path, or a download URL/i);
    assert.match(text, /persisted bytes and a successful readback|persisted bytes and a successful artifact_get readback/i);
    assert.match(text, /zero-byte artifact does not pass/i);
    assert.match(text, /do not bypass artifact persistence/i);
    assert.doesNotMatch(text, /\$|provider pricing is|fireworks|cost money/i);
  }

  const deliver = report.skills.find((skill) => skill.id === "skill_deliver_file");
  assert.ok(deliver);
  assert.equal(deliver!.name, "Deliver a generated file");
  assert.equal(deliver!.trigger, "logo, PNG, image, PDF, document, zip, generate a file");
  assert.equal(deliver!.validation, "artifact.created with status ready + readable bytes");
  assert.equal(deliver!.metadata.publisher, "ORVYN");
  assert.equal(deliver!.metadata.category, "General");
  assert.deepEqual(deliver!.metadata.requiredTools, ["generate_image", "create_document", "artifact_create"]);
  assert.match(deliver!.instructions, /Never invent a filename or a sandbox\/artifacts\/\.\.\.\/download path/);

  assert.deepEqual(matchValidatedSkills("Generate a virphone logo in png format").map((skill) => skill.id), ["skill_deliver_file"]);
  assert.deepEqual(matchValidatedSkills("Fix the failing tests").map((skill) => skill.id), ["skill_code_with_tests"]);
  assert.deepEqual(matchValidatedSkills("The dashboard layout overflows").map((skill) => skill.id), ["skill_visual_verify"]);
  assert.equal(skillsPromptFor("What time is it?"), "");
});

test("document, spreadsheet, presentation, image, and verification skills require real artifacts", () => {
  const document = body("Document Builder");
  assert.match(document, /create_document/);
  assert.match(document, /\.docx/);
  assert.match(document, /artifact_get/);
  assert.match(document, /headings/);

  const sheet = body("Spreadsheet Builder");
  assert.match(sheet, /create_document/);
  assert.match(sheet, /\.xlsx/);
  assert.match(sheet, /=SUM\(B2:B9\)/);
  assert.match(sheet, /not markdown pretending to be a spreadsheet/i);
  assert.match(sheet, /artifact_get/);
  assert.match(sheet, /workbook/i);

  const slides = body("Presentation Builder");
  assert.match(slides, /create_document/);
  assert.match(slides, /\.pptx/);
  assert.match(slides, /presentation artifact/i);
  assert.match(slides, /overflow/i);
  assert.match(slides, /artifact_get/);
  assert.doesNotMatch(slides, /markdown outline is the presentation/i);

  const image = body("Image Generation");
  assert.match(image, /generate_image/);
  assert.match(image, /persisted image artifact/i);
  assert.match(image, /artifact_get/);
  assert.match(image, /mime type/i);
  assert.match(image, /size must be greater than 0/i);

  const verify = body("Artifact Verification");
  assert.match(verify, /artifact_get/);
  assert.match(verify, /file size must be greater than 0/i);
  assert.match(verify, /zero-byte/i);
  assert.match(verify, /wrong-type/i);
  assert.match(verify, /unreadable/i);
});
