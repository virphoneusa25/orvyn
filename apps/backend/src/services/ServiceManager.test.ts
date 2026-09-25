import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeService, isServiceCommand, portAnswers, runService, ServiceManager } from "./ServiceManager";
import { makeTerminalTool } from "../ai/tools/terminalTool";

test("dev servers are services and one-shot commands are not", () => {
  for (const cmd of [
    "npm run dev",
    "pnpm dev",
    "yarn start",
    "bun run dev",
    "npm run dev:client",
    "npx vite",
    "vite --port 3000 --host",
    "npx next dev",
    "npm install && npm run dev",
    "cd app && npm run dev &",
    "PORT=3000 node server.js",
    "nohup npm run dev > dev.log 2>&1 &",
    "python3 -m http.server 8080",
    "uvicorn main:app --reload",
    "php -S localhost:8000",
  ]) assert.equal(isServiceCommand(cmd), true, cmd);
  for (const cmd of [
    "npm test",
    "npm run build",
    "npm install -D vite",
    "npm i --save-dev vite",
    "vite build",
    "npx vite build",
    "npm create vite@latest my-app -- --template react",
    "node script.js",
    "npm run dev && echo done-not-last",
    "git status",
  ]) assert.equal(isServiceCommand(cmd), false, cmd);
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** A tiny dev server that prints its URL like Vite does (with color codes). */
function fakeDevServer(port: number): string {
  const dir = mkdtempSync(join(tmpdir(), "orvyn-svc-"));
  writeFileSync(
    join(dir, "server.js"),
    `require("http").createServer((q,s)=>s.end("hello from dev")).listen(${port},"127.0.0.1",()=>console.log("  \\x1b[32mVITE\\x1b[39m ready\\n  ➜  Local:   \\x1b[36mhttp://localhost:\\x1b[1m${port}\\x1b[22m/\\x1b[39m"));`
  );
  return dir;
}

function get(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: "/" }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
}

test("a service listens, survives the end of its run, and stops only when asked", async () => {
  const manager = new ServiceManager("t_");
  const port = await freePort();
  const dir = fakeDevServer(port);
  const outcome = await manager.startAndWait({ command: "node server.js", cwd: dir, runId: "run-1", readyTimeoutMs: 15_000 });
  assert.equal(outcome.ready, true);
  assert.equal(outcome.record.status, "running");
  assert.equal(outcome.record.port, port);
  assert.equal(outcome.record.url, `http://localhost:${port}/`);
  assert.match(describeService(outcome).output, new RegExp(`URL: http://localhost:${port}/`));

  // The run ends: nothing is torn down.
  assert.equal(manager.releaseRun("run-1").length, 1);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await get(port), "hello from dev");
  await manager.checkHealth();
  assert.equal(manager.get(outcome.record.serviceId)?.status, "running");

  // Asking for the same command again reuses it.
  const again = await manager.startAndWait({ command: "node server.js", cwd: dir, runId: "run-2" });
  assert.equal(again.reused, true);
  assert.equal(again.record.serviceId, outcome.record.serviceId);

  manager.stop(outcome.record.serviceId, "stopped by the user");
  assert.equal(manager.get(outcome.record.serviceId)?.status, "stopped");
  for (let i = 0; i < 30 && (await portAnswers(port)); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(await portAnswers(port), false);
});

test("a service that crashes is reported as failed with its output", async () => {
  const manager = new ServiceManager("t_");
  const dir = mkdtempSync(join(tmpdir(), "orvyn-svc-"));
  writeFileSync(join(dir, "server.js"), `console.error("Error: Cannot find module 'vite'"); process.exit(1);`);
  const { outcome, result } = await runService({ command: "node server.js", cwd: dir, readyTimeoutMs: 10_000 }, manager);
  assert.equal(outcome.record.status, "failed");
  assert.equal(result.ok, false);
  assert.match(String((result as { error?: string }).error), /Cannot find module 'vite'/);
});

test("the terminal tool hands a dev server to the service manager and returns", async () => {
  const port = await freePort();
  const dir = fakeDevServer(port);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "node server.js" } }));
  const started = Date.now();
  const result = await makeTerminalTool(dir).execute({ command: "npm run dev" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(String(result.output), new RegExp(`http://localhost:${port}/`));
  assert.ok(Date.now() - started < 30_000);
  assert.equal(await get(port), "hello from dev");
  const { serviceManager } = await import("./ServiceManager");
  const svc = serviceManager.list({ projectRoot: dir })[0]!;
  serviceManager.stop(svc.serviceId);
});
