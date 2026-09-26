import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SkillRegistry, skillRegistry } from "./SkillRegistry";
import { displayCategory, listSkillFiles, qualityReportView, readSkillFile, skillCatalog, skillDetail, skillSearchText } from "./SkillCatalog";
import { routeSkills } from "./SkillRouter";
import { latestSkillRoute, listSkillEvents } from "./SkillRouteLog";
import { qualityReportPath } from "./quality/SkillQualityReport";

test("catalog counts match the live registry and the quality report", () => {
  const catalog = skillCatalog();
  const report = JSON.parse(fs.readFileSync(qualityReportPath(), "utf8")) as {
    totalChecked: number;
    approved: number;
    needsRevision: number;
    disabled: number;
  };
  assert.equal(catalog.counts.total, skillRegistry.list().length);
  assert.equal(catalog.counts.total, report.totalChecked);
  assert.equal(catalog.counts.approved, report.approved);
  assert.equal(catalog.counts.needsRevision, report.needsRevision);
  assert.equal(catalog.counts.disabled, report.disabled);
  assert.equal(catalog.counts.builtin + catalog.counts.imported, catalog.counts.total);
  assert.equal("instructions" in catalog.skills[0], false);
  const grouped = catalog.categories.reduce((sum, row) => sum + row.count, 0);
  assert.equal(grouped, catalog.counts.total);
  assert.equal(displayCategory("engineering-team"), "Software Engineering");
  assert.equal(displayCategory("Telecom Engineering"), "Telecom Engineering");
  assert.equal(displayCategory("marketing"), "Business & Strategy");
  const view = qualityReportView();
  assert.ok(view);
  assert.equal(view.totalChecked, report.totalChecked);
  assert.equal(view.approved, report.approved);
  assert.equal(view.needsRevision, report.needsRevision);
  assert.equal(view.disabled, report.disabled);
  assert.equal(view.disabledSkills.length, report.disabled);
});

test("search and filters use registry fields", () => {
  const catalog = skillCatalog();
  const typescript = catalog.skills.filter((skill) => skillSearchText(skill).includes("typescript"));
  assert.ok(typescript.some((skill) => skill.name === "TypeScript Engineering"));
  const imported = catalog.skills.filter((skill) => skill.source === "imported");
  assert.equal(imported.length, catalog.counts.imported);
  assert.ok(imported.every((skill) => skill.source === "imported"));
  const blocked = catalog.skills.filter((skill) => skill.qualityStatus === "disabled" || skill.certificationStatus === "blocked");
  assert.ok(blocked.some((skill) => skill.id === "skill_cs_browserstack"));
  assert.ok(blocked.length >= catalog.counts.disabled);
});

test("TypeScript Engineering detail and code-reviewer provenance come from the packages", () => {
  const typescript = skillDetail("skill_eng_typescript");
  assert.ok(typescript);
  assert.equal(typescript.name, "TypeScript Engineering");
  assert.equal(typescript.source, "builtin");
  assert.ok(typescript.triggers.some((trigger) => /typescript/i.test(trigger)));
  assert.equal(typescript.publisher, "Kernel AI Labs");
  assert.equal(typescript.usage, null);

  const reviewer = skillDetail("skill_cs_code_reviewer");
  assert.ok(reviewer);
  assert.equal(reviewer.source, "imported");
  assert.equal(reviewer.origin?.repository, "https://github.com/alirezarezvani/claude-skills");
  assert.equal(reviewer.origin?.path, "engineering-team/skills/code-reviewer");
  assert.equal(reviewer.origin?.author, "Alireza Rezvani");
  assert.equal(reviewer.origin?.license, "MIT");
  assert.ok(reviewer.files.some((file) => file.path === "SKILL.md"));
  const script = reviewer.files.find((file) => file.path.startsWith("scripts/") && file.path.endsWith(".py"));
  assert.ok(script);
  assert.equal(script.executable, false);
  assert.equal(script.inert, true);
  const skill = skillRegistry.list().find((item) => item.id === "skill_cs_code_reviewer");
  assert.ok(skill);
  const absolute = path.join(skill.dir, script.path);
  const before = fs.statSync(absolute).mode;
  const body = readSkillFile("skill_cs_code_reviewer", script.path);
  assert.equal(body.executable, false);
  assert.equal(body.inert, true);
  assert.match(body.content, /def |import /);
  assert.equal(fs.statSync(absolute).mode, before);
  const skillMd = readSkillFile("skill_cs_code_reviewer", "SKILL.md");
  assert.match(skillMd.content, /Code Reviewer/);
  assert.throws(() => readSkillFile("skill_eng_typescript", "../skill.json"));
  assert.equal(listSkillFiles("skill_eng_typescript").some((file) => file.path === "SKILL.md"), true);
});

test("enable and disable persist, blocked skills stay off, and the router excludes a disabled skill", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orvyn-skill-prefs-"));
  const previous = process.env.ORVYN_DATA_DIR;
  process.env.ORVYN_DATA_DIR = dir;
  try {
    assert.throws(() => skillRegistry.setEnabled("skill_cs_browserstack", true), /certification/);
    assert.equal(skillRegistry.list().find((skill) => skill.id === "skill_cs_browserstack")?.enabled, false);
    assert.throws(() => skillRegistry.setEnabled("skill_cs_slo_architect_2", true), /quality review/);

    skillRegistry.setEnabled("skill_cs_pricing_strategy", false);
    assert.equal(skillRegistry.list().find((skill) => skill.id === "skill_cs_pricing_strategy")?.enabled, false);
    const reloaded = new SkillRegistry();
    assert.equal(reloaded.list().find((skill) => skill.id === "skill_cs_pricing_strategy")?.enabled, false);
    const hidden = routeSkills({ instruction: "Create a SaaS pricing strategy." });
    assert.equal(hidden.selected.some((skill) => skill.id === "skill_cs_pricing_strategy"), false);
    assert.ok(listSkillEvents().some((event) => event.type === "skill.disabled" && event.skillId === "skill_cs_pricing_strategy"));

    skillRegistry.setEnabled("skill_cs_pricing_strategy", true);
    const restored = routeSkills({ instruction: "Create a SaaS pricing strategy." });
    assert.ok(restored.selected.some((skill) => skill.id === "skill_cs_pricing_strategy"));
    assert.equal(new SkillRegistry().list().find((skill) => skill.id === "skill_cs_pricing_strategy")?.enabled, true);
  } finally {
    try {
      skillRegistry.setEnabled("skill_cs_pricing_strategy", true);
    } catch {
      // The temp preference file is discarded with the directory.
    }
    if (previous === undefined) delete process.env.ORVYN_DATA_DIR;
    else process.env.ORVYN_DATA_DIR = previous;
  }
});

test("a coding route records scores without changing the selected set", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orvyn-skill-route-"));
  const previous = process.env.ORVYN_DATA_DIR;
  process.env.ORVYN_DATA_DIR = dir;
  try {
    const routed = routeSkills({ instruction: "Fix this TypeScript API error and run the tests." });
    const selected = routed.selected.map((skill) => skill.id);
    const rankedSelected = routed.ranked.filter((row) => row.selected).map((row) => row.id);
    assert.deepEqual(rankedSelected, selected);
    assert.ok(routed.ranked.every((row) => typeof row.score === "number" && row.score >= 40));
    const latest = latestSkillRoute();
    assert.ok(latest);
    assert.equal(latest.candidateCount, routed.candidateCount);
    assert.equal(latest.selectedCount, routed.selected.length);
    assert.equal(latest.rejectedByCapabilityCount, routed.rejectedByCapability.length);
    assert.equal(latest.rejectedByScoreCount, routed.rejectedByScore.length);
    assert.ok(latest.selected.some((skill) => skill.name === "TypeScript Engineering" && skill.score > 0));
    assert.ok(listSkillEvents().some((event) => event.type === "skills.routed"));
    assert.equal(latest.reasonSummary.includes("score"), false);
  } finally {
    if (previous === undefined) delete process.env.ORVYN_DATA_DIR;
    else process.env.ORVYN_DATA_DIR = previous;
  }
});

test("catalog search stays responsive after the registry is cached", () => {
  skillCatalog();
  const started = Date.now();
  for (let i = 0; i < 25; i += 1) {
    const catalog = skillCatalog();
    const hits = catalog.skills.filter((skill) => skillSearchText(skill).includes("typescript"));
    assert.ok(hits.length > 0);
  }
  assert.ok(Date.now() - started < 1500, `catalog filter took ${Date.now() - started}ms`);
});
