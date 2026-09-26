import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { skillRegistry } from "../SkillRegistry";
import { builtinSkillsRoot } from "../SkillLoader";
import { matchValidatedSkills } from "../../learning/validatedSkills";
import { importClaudeSkills } from "./ClaudeSkillsImporter";

test("a malformed upstream skill does not stop the import", () => {
  const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), "orvyn-claude-snap-"));
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "orvyn-claude-out-"));
  const builtins = fs.mkdtempSync(path.join(os.tmpdir(), "orvyn-claude-builtins-"));
  fs.mkdirSync(path.join(snapshot, "good"));
  fs.writeFileSync(path.join(snapshot, "good", "SKILL.md"), `---
name: Optional Widget Skill
description: Explain the widget without its optional bridge.
license: MIT
author: Ada Thirdparty
allowed-tools: vendor_optional_widget
---

# Optional Widget Skill

The optional vendor bridge is not required.

1. Describe the widget from the reference.
`);
  fs.mkdirSync(path.join(snapshot, "good", "references"));
  fs.writeFileSync(path.join(snapshot, "good", "references", "example.md"), "Widget listens on port 4070.\n");
  fs.mkdirSync(path.join(snapshot, "broken"));
  fs.writeFileSync(path.join(snapshot, "broken", "SKILL.md"), "this is not a skill package\n");
  fs.mkdirSync(path.join(snapshot, "risky", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(snapshot, "risky", "SKILL.md"), `---
name: Risky Helper Skill
description: A workflow that mentions a helper but can be followed from the text.
license: MIT
---

# Risky Helper Skill

1. Read the config and report the port.
`);
  fs.writeFileSync(path.join(snapshot, "risky", "scripts", "helper.py"), "from pathlib import Path\nPath('EXECUTED').write_text('ran')\n");
  fs.chmodSync(path.join(snapshot, "risky", "scripts", "helper.py"), 0o755);
  const builtinSkill = path.join(builtins, "code-review");
  fs.mkdirSync(builtinSkill);
  fs.writeFileSync(path.join(builtinSkill, "skill.json"), JSON.stringify({
    id: "skill_eng_code_review",
    slug: "code-review",
    name: "Code Review",
    version: "1.0.0",
    description: "Review code.",
    category: "Engineering",
    publisher: "Kernel AI Labs",
    source: "builtin",
    builtIn: true,
    trusted: true,
    triggers: ["code review checklist"],
    taskDomains: ["code"],
    runModes: ["agent"],
    requiredTools: ["read_file"],
    optionalTools: [],
    permissionsRequired: [{ id: "read_file", reason: "Read the change." }],
    validation: { rule: "The review names a file." },
    tags: [],
    scope: "builtin",
  }));
  fs.writeFileSync(path.join(builtinSkill, "SKILL.md"), "# Code Review\n\n1. Read the diff.\n");
  fs.mkdirSync(path.join(snapshot, "dup"));
  fs.writeFileSync(path.join(snapshot, "dup", "SKILL.md"), `---
name: Code Review
description: The same review workflow with no extra references.
license: MIT
---

# Code Review

1. Read the diff.
`);

  const report = importClaudeSkills({
    snapshotDir: snapshot,
    outputDir: output,
    builtinRoot: builtins,
    knownTools: new Set(["read_file", "terminal", "browser_open"]),
  });
  assert.equal(report.discovered, 4);
  assert.equal(report.entries.length, 4);
  assert.ok(report.entries.some((entry) => entry.certificationStatus === "blocked" && entry.upstreamPath === "broken"));
  assert.equal(fs.existsSync(path.join(snapshot, "risky", "scripts", "EXECUTED")), false);
  assert.equal(fs.existsSync(path.join(output, "skills", "risky-helper-skill", "scripts", "EXECUTED")), false);
  const copied = path.join(output, "skills", "risky-helper-skill", "scripts", "helper.py");
  if (fs.existsSync(copied)) assert.equal(fs.statSync(copied).mode & 0o111, 0);
  const kept = report.entries.find((entry) => entry.upstreamPath === "dup");
  assert.equal(kept?.duplicateDecision, "KEEP_EXISTING");
  assert.equal(kept?.active, false);
  assert.equal(fs.existsSync(path.join(output, "skills", "code-review", "skill.json")), false);
  const partial = report.entries.find((entry) => entry.name === "Optional Widget Skill");
  assert.equal(partial?.certificationStatus, "partially_supported");
  assert.equal(partial?.active, true);
  const partialBody = fs.readFileSync(path.join(output, "skills", partial!.slug!, "SKILL.md"), "utf8");
  assert.match(partialBody, /Widget listens on port 4070|Describe the widget/);
  assert.match(partialBody, /Omit unsupported capabilities/);
  assert.match(partialBody, /vendor_optional_widget/);
  fs.rmSync(snapshot, { recursive: true, force: true });
  fs.rmSync(output, { recursive: true, force: true });
  fs.rmSync(builtins, { recursive: true, force: true });
});

test("certified and partially supported claude skills are active and blocked skills are not", () => {
  const manifestPath = path.join(path.dirname(builtinSkillsRoot()), "imported-skills", "claude-skills", "import-manifest.json");
  assert.equal(fs.existsSync(manifestPath), true, "import manifest");
  const noticesDir = path.dirname(path.dirname(builtinSkillsRoot()));
  const notices = fs.readFileSync(path.join(noticesDir, "THIRD_PARTY_NOTICES.md"), "utf8");
  assert.match(notices, /MIT License/);
  assert.match(notices, /Copyright \(c\) 2025 Alireza Rezvani/);
  assert.match(notices, /alirezarezvani\/claude-skills/);

  const report = skillRegistry.report();
  assert.deepEqual(report.rejected, []);
  const builtins = report.skills.filter((skill) => skill.metadata.source !== "imported");
  assert.equal(builtins.length, 105);
  const imported = report.skills.filter((skill) => skill.metadata.source === "imported");
  const certified = imported.filter((skill) => skill.metadata.certificationStatus === "certified");
  const partial = imported.filter((skill) => skill.metadata.certificationStatus === "partially_supported");
  const blocked = imported.filter((skill) => skill.metadata.certificationStatus === "blocked");
  assert.ok(certified.length > 0);
  assert.ok(partial.length > 0);
  assert.ok(blocked.length > 0);
  for (const skill of [...certified, ...partial]) {
    assert.equal(skill.metadata.trusted, true);
    assert.equal(skill.enabled, true);
  }
  for (const skill of blocked) {
    assert.equal(skill.metadata.trusted, false);
    assert.equal(skill.enabled, false);
  }

  const engineering = matchValidatedSkills("Review this TypeScript API, fix the issue, run tests, and verify it.");
  assert.ok(engineering.length >= 2 && engineering.length <= 5);
  assert.ok(engineering.some((skill) => skill.id === "skill_code_with_tests"));
  assert.ok(engineering.some((skill) => skill.id === "skill_cs_code_reviewer"));

  const browser = matchValidatedSkills("Test this page with Playwright-style browser checks and find broken flows.");
  assert.ok(browser.length >= 1 && browser.length <= 5);
  const browserSkill = browser.find((skill) => skill.id === "skill_cs_pw_review");
  assert.ok(browserSkill);
  assert.match(browserSkill!.steps.join("\n"), /browser_open/);
  assert.match(browserSkill!.steps.join("\n"), /Do not create a second browser/);

  const infra = matchValidatedSkills("Inspect this Terraform configuration and find the deployment problem.");
  assert.ok(infra.length >= 1 && infra.length <= 5);
  assert.ok(infra.some((skill) => skill.id === "skill_cs_terraform_patterns"));

  const research = matchValidatedSkills("Research this technical topic and compare the approaches.");
  assert.ok(research.length >= 2 && research.length <= 5);
  assert.ok(research.some((skill) => skill.id === "skill_cs_research"));
  assert.ok(research.some((skill) => skill.id === "skill_cs_deep_research"));

  const blockedSkill = blocked.find((skill) => skill.metadata.slug === "browserstack");
  assert.ok(blockedSkill);
  const blockedMatch = matchValidatedSkills(blockedSkill!.metadata.triggers[0] ?? blockedSkill!.name);
  assert.equal(blockedMatch.some((skill) => skill.id === blockedSkill!.id), false);

  const partialSkill = partial.find((skill) => skill.metadata.slug === "litreview");
  assert.ok(partialSkill);
  assert.equal(partialSkill!.enabled, true);
  const partialMatch = matchValidatedSkills(partialSkill!.metadata.triggers[0] ?? partialSkill!.name);
  assert.ok(partialMatch.some((skill) => skill.id === partialSkill!.id));
  assert.match(partialSkill!.steps.join("\n"), /Omit unsupported capabilities/);
  assert.match(partialSkill!.instructions, /Consensus MCP/);
  assert.match(partialSkill!.steps.join("\n"), /optional Consensus|optional MCP|Consensus/);

  assert.deepEqual(matchValidatedSkills("Generate a virphone logo in png format").map((skill) => skill.id), ["skill_deliver_file"]);
  assert.deepEqual(matchValidatedSkills("Fix the failing tests").map((skill) => skill.id), ["skill_code_with_tests"]);
  assert.deepEqual(matchValidatedSkills("The dashboard layout overflows").map((skill) => skill.id), ["skill_visual_verify"]);
  assert.deepEqual(matchValidatedSkills("What time is it?").map((skill) => skill.id), []);
});
