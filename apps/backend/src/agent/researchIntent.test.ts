import { test } from "node:test";
import assert from "node:assert/strict";
import { needsWebResearch } from "./researchIntent";

test("ORION researches on its own when a task needs current or sourced information", () => {
  for (const p of [
    "What is the latest Node.js LTS version?",
    "Research the current Node.js LTS release and cite your sources",
    "Who is the current CEO of Nvidia?",
    "How much does a Hetzner server cost right now?",
    "Compare Kamailio vs OpenSIPS for a VoIP platform",
    "Build a landing page listing the newest iPhone models and their prices",
    "What's in the news about AI today?",
    "THOSE MODELS YOU PROGRAMMED FOR RESEARCH, ARE THEY CHEAP AND CAN BE SELLABLE USAGE WHERE I CAN MAKE GOOD MONEY ON THEM?",
  ]) assert.equal(needsWebResearch(p), true, p);
  for (const p of [
    "Create hello.txt",
    "What is 2+2?",
    "Fix the failing test in src/app.js",
    "Build a small landing page: index.html and style.css",
    "Explain what this project's package.json scripts do",
    "hi",
  ]) assert.equal(needsWebResearch(p), false, p);
});
