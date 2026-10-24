import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end('<!doctype html><title>ORVYN browser acceptance</title><h1>Rendered website fixture</h1><input id="query"><button id="action" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#query\').value">Apply</button><p id="result">Ready</p>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = "http://127.0.0.1:" + server.address().port;
const helper = spawn("docker", ["run", "--rm", "-i", "--network=host", process.env.ORVYN_TEST_SANDBOX_IMAGE || "orvyn-browser-acceptance", "node", "/usr/local/lib/orvyn/browser-server.mjs"], {stdio:["pipe","pipe","pipe"]});
let stderr = "", sequence = 0;
const pending = new Map();
helper.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-12000); });
createInterface({input:helper.stdout}).on("line", line => {
  let reply; try { reply = JSON.parse(line); } catch { return; }
  const request = pending.get(reply.id);
  if (request) { clearTimeout(request.timer); pending.delete(reply.id); request.resolve(reply); }
});
helper.on("error", error => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); } pending.clear(); });
helper.on("exit", code => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("Browser helper exited " + code + ": " + stderr)); } pending.clear(); });
function request(op, args = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Browser helper timed out: " + op + "\n" + stderr)); }, 45000);
    pending.set(id, {resolve,reject,timer});
    helper.stdin.write(JSON.stringify({id,op,args}) + "\n");
  });
}
try {
  const opened = await request("open", {url});
  assert.equal(opened.ok,true,opened.error);
  assert.match(opened.output,/ORVYN browser acceptance/);
  assert.equal(opened.meta.url,url + "/");
  const typed = await request("type",{selector:"#query",text:"Actual sandbox input"});
  assert.equal(typed.ok,true,typed.error);
  const clicked = await request("click",{selector:"#action"});
  assert.equal(clicked.ok,true,clicked.error);
  const image = await request("screenshot");
  assert.equal(image.ok,true,image.error);
  assert.equal(image.meta.screenshot.mediaType,"image/png");
  assert.equal(Buffer.from(image.meta.screenshot.b64,"base64").subarray(1,4).toString(),"PNG");
  assert.equal(image.meta.browserScreenshot.width,1280);
  assert.equal(image.meta.browserScreenshot.height,800);
  assert.match(image.meta.browserScreenshot.sha256,/^[a-f0-9]{64}$/);
  const mobile = await request("viewport",{preset:"mobile"});
  assert.equal(mobile.ok,true,mobile.error);
  const narrow = await request("screenshot");
  assert.equal(narrow.meta.browserScreenshot.width,390);
  assert.equal(narrow.meta.browserScreenshot.height,844);
  const evidence = await request("evidence");
  assert.equal(evidence.ok,true,evidence.error);
  assert.ok(evidence.meta.actions.some(action => action.action === "click"));
  assert.ok(evidence.meta.actions.some(action => action.action === "screenshot"));
  const errors = await request("errors");
  assert.equal(errors.ok,true,errors.error);
  assert.deepEqual(errors.meta.consoleErrors,[]);
  const refused = await request("input",{type:"click",x:-1,y:50});
  assert.equal(refused.ok,false,"out-of-bounds input must not succeed");
  assert.match(refused.error,/outside viewport/);
  const failed = await request("navigate",{url:"http://127.0.0.1:1"});
  assert.equal(failed.ok,false,"failed navigation must not claim success");
  console.log("Actual sandbox Chromium acceptance passed: navigation, screenshot, mobile viewport, selector input, evidence and error contracts.");
} finally {
  helper.stdin.end();
  helper.kill("SIGTERM");
  await new Promise(resolve => server.close(resolve));
}
