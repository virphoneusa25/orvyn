import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { cloudWorkerSourcePath, looksLikeForeignAbsolutePath, resolveWorkspace, virtualWorkspaceRoot } from "./workspace";

test("Windows drive paths are foreign on POSIX hosts", () => {
  if (process.platform === "win32") return;
  assert.equal(looksLikeForeignAbsolutePath("C:\\\\Users\\\\rmckn\\\\viride"), true);
  assert.equal(looksLikeForeignAbsolutePath("D:/Projects/app"), true);
  assert.equal(looksLikeForeignAbsolutePath("/opt/orvyn/workspaces"), false);
  assert.equal(cloudWorkerSourcePath("C:\\\\Users\\\\rmckn\\\\viride"), "");
  assert.equal(cloudWorkerSourcePath("/opt/orvyn/workspaces/tenant/run"), "/opt/orvyn/workspaces/tenant/run");
});

test("cloud mode remaps a client-local folder to the tenant virtual workspace", async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "orvyn-ws-"));
  const cloud = path.join(data, "projects");
  const prevCloud = process.env.ORVYN_PROJECTS_DIR;
  const prevData = process.env.ORVYN_DATA_DIR;
  process.env.ORVYN_PROJECTS_DIR = cloud;
  process.env.ORVYN_DATA_DIR = data;
  try {
    const root = await resolveWorkspace({ id: "user_1", currentProjectRoot: null }, "C:\\\\Users\\\\rmckn\\\\orvyn-desktop-fixture");
    const expected = await fs.realpath(virtualWorkspaceRoot("user_1", data));
    assert.equal(root, expected);
    assert.match(root, /tenants[/\\]user_1[/\\]virtual-workspace$/);
  } finally {
    if (prevCloud === undefined) delete process.env.ORVYN_PROJECTS_DIR;
    else process.env.ORVYN_PROJECTS_DIR = prevCloud;
    if (prevData === undefined) delete process.env.ORVYN_DATA_DIR;
    else process.env.ORVYN_DATA_DIR = prevData;
    await fs.rm(data, { recursive: true, force: true });
  }
});

test("empty projectRoot in cloud mode still yields a writable workspace", async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "orvyn-ws-"));
  const prevCloud = process.env.ORVYN_PROJECTS_DIR;
  const prevData = process.env.ORVYN_DATA_DIR;
  process.env.ORVYN_PROJECTS_DIR = path.join(data, "projects");
  process.env.ORVYN_DATA_DIR = data;
  try {
    const root = await resolveWorkspace({ id: "t-empty", currentProjectRoot: null }, "");
    assert.ok((await fs.stat(root)).isDirectory());
  } finally {
    if (prevCloud === undefined) delete process.env.ORVYN_PROJECTS_DIR;
    else process.env.ORVYN_PROJECTS_DIR = prevCloud;
    if (prevData === undefined) delete process.env.ORVYN_DATA_DIR;
    else process.env.ORVYN_DATA_DIR = prevData;
    await fs.rm(data, { recursive: true, force: true });
  }
});
