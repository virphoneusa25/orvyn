import { test } from "node:test";
import assert from "node:assert/strict";
import { SkillLoader, builtinSkillsRoot } from "./SkillLoader";
import { matchValidatedSkills } from "../learning/validatedSkills";
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

const SYSTEMS = [
  "Open Source Application Engineering",
  "Linux Application Installation",
  "Source Build & Compilation",
  "Application Configuration",
  "Service Integration",
  "Self-Hosted Application Deployment",
  "Open Source Upgrade & Migration",
  "Configuration Troubleshooting",
  "Dependency & Library Diagnosis",
  "Build System Diagnosis",
  "Shell & Automation Engineering",
  "Python Application Engineering",
  "Node.js Application Engineering",
  "Go Application Engineering",
  "Rust Application Engineering",
  "PHP Application Engineering",
  "Web Server Integration",
  "Database Application Integration",
  "API Integration",
  "Authentication & Identity Integration",
  "TLS & Certificate Engineering",
  "Network Service Engineering",
  "Performance Diagnosis",
  "Application Recovery",
  "Source Code Patch & Repair",
  "Upstream Project Analysis",
];

const TELECOM = [
  "SIP Troubleshooting",
  "SIP Ladder Analysis",
  "RTP / Media Diagnosis",
  "FreeSWITCH Engineering",
  "Kamailio Engineering",
  "OpenSIPS Engineering",
  "Asterisk Engineering",
  "Yeti Class 4 Engineering",
  "Carrier Interop Testing",
  "DID Routing Analysis",
  "SIP Registration Diagnosis",
  "Codec / Transcoding Analysis",
  "Telecom Database Integration",
  "Telecom Deployment Verification",
];

const LANGUAGES = [
  "Python Application Engineering",
  "Node.js Application Engineering",
  "Go Application Engineering",
  "Rust Application Engineering",
  "PHP Application Engineering",
];

function body(name: string): string {
  const report = new SkillLoader(builtinSkillsRoot()).load();
  const skill = report.skills.find((item) => item.name === name);
  assert.ok(skill, name);
  return `${skill!.instructions}\n${skill!.metadata.validation.rule}`;
}

test("systems, open source, and telecom built-ins load beside the existing 65 skills", () => {
  const report = new SkillLoader(builtinSkillsRoot()).load();
  assert.deepEqual(report.rejected, []);
  const ids = report.skills.map((skill) => skill.id);
  const slugs = report.skills.map((skill) => skill.metadata.slug);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(slugs).size, slugs.length);
  assert.equal(report.skills.length, 105);
  for (const name of PRIOR) assert.ok(report.skills.some((skill) => skill.name === name), name);

  const systems = report.skills.filter((skill) => skill.metadata.category === "Systems & Open Source");
  const telecom = report.skills.filter((skill) => skill.metadata.category === "Telecom Engineering");
  assert.equal(systems.length, 26);
  assert.equal(telecom.length, 14);
  assert.deepEqual(systems.map((skill) => skill.name).sort(), [...SYSTEMS].sort());
  assert.deepEqual(telecom.map((skill) => skill.name).sort(), [...TELECOM].sort());

  const tools = registeredToolNames();
  for (const skill of [...systems, ...telecom]) {
    assert.equal(skill.metadata.publisher, "Kernel AI Labs");
    assert.equal(skill.metadata.source, "builtin");
    assert.equal(skill.metadata.builtIn, true);
    assert.equal(skill.metadata.trusted, true);
    assert.equal(skill.metadata.scope, "builtin");
    assert.equal(skill.metadata.version, "1.0.0");
    assert.ok(skill.metadata.triggers.length > 0);
    assert.ok(skill.metadata.taskDomains.length > 0);
    assert.ok(skill.metadata.runModes.length > 0);
    assert.deepEqual([...skill.metadata.runModes].sort(), ["agent", "auto", "code", "server"]);
    assert.ok(skill.metadata.validation.rule.trim());
    const referenced = [...skill.metadata.requiredTools, ...skill.metadata.optionalTools];
    const unknown = referenced.filter((name) => !tools.has(name));
    assert.deepEqual(unknown, [], `${skill.name} references unknown tools: ${unknown.join(", ")}`);
    const permissionIds = skill.metadata.permissionsRequired.map((item) => item.id);
    assert.deepEqual([...permissionIds].sort(), [...referenced].sort());
    for (const permission of skill.metadata.permissionsRequired) {
      assert.ok(permission.reason.trim(), `${skill.name} ${permission.id}`);
    }
  }

  for (const skill of systems) {
    const text = `${skill.instructions}\n${skill.metadata.validation.rule}`;
    assert.match(text, /no dedicated skill/i);
    assert.match(text, /do not invent build commands or install commands/i);
  }
  for (const skill of telecom) {
    const text = `${skill.instructions}\n${skill.metadata.validation.rule}`;
    assert.match(text, /specialist skills, not the only systems capability/i);
    assert.match(text, /do not blame a carrier, PBX, SBC, or endpoint without evidence/i);
    assert.match(text, /Linux Server Diagnostics/);
    assert.match(text, /Coding Agent/);
  }

  assert.deepEqual(matchValidatedSkills("Generate a virphone logo in png format").map((skill) => skill.id), ["skill_deliver_file"]);
  assert.deepEqual(matchValidatedSkills("Fix the failing tests").map((skill) => skill.id), ["skill_code_with_tests"]);
  assert.deepEqual(matchValidatedSkills("The dashboard layout overflows").map((skill) => skill.id), ["skill_visual_verify"]);
  assert.deepEqual(matchValidatedSkills("What time is it?").map((skill) => skill.id), []);
});

test("open source, build, patch, and linux install skills stay generic", () => {
  const open = body("Open Source Application Engineering");
  assert.match(open, /no dedicated skill/i);
  assert.match(open, /do not claim an application is unsupported/i);
  assert.match(open, /Coding Agent/);
  assert.match(open, /Test & Verify/);
  assert.match(open, /Linux Server Diagnostics/);
  assert.match(open, /Python Application Engineering/);
  assert.match(open, /inspect, then understand, then diagnose, then modify, then build, then run, then verify/i);

  const build = body("Source Build & Compilation");
  for (const system of ["Make", "CMake", "Autotools", "Meson", "Ninja", "npm", "pnpm", "yarn", "Cargo", "Go modules", "Maven", "Gradle", "Composer", "Python packaging"]) {
    assert.match(build, new RegExp(system.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(build, /do not invent build commands/i);

  const patch = body("Source Code Patch & Repair");
  assert.match(patch, /Coding Agent/);
  assert.match(patch, /minimal changes/i);
  assert.match(patch, /verify runtime behavior/i);
  assert.match(patch, /do not claim the startup failure is fixed without that result/i);

  const install = body("Linux Application Installation");
  assert.match(install, /do not invent install commands/i);
  assert.match(install, /Linux Server Diagnostics/);
  assert.match(install, /SSH Server Operations/);

  const config = body("Application Configuration");
  for (const format of ["YAML", "JSON", "TOML", "INI", "XML", "env"]) {
    assert.match(config, new RegExp(format));
  }
  assert.match(config, /preserve comments and formatting/i);
  assert.match(config, /do not replace entire configuration files unnecessarily/i);

  for (const name of LANGUAGES) {
    const text = body(name);
    assert.match(text, /complements Coding Agent/i);
    assert.match(text, /does not replace it/i);
    assert.match(text, /do not assume one framework/i);
  }
});

test("an unfamiliar application does not require a product-specific skill", () => {
  const report = new SkillLoader(builtinSkillsRoot()).load();
  for (const name of ["Coding Agent", "Test & Verify", "Linux Server Diagnostics", ...LANGUAGES]) {
    assert.ok(report.skills.some((skill) => skill.name === name), name);
  }
  const prompt = "Inspect this application, determine how it is built and configured, fix the startup failure, build it, run it, and verify it.";
  const matched = matchValidatedSkills(prompt);
  const ids = matched.map((skill) => skill.id).sort();
  assert.deepEqual(ids, [
    "skill_code_with_tests",
    "skill_sys_config",
    "skill_sys_opensource",
    "skill_sys_patch",
    "skill_sys_source_build",
  ]);
  assert.equal(ids.filter((id) => id.startsWith("skill_tel_")).length, 0);
  const combined = matched.map((skill) => `${skill.name}\n${skill.steps.join("\n")}`).join("\n");
  assert.match(combined, /Open Source Application Engineering/);
  assert.match(combined, /Coding Agent/);
  assert.match(combined, /Test & Verify/);
  assert.match(combined, /Linux Server Diagnostics/);
  assert.match(combined, /Python Application Engineering/);
});

test("freeswitch, kamailio, and sip skills stay selective", () => {
  const freeswitch = body("FreeSWITCH Engineering");
  assert.match(freeswitch, /SIP Troubleshooting/);
  assert.match(freeswitch, /RTP \/ Media Diagnosis/);
  assert.match(freeswitch, /Linux Server Diagnostics/);
  assert.match(freeswitch, /Coding Agent/);
  assert.match(freeswitch, /Test & Verify/);
  assert.match(freeswitch, /Deployment Verification/);

  const kamailio = body("Kamailio Engineering");
  assert.match(kamailio, /kamailio\.cfg/i);
  assert.match(kamailio, /Linux Server Diagnostics/);
  assert.match(kamailio, /SIP Troubleshooting/);

  const sip = body("SIP Troubleshooting");
  for (const part of ["signaling", "routing", "authentication", "NAT", "media", "codec", "carrier response", "endpoint behavior"]) {
    assert.match(sip, new RegExp(part, "i"));
  }
  assert.match(sip, /do not blame a carrier, PBX, SBC, or endpoint without evidence/i);

  const prompt = "Diagnose a FreeSWITCH SIP call that rings but drops at answer.";
  const matched = matchValidatedSkills(prompt);
  const telecomIds = matched.map((skill) => skill.id).filter((id) => id.startsWith("skill_tel_")).sort();
  assert.deepEqual(telecomIds, ["skill_tel_freeswitch", "skill_tel_rtp", "skill_tel_sip"]);
  assert.ok(telecomIds.length < TELECOM.length);
  const combined = matched.map((skill) => `${skill.name}\n${skill.steps.join("\n")}`).join("\n");
  assert.match(combined, /FreeSWITCH Engineering/);
  assert.match(combined, /SIP Troubleshooting/);
  assert.match(combined, /RTP \/ Media Diagnosis/);
  assert.match(combined, /Linux Server Diagnostics/);
});
