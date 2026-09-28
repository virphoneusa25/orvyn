import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCapabilityManifest, classifyTool, manifestPrompt, resolveCapabilityNeed } from "./capabilityManifest";
import { capabilityGapFor } from "./capabilityGap";
import { rebaseRootUrls } from "./sitePreview";
import { runOutcome } from "./runOutcome";
import { handoffPrompt } from "../ai/Orchestrator";

const CORE = ["read_file", "write_file", "edit_file", "list_directory", "terminal", "git_status", "browser_open", "browser_screenshot", "search_capabilities"].map((name) => ({ name }));
const allowed = () => "allowed";
const known = (n: string) => CORE.some((t) => t.name === n);

test("core vs MCP classification", () => {
  assert.equal(classifyTool("edit_file"), "core");
  assert.equal(classifyTool("terminal"), "core");
  assert.equal(classifyTool("mcp.salesforce.update_record"), "mcp");
  assert.equal(classifyTool("github_create_pr"), "integration");
});

test("the manifest comes from the registry and permissions", () => {
  const m = buildCapabilityManifest([...CORE, { name: "mcp.brave.brave_web_search" }], allowed, { projectRoot: "/p" });
  assert.deepEqual(m.workspace, { root: "/p", readable: true, writable: true, shell: true, git: true, location: "local" });
  assert.deepEqual(m.mcp, ["mcp.brave.brave_web_search"]);
  assert.match(manifestPrompt(m), /create\/edit\/delete files yes/);
  const ro = buildCapabilityManifest(CORE, (n) => (/write_file|edit_file/.test(n) ? "denied" : "allowed"));
  assert.equal(ro.workspace.writable, false);
  assert.match(manifestPrompt(ro), /ORVYN needs permission to modify this workspace/);
});

test("project work is never an MCP request; only real outside services are", () => {
  const m = buildCapabilityManifest(CORE, allowed);
  for (const q of ["edit the VirPhone website files, add the attached VirPhone_New_Logo.png to the header, and verify the published preview", "this task", "edit index.html", "add an animated hero background", "make the logo spin"]) {
    assert.equal(resolveCapabilityNeed(q, m, known).kind, "native", q);
  }
  assert.equal(resolveCapabilityNeed("update a Salesforce CRM record", m, known).kind, "mcp");
  assert.equal(resolveCapabilityNeed("send and read email", m, known).kind, "mcp");
  const withBrave = buildCapabilityManifest([...CORE, { name: "mcp.brave.brave_web_search" }], allowed);
  assert.equal(resolveCapabilityNeed("search the web", withBrave, known).kind, "installed");
});

test("writes switched off → a permission message, not an MCP card; changes already made prove write access", () => {
  const ro = buildCapabilityManifest(CORE, (n) => (/write_file|edit_file/.test(n) ? "denied" : "allowed"));
  const need = resolveCapabilityNeed("edit styles.css", ro, known);
  assert.deepEqual(need, { kind: "permission", message: "ORVYN needs permission to modify this workspace." });
  assert.equal(resolveCapabilityNeed("edit styles.css", ro, known, { filesChanged: 2 }).kind, "native");
});

test("a failing core tool is a workspace problem, never a Marketplace gap", () => {
  assert.equal(capabilityGapFor({ toolName: "edit_file", error: "Local Worker not connected" }), null);
  assert.equal(capabilityGapFor({ toolName: "terminal", error: "not available" }), null);
  assert.equal(capabilityGapFor({ toolName: "web_search", error: "no search provider" }), "search the web");
});

test("root-absolute URLs are served from the site's own root", () => {
  const html = rebaseRootUrls('<link rel="stylesheet" href="/styles.css"><script src="/app.js"></script><img src="assets/a.png"><a href="//cdn.x/y">x</a><div style="background:url(/h.svg)"></div>', "/api/v1/sites/abc", "html");
  assert.match(html, /href="\/api\/v1\/sites\/abc\/styles\.css"/);
  assert.match(html, /src="\/api\/v1\/sites\/abc\/app\.js"/);
  assert.match(html, /src="assets\/a\.png"/);
  assert.match(html, /href="\/\/cdn\.x\/y"/);
  assert.match(html, /url\(\/api\/v1\/sites\/abc\/h\.svg\)/);
  assert.equal(rebaseRootUrls('.a{background:url("/x.png")}', "/api/v1/sites/abc", "css"), '.a{background:url("/api/v1/sites/abc/x.png")}');
  assert.equal(rebaseRootUrls('<link href="/api/v1/sites/abc/s.css">', "/api/v1/sites/abc", "html"), '<link href="/api/v1/sites/abc/s.css">');
});

test("the run outcome is complete only when every check passed", () => {
  assert.equal(runOutcome([{ type: "preview.verified" }, { type: "verification.completed", data: { verdict: "PASS" } }]).outcome, "complete");
  const broken = runOutcome([{ type: "preview.failed", data: { issues: ["styles.css → 404"] } }]);
  assert.equal(broken.outcome, "partial");
  assert.match(broken.reasons[0]!, /styles\.css → 404/);
  assert.equal(runOutcome([{ type: "preview.failed" }, { type: "preview.verified" }]).outcome, "complete", "a later passing check wins");
  assert.equal(runOutcome([{ type: "capability.required", data: { query: "update Salesforce" } }]).outcome, "partial");
});

test("a chat handoff carries the user's real request, not '?'", () => {
  const history = [{ role: "user" as const, content: "Can you add an animated hero background?" }, { role: "assistant" as const, content: "Sure" }];
  assert.equal(handoffPrompt("this task", { userMessage: "?", history }), "Can you add an animated hero background?");
  assert.equal(handoffPrompt("Add an animated gradient to the hero in styles.css", { userMessage: "?", history }), "Add an animated gradient to the hero in styles.css");
  assert.equal(handoffPrompt("", { userMessage: "Use the attached logo in the header please", history: [] }), "Use the attached logo in the header please");
});
