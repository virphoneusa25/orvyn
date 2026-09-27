// A Vite-shaped project uses one dev server. Editing a source file shows up
// on that same URL, and finishing the run does not stop the service.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ServiceManager } from "../services/ServiceManager";
import { detectSiteStack } from "./websiteLayout";

const SERVER = `import { createServer } from "http";
import { readFileSync } from "fs";
import { join } from "path";
const root = process.cwd();
const server = createServer((req, res) => {
  const path = (req.url || "/").split("?")[0];
  const rel = path === "/" ? "index.html" : path.replace(/^\\//, "");
  try {
    const body = readFileSync(join(root, rel));
    const type = rel.endsWith(".css") ? "text/css; charset=utf-8" : "text/html; charset=utf-8";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("missing");
  }
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  console.log("vite Local: http://127.0.0.1:" + port + "/");
});
`;

test("a Vite fixture keeps one dev server and shows source edits", async () => {
  const root = mkdtempSync(join(tmpdir(), "orvyn-vite-app-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { dev: "node server.mjs" }, devDependencies: { vite: "5.4.0" } }));
  writeFileSync(join(root, "server.mjs"), SERVER);
  writeFileSync(join(root, "index.html"), "<h1>Shell</h1>");
  writeFileSync(join(root, "styles.css"), "h1{color:white}");
  assert.equal(detectSiteStack(root), "vite");

  const manager = new ServiceManager("fw_");
  const first = await manager.startAndWait({ command: "node server.mjs", cwd: root, projectRoot: root, runId: "run-vite", readyTimeoutMs: 8_000 });
  try {
    assert.equal(first.ready, true);
    assert.ok(first.record.url);
    const before = await fetch(first.record.url!);
    assert.match(await before.text(), /Shell/);
    const css = await fetch(new URL("styles.css", first.record.url));
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);

    writeFileSync(join(root, "index.html"), "<h1>Routes</h1><link rel=\"stylesheet\" href=\"styles.css\">");
    writeFileSync(join(root, "styles.css"), "h1{color:navy}");
    const after = await fetch(first.record.url!);
    assert.match(await after.text(), /Routes/);
    assert.match(await (await fetch(new URL("styles.css", first.record.url))).text(), /navy/);

    const released = manager.releaseRun("run-vite");
    assert.equal(released.length, 1);
    assert.equal(released[0]?.status, "running");
    const again = await manager.startAndWait({ command: "node server.mjs", cwd: root, projectRoot: root, runId: "run-vite", readyTimeoutMs: 4_000 });
    assert.equal(again.reused, true);
    assert.equal(again.record.url, first.record.url);
    assert.equal(manager.list({ projectRoot: root, active: true }).length, 1);
  } finally {
    if (first.record.serviceId) manager.stop(first.record.serviceId, "test");
  }
});
