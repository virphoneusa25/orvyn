import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SkillLoader, builtinSkillsRoot } from "../SkillLoader";
import { matchValidatedSkills } from "../../learning/validatedSkills";
import { importExternalSkill } from "./SkillImportMapper";
import { certifyImportedSkill } from "./SkillImportValidator";

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

function fixtureDir(): string {
  const candidates = [
    path.join(process.cwd(), "src/skills/import/fixtures/sample-external-skill"),
    path.join(process.cwd(), "apps/backend/src/skills/import/fixtures/sample-external-skill"),
  ];
  const found = candidates.find((candidate) => fs.existsSync(path.join(candidate, "SKILL.md")));
  if (!found) throw new Error("sample external skill fixture was not found");
  return found;
}

function fingerprint() {
  const report = new SkillLoader(builtinSkillsRoot()).load();
  return {
    rejected: report.rejected,
    skills: report.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      trigger: skill.trigger,
      validation: skill.validation,
      source: skill.source,
      trusted: skill.metadata.trusted,
      category: skill.metadata.category,
      origin: skill.metadata.origin ?? null,
      certificationStatus: skill.metadata.certificationStatus ?? null,
    })),
  };
}

test("an external skill becomes a pending untrusted ORVYN package", () => {
  const before = fingerprint();
  assert.equal(before.skills.length, 105);
  assert.deepEqual(before.rejected, []);
  for (const name of PRIOR) assert.ok(before.skills.some((skill) => skill.name === name), name);

  const source = fs.mkdtempSync(path.join(os.tmpdir(), "orvyn-external-src-"));
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "orvyn-external-out-"));
  fs.cpSync(fixtureDir(), source, { recursive: true });
  fs.chmodSync(path.join(source, "scripts", "helper.py"), 0o755);

  const importedAt = "2026-09-26T17:00:00.000Z";
  const result = importExternalSkill({
    sourceDir: source,
    outputDir: output,
    repository: "https://example.com/third-party/skills",
    path: "examples/sample-unfamiliar-skill",
    importedAt,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const pkg = result.packageDir;
  assert.equal(fs.readFileSync(path.join(pkg, "SKILL.md"), "utf8"), fs.readFileSync(path.join(source, "SKILL.md"), "utf8"));
  assert.equal(fs.readFileSync(path.join(pkg, "references", "example.md"), "utf8"), fs.readFileSync(path.join(source, "references", "example.md"), "utf8"));
  assert.equal(fs.readFileSync(path.join(pkg, "templates", "example.md"), "utf8"), fs.readFileSync(path.join(source, "templates", "example.md"), "utf8"));
  assert.equal(fs.readFileSync(path.join(pkg, "scripts", "helper.py"), "utf8"), fs.readFileSync(path.join(source, "scripts", "helper.py"), "utf8"));
  assert.equal(fs.readFileSync(path.join(pkg, "LICENSE"), "utf8"), fs.readFileSync(path.join(source, "LICENSE"), "utf8"));
  assert.equal(fs.statSync(path.join(pkg, "scripts", "helper.py")).mode & 0o111, 0);
  assert.equal(fs.existsSync(path.join(source, "scripts", "EXECUTED")), false);
  assert.equal(fs.existsSync(path.join(pkg, "scripts", "EXECUTED")), false);

  const loaded = new SkillLoader(output).load();
  assert.deepEqual(loaded.rejected, []);
  assert.equal(loaded.skills.length, 1);
  const skill = loaded.skills[0];
  assert.equal(skill.metadata.name, "Sample Unfamiliar Skill");
  assert.equal(skill.metadata.description, "Show how an external skill is imported without running its script.");
  assert.equal(skill.metadata.category, "Examples");
  assert.equal(skill.metadata.version, "2.4.1");
  assert.equal(skill.metadata.source, "imported");
  assert.equal(skill.metadata.trusted, false);
  assert.equal(skill.metadata.builtIn, false);
  assert.equal(skill.metadata.certificationStatus, "pending");
  assert.deepEqual(skill.metadata.requiredTools, []);
  assert.deepEqual(skill.metadata.optionalTools, ["read_file"]);
  assert.deepEqual(skill.metadata.unresolvedTools, [
    { name: "Bash", requirement: "required" },
    { name: "vendor_widget_inspect", requirement: "required" },
    { name: "vendor_widget_preview", requirement: "optional" },
    { name: "SomeAllowedWidget", requirement: "optional" },
  ]);
  assert.deepEqual(skill.metadata.origin, {
    repository: "https://example.com/third-party/skills",
    path: "examples/sample-unfamiliar-skill",
    license: "Apache-2.0",
    author: "Ada Thirdparty",
    version: "2.4.1",
    importedAt,
  });
  const blockers = skill.metadata.certificationBlockers ?? [];
  assert.ok(blockers.some((line) => line.includes("Bash")));
  assert.ok(blockers.some((line) => line.includes("vendor_widget_inspect")));
  assert.equal(blockers.some((line) => line.includes("vendor_widget_preview") || line.includes("SomeAllowedWidget")), false);
  const decision = certifyImportedSkill(skill.metadata);
  assert.equal(decision.certificationStatus, "rejected");
  assert.equal(skill.metadata.certificationStatus, "pending");

  const after = fingerprint();
  assert.deepEqual(after, before);
  assert.deepEqual(matchValidatedSkills("Generate a virphone logo in png format").map((item) => item.id), ["skill_deliver_file"]);
  assert.deepEqual(matchValidatedSkills("Fix the failing tests").map((item) => item.id), ["skill_code_with_tests"]);
  assert.deepEqual(matchValidatedSkills("The dashboard layout overflows").map((item) => item.id), ["skill_visual_verify"]);
  assert.deepEqual(matchValidatedSkills("What time is it?").map((item) => item.id), []);

  fs.rmSync(source, { recursive: true, force: true });
  fs.rmSync(output, { recursive: true, force: true });
});

test("an optional unknown tool does not reject the import or block certification", () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "orvyn-optional-src-"));
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "orvyn-optional-out-"));
  fs.writeFileSync(path.join(source, "SKILL.md"), `---
name: Optional Tool Skill
description: A skill whose only external tool is optional.
license: MIT
author: Pat Example
version: 0.1.0
category: Examples
allowed-tools: vendor_optional_widget
---

1. Describe the widget.
`);
  fs.writeFileSync(path.join(source, "LICENSE"), "MIT License\n\nCopyright 2026 Pat Example\n");
  const result = importExternalSkill({
    sourceDir: source,
    outputDir: output,
    repository: "https://example.com/third-party/optional",
    path: "examples/optional-tool-skill",
    importedAt: "2026-09-26T17:05:00.000Z",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.metadata.certificationBlockers, []);
  assert.deepEqual(result.metadata.unresolvedTools, [{ name: "vendor_optional_widget", requirement: "optional" }]);
  assert.equal(result.metadata.certificationStatus, "pending");
  assert.equal(result.metadata.trusted, false);
  const loaded = new SkillLoader(output).load();
  assert.deepEqual(loaded.rejected, []);
  assert.equal(certifyImportedSkill(result.metadata).certificationStatus, "certified");
  fs.rmSync(source, { recursive: true, force: true });
  fs.rmSync(output, { recursive: true, force: true });
});
