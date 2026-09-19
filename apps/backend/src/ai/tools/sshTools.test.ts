// apps/backend/src/ai/tools/sshTools.test.ts
//
// The SSH tool's security property is the allowlist: the model can only reach
// hosts the user configured, never an arbitrary address. These tests pin the
// failure modes that make that true — without any network access.

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { makeSshExecTool, loadSshHosts } from "./sshTools";

async function tempProject(files: Record<string, string> = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orvyn-ssh-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf-8");
  }
  return dir;
}

test("rejects execution when .orvyn/ssh.json does not exist, with setup instructions", async () => {
  const dir = await tempProject();
  const tool = makeSshExecTool(dir);
  const result = await tool.execute({ host: "ovh", command: "uptime" });

  assert.equal(result.ok, false);
  assert.match(result.error!, /No usable SSH configuration/);
  assert.match(result.error!, /orvyn\/ssh\.json/);
});

test("rejects an alias that is not configured, listing the ones that are", async () => {
  const dir = await tempProject({
    ".orvyn/ssh.json": JSON.stringify({
      hosts: [{ alias: "ovh", host: "10.0.0.9", user: "ubuntu", keyPath: "~/.ssh/id_ed25519" }],
    }),
  });
  const tool = makeSshExecTool(dir);
  const result = await tool.execute({ host: "evil.example.com", command: "rm -rf /" });

  assert.equal(result.ok, false);
  assert.match(result.error!, /Unknown host alias "evil\.example\.com"/);
  assert.match(result.error!, /ovh/);
});

test("requires both host and command", async () => {
  const dir = await tempProject();
  const tool = makeSshExecTool(dir);
  const result = await tool.execute({ host: "", command: "" });
  assert.equal(result.ok, false);
  assert.match(result.error!, /required/);
});

test("loadSshHosts drops malformed entries and keeps valid ones", async () => {
  const dir = await tempProject({
    ".orvyn/ssh.json": JSON.stringify({
      hosts: [
        { alias: "ovh", host: "10.0.0.9", user: "ubuntu" },
        { alias: "", host: "10.0.0.10", user: "root" }, // no alias
        { host: "10.0.0.11", user: "root" }, // no alias at all
      ],
    }),
  });
  const hosts = await loadSshHosts(dir);
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].alias, "ovh");
});

test("the tool defaults to ask permission — never silent remote execution", () => {
  // Guard against a future edit flipping the default permission: every SSH
  // call must require explicit user approval.
  const tool = makeSshExecTool(process.cwd());
  assert.equal(tool.name, "ssh_exec");
  assert.equal(tool.defaultPermission, "ask");
});
