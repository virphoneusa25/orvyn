import { test } from "node:test";
import assert from "node:assert/strict";
import { isWebsiteInspection, websiteInspectionEvidence } from "./websiteInspection";
import { inferTaskIntent } from "./taskIntent";
import { selectToolNames } from "./toolPolicy";
import { evaluatePreflight } from "./runPreflight";
import { evaluateCompletionGates } from "./completionGates";
import { selectAgentModel } from "../models/selectModel";

test("URL and natural-language website reviews are browser observation, without a repository or terminal", () => {
  for (const prompt of [
    "Review https://kernelailabs.com",
    "Can you review my website?",
    "What do you think of https://example.com?",
    "Look at example.com and suggest changes to improve the layout.",
    "Review the website and test its links for errors.",
    "Inspect the homepage hero image and verify the responsive layout.",
  ]) {
    const intent = inferTaskIntent(prompt);
    assert.equal(intent.category, "browser", prompt);
    assert.equal(intent.informational, false, prompt);
    assert.equal(intent.requiresBrowser, true, prompt);
    assert.equal(intent.requiresBrowserVerification, true, prompt);
    assert.equal(intent.requiresFrontend, false, prompt);
    assert.equal(intent.requiresWorkspace, false, prompt);
    assert.equal(intent.requiresTerminal, false, prompt);
    assert.deepEqual(intent.resourceRequirements, ["browser_session"], prompt);
    assert.equal(evaluatePreflight({ intent, workspace: { repositoryDetected: false } as any, servers: [] }).status, "ok");
  }
});

test("website edits, repository reviews and conceptual questions retain their existing intent", () => {
  for (const prompt of ["Build a responsive website", "Review and fix my website", "Redesign the homepage", "Review my GitHub repository at https://github.com/acme/project", "How can I review my website?"]) {
    assert.equal(isWebsiteInspection(prompt), false, prompt);
  }
  assert.equal(inferTaskIntent("Build a responsive website").requiresFrontend, true);
  assert.equal(inferTaskIntent("How can I review my website?").informational, true);
});

test("website reviews expose browser tools and exclude implementation tools without bypassing permissions", () => {
  const names = ["browser_open", "browser_navigate", "browser_screenshot", "browser_evidence", "fetch_url", "web_search", "write_file", "edit_file", "terminal", "start_process", "run_tests", "git_commit", "ssh_exec"];
  assert.deepEqual(selectToolNames(names, inferTaskIntent("Review https://example.com"), { repositoryDetected: false }),
    ["browser_open", "browser_navigate", "browser_screenshot", "browser_evidence", "fetch_url", "web_search"]);
});

const completed = (tool: string) => ({ type: "tool.completed", data: { tool } });
test("website completion requires a successful navigation followed by a screenshot", () => {
  const instruction = "Review https://example.com";
  for (const events of [[], [completed("fetch_url")], [completed("browser_open")], [completed("browser_screenshot"), completed("browser_open")], [{ type:"tool.failed",data:{tool:"browser_open"} }, completed("browser_screenshot")]]) {
    const result = evaluateCompletionGates({ instruction, artifacts: [], events, category: "browser" });
    assert.equal(result.ok, false, JSON.stringify(events));
    assert.equal(result.failedGate, "visual");
    assert.match(result.retryPrompt, /browser_open/);
  }
  assert.equal(evaluateCompletionGates({instruction,artifacts:[],events:[completed("browser_open"),completed("browser_screenshot")],category:"browser"}).ok,true);
});

test("a later navigation or navigation failure invalidates evidence for the previous page", () => {
  const events = [completed("browser_open"), completed("browser_screenshot")];
  assert.deepEqual(websiteInspectionEvidence([...events, completed("browser_navigate")]), { opened:true, screenshot:false });
  assert.deepEqual(websiteInspectionEvidence([...events, {type:"tool.failed",data:{tool:"browser_navigate"}}]), {opened:false,screenshot:false});
  assert.deepEqual(websiteInspectionEvidence([{type:"tool.completed",data:{tool:"browser_open",ok:false}},completed("browser_screenshot")]), {opened:false,screenshot:false});
});

test("reviewing a hero image or verifying links does not demand artifact creation or source-code tests", () => {
  for (const instruction of ["Review the website hero image", "Review the website and verify its links"]) {
    const result = evaluateCompletionGates({instruction,artifacts:[],events:[completed("browser_open"),completed("browser_screenshot")],category:"browser"});
    assert.equal(result.ok,true,JSON.stringify(result));
  }
});

test("automatic website review routes to available vision models; escalation cannot select a text-only model", () => {
  const text = "nebius:zai-org/GLM-5.3";
  const vision = "fw:accounts/fireworks/models/qwen3-vl-8b-instruct";
  for (const escalate of [0,1,3]) {
    const choice = selectAgentModel({intent:inferTaskIntent("Review https://example.com"),requestedModelId:"auto",availableIds:[text,vision],visionIds:[vision],escalate});
    assert.equal(choice.registryId,vision);
    assert.equal(choice.route?.profile,"auto");
  }
  const unavailable = selectAgentModel({intent:inferTaskIntent("Review https://example.com"),availableIds:[text],visionIds:[]});
  assert.equal(unavailable.registryId,null,"no pretending a text-only route can inspect a screenshot");
  const pinned = selectAgentModel({intent:inferTaskIntent("Review https://example.com"),requestedModelId:text,availableIds:[text,vision],visionIds:[vision]});
  assert.equal(pinned.registryId,text,"runtime validates explicit choices rather than silently replacing them");
});
