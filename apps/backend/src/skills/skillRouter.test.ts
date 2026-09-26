import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { skillRegistry } from "./SkillRegistry";
import { loadSkillReference } from "./SkillContextLoader";
import { routeSkills } from "./SkillRouter";
import type { RankableSkill } from "./SkillRanker";

const PROMPTS = {
  typescript: "Fix this TypeScript API error and run the tests.",
  react: "Fix this React dashboard overflow and verify it on mobile.",
  terraform: "Review this Terraform deployment and fix the networking problem.",
  sip: "Diagnose a SIP call that rings and disconnects when answered.",
  pricing: "Create a SaaS pricing strategy.",
  opensource: "Inspect this unfamiliar open-source application and fix why it will not start.",
  blocked: "Run this suite on browserstack across safari.",
  clock: "What time is it?",
};

const registry = skillRegistry.list();

function ids(instruction: string, extra: Partial<Omit<Parameters<typeof routeSkills>[0], "instruction" | "skills">> = {}) {
  return routeSkills({ instruction, skills: registry, ...extra });
}

test("A TypeScript API selects a small coding and testing set", () => {
  const routed = ids(PROMPTS.typescript);
  const selected = routed.selected.map((skill) => skill.id);
  assert.ok(selected.length >= 2 && selected.length <= 5, selected.join(", "));
  for (const id of ["skill_eng_typescript", "skill_eng_coding_agent", "skill_eng_test_verify", "skill_cs_code_reviewer"]) {
    assert.ok(selected.includes(id), `${id} missing from ${selected.join(", ")}`);
  }
  assert.equal(selected.some((id) => id.startsWith("skill_tel_") || id.includes("pricing")), false);
  assert.ok(routed.prompt.includes("TypeScript Engineering"));
  assert.equal(routed.prompt.includes("Inspect, configure, build, and verify Kamailio"), false);
  assert.equal(routed.reasonSummary.includes("score"), false);
});

test("B React dashboard keeps frontend and visual skills and drops unrelated packs", () => {
  const routed = ids(PROMPTS.react);
  const selected = routed.selected.map((skill) => skill.id);
  assert.ok(selected.length <= 5, selected.join(", "));
  for (const id of ["skill_eng_react", "skill_eng_frontend_design", "skill_ui_responsive"]) {
    assert.ok(selected.includes(id), `${id} missing from ${selected.join(", ")}`);
  }
  assert.ok(selected.includes("skill_ui_visual") || selected.includes("skill_visual_verify"), selected.join(", "));
  for (const skill of routed.selected) {
    const category = skill.category.toLowerCase();
    assert.equal(/devops|marketing|telecom/.test(category), false, skill.name);
  }
});

test("C Terraform review selects infrastructure and networking skills", () => {
  const routed = ids(PROMPTS.terraform);
  const selected = routed.selected.map((skill) => skill.id);
  assert.ok(selected.length <= 5, selected.join(", "));
  for (const id of ["skill_cs_terraform_patterns", "skill_ops_network", "skill_ops_deploy_verify"]) {
    assert.ok(selected.includes(id), `${id} missing from ${selected.join(", ")}`);
  }
  assert.equal(selected.includes("skill_eng_react"), false);
  assert.equal(selected.some((id) => id.startsWith("skill_tel_")), false);
});

test("D SIP diagnosis selects signaling and media skills only", () => {
  const routed = ids(PROMPTS.sip);
  const selected = routed.selected.map((skill) => skill.id);
  assert.ok(selected.length <= 5, selected.join(", "));
  assert.ok(selected.includes("skill_tel_sip"), selected.join(", "));
  assert.ok(selected.includes("skill_tel_rtp"), selected.join(", "));
  const telecom = routed.selected.filter((skill) => skill.category === "Telecom Engineering");
  assert.ok(telecom.length < 6, telecom.map((skill) => skill.name).join(", "));
  for (const id of ["skill_tel_kamailio", "skill_tel_asterisk", "skill_tel_yeti", "skill_tel_opensips", "skill_tel_freeswitch"]) {
    assert.equal(selected.includes(id), false, id);
  }
});

test("E SaaS pricing stays on commercial skills", () => {
  const routed = ids(PROMPTS.pricing);
  const selected = routed.selected.map((skill) => skill.id);
  assert.ok(selected.includes("skill_cs_pricing_strategy"), selected.join(", "));
  assert.equal(selected.includes("skill_cs_pricing_strategist"), false);
  assert.equal(selected.includes("skill_cs_saas_scaffolder"), false);
  assert.ok(selected.length <= 5);
  for (const skill of routed.selected) {
    const category = skill.category.toLowerCase();
    assert.equal(/(^engineering$|server|telecom|browser|systems)/.test(category), false, skill.name);
  }
  assert.equal(routed.prompt.includes("Pricing Models — Deep Dive"), false);
  const pricing = routed.selected.find((skill) => skill.id === "skill_cs_pricing_strategy");
  assert.ok(pricing);
  const reference = loadSkillReference(pricing, "references/pricing-models.md");
  assert.ok(reference?.includes("Pricing Models — Deep Dive"));
  assert.equal(loadSkillReference(pricing, "scripts/pricing_modeler.py"), null);
  assert.equal(loadSkillReference(pricing, "../skill.json"), null);
  assert.equal(loadSkillReference(pricing, "references/../../skill.json"), null);
});

test("F unfamiliar open-source startup failure uses generic systems skills", () => {
  const routed = ids(PROMPTS.opensource);
  const selected = routed.selected.map((skill) => skill.id);
  assert.ok(selected.length <= 5, selected.join(", "));
  assert.ok(selected.includes("skill_sys_opensource"), selected.join(", "));
  assert.ok(selected.includes("skill_sys_patch"), selected.join(", "));
  assert.ok(selected.includes("skill_sys_config_trouble") || selected.includes("skill_sys_config"), selected.join(", "));
  assert.ok(selected.includes("skill_ops_linux_diagnostics") || selected.includes("skill_sys_linux_install"), selected.join(", "));
  assert.equal(selected.some((id) => id.startsWith("skill_tel_")), false);
});

test("G a blocked imported skill is never selected", () => {
  const routed = ids(PROMPTS.blocked);
  assert.equal(routed.selected.some((skill) => skill.id === "skill_cs_browserstack"), false);
  assert.ok(routed.rejectedByCapability.some((item) => item.id === "skill_cs_browserstack"));
  assert.equal(routed.selected.some((skill) => skill.metadata.certificationStatus === "blocked"), false);
});

test("an empty request loads no skills", () => {
  const routed = ids(PROMPTS.clock);
  assert.equal(routed.selected.length, 0);
  assert.equal(routed.prompt, "");
});

test("SSH and browser skills stay out when the capability is missing", () => {
  const ssh = ids("restart the service over ssh", { resources: { ssh: false } });
  assert.equal(ssh.selected.some((skill) => skill.id === "skill_ops_ssh"), false);
  assert.ok(ssh.rejectedByCapability.some((item) => item.id === "skill_ops_ssh"));

  const explain = ids("how does SSH work", { resources: { ssh: false } });
  assert.ok(explain.selected.some((skill) => skill.id === "skill_ops_ssh"));

  const browser = ids("test this page in the browser", { resources: { browser: false } });
  assert.equal(browser.selected.some((skill) => skill.id === "skill_ui_browser_qa"), false);
  assert.ok(browser.rejectedByCapability.some((item) => item.id === "skill_ui_browser_qa"));
});

test("a Go-only project does not take a React skill unless the request names React", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orvyn-go-"));
  fs.writeFileSync(path.join(dir, "go.mod"), "module example.com/app\n\ngo 1.22\n");
  const plain = ids("fix the handler", { openProject: dir });
  assert.equal(plain.selected.some((skill) => skill.id === "skill_eng_react"), false);

  const named = ids("fix the React handler", { openProject: dir });
  assert.ok(named.selected.some((skill) => skill.id === "skill_eng_react"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("related skills do not activate from zero and a missing required tool rejects the skill", () => {
  const typescript = registry.find((skill) => skill.id === "skill_eng_typescript");
  assert.ok(typescript);
  const hanger: RankableSkill = {
    ...typescript,
    id: "skill_related_hanger",
    name: "Unrelated Widget",
    trigger: "unrelated widget ritual",
    instructions: "Hanger body.",
    category: "General",
    metadata: {
      ...typescript.metadata,
      id: "skill_related_hanger",
      slug: "unrelated-widget",
      name: "Unrelated Widget",
      triggers: ["unrelated widget ritual"],
      tags: [],
      taskDomains: [],
      requiredTools: [],
      relatedSkillIds: ["skill_eng_typescript"],
    },
  };
  const routed = routeSkills({
    instruction: PROMPTS.typescript,
    skills: [...registry, hanger],
  });
  assert.equal(routed.selected.some((skill) => skill.id === "skill_related_hanger"), false);

  const missing = ids(PROMPTS.typescript, { availableTools: ["read_file"] });
  assert.equal(missing.selected.some((skill) => skill.id === "skill_eng_typescript"), false);
  assert.ok(missing.rejectedByCapability.some((item) => item.id === "skill_eng_typescript"));
});

test("H routing the full registry stays fast and bounded", () => {
  assert.ok(registry.length >= 490, `registry ${registry.length}`);
  const prompts = [
    PROMPTS.typescript,
    PROMPTS.react,
    PROMPTS.terraform,
    PROMPTS.sip,
    PROMPTS.pricing,
    PROMPTS.opensource,
    PROMPTS.blocked,
    PROMPTS.clock,
    "how does SSH work",
    "Research this technical topic and compare the approaches.",
    "Review this change for security issues in the payment flow.",
    "Write release notes for the API.",
  ];
  const started = Date.now();
  const results = prompts.map((instruction) => ids(instruction));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `routing took ${elapsed}ms`);

  let candidateTotal = 0;
  let selectedTotal = 0;
  let maxSelected = 0;
  let blockedSelected = 0;
  const overlaps: string[] = [];
  for (const result of results) {
    candidateTotal += result.candidateCount;
    selectedTotal += result.selected.length;
    maxSelected = Math.max(maxSelected, result.selected.length);
    assert.ok(result.selected.length <= 7, result.selected.map((skill) => skill.name).join(", "));
    for (const skill of result.selected) {
      if (skill.metadata.certificationStatus === "blocked" || skill.enabled === false) blockedSelected += 1;
    }
    for (const overlap of result.overlapsCollapsed) overlaps.push(`${overlap.droppedName} -> ${overlap.keptName}`);
  }

  const report = {
    totalRegistrySkills: registry.length,
    averageCandidateCount: Number((candidateTotal / results.length).toFixed(2)),
    averageSelectedSkillCount: Number((selectedTotal / results.length).toFixed(2)),
    maxSelectedCount: maxSelected,
    blockedSkillsIncorrectlySelected: blockedSelected,
    duplicateOverlapCases: overlaps,
    elapsedMs: elapsed,
    prompts: results.length,
  };
  console.log(`SKILL_ROUTER_REPORT ${JSON.stringify(report)}`);
  assert.equal(blockedSelected, 0);
  assert.ok(report.averageSelectedSkillCount <= 5);
  assert.ok(maxSelected <= 7);
});
