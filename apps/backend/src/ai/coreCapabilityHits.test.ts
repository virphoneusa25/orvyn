import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coreCapabilityCovers,
  looksLikeCloudArtifactRequest,
  looksLikeDocumentRequest,
  looksLikeZipRequest,
} from "./coreCapabilityHits";

test("cloud deliverable phrasing is recognized without a project", () => {
  assert.equal(looksLikeDocumentRequest("Create a PDF report of Q1 sales"), true);
  assert.equal(looksLikeDocumentRequest("Explain how PDF compression works"), false);
  assert.equal(looksLikeZipRequest("Make a zip of these HTML files"), true);
  assert.equal(looksLikeCloudArtifactRequest("Generate an image of a sunrise over snowy mountains"), true);
  assert.equal(looksLikeCloudArtifactRequest("Create an Excel spreadsheet of expenses"), true);
});

test("capability search names core tools instead of MCP for ChatGPT-style work", () => {
  assert.equal(coreCapabilityCovers("generate_image sunrise mountains"), true);
  assert.equal(coreCapabilityCovers("create a PDF invoice"), true);
  assert.equal(coreCapabilityCovers("python interpreter to run this script"), true);
  assert.equal(coreCapabilityCovers("search the web for nginx docs"), true);
  assert.equal(coreCapabilityCovers("send email with gmail"), false);
});
