import assert from "node:assert/strict";
import test from "node:test";
import { consumeDesktopFrames, latestWorkspaceTab, remoteInputAllowed, terminalTranscript } from "./cloudWorkbenchModel.ts";

test("desktop base64 frames survive fragmented chunks, CRLF and heartbeats", () => {
 const first = consumeDesktopFrames(": heartbeat\r\n\r\nevent: frame\r\ndata: aGVs");
 assert.equal(first.frames.length, 0);
 const next = consumeDesktopFrames(first.rest + "bG8=\r\n\r\nevent: state\r\ndata: {\"controlOwner\":\"user\"}\r\n\r\n");
 assert.deepEqual(next.frames, [{event:"frame", data:"aGVsbG8="}, {event:"state", data:'{"controlOwner":"user"}'}]);
 assert.equal(next.rest, "");
});
test("desktop stream end and multiline data are distinct from a live frame", () => {
 assert.deepEqual(consumeDesktopFrames('event: end\ndata: {"reason":\ndata: "stopped"}\n\n').frames, [{event:"end",data:'{"reason":\n"stopped"}'}]);
});
test("remote input needs a live displayable session, user ownership and write access", () => {
 assert.equal(remoteInputAllowed("live", "user", true, true), true);
 for (const state of ["idle", "connecting", "ended", "error"] as const) assert.equal(remoteInputAllowed(state,"user",true,true), false);
 assert.equal(remoteInputAllowed("live",null,true,true), false);
 assert.equal(remoteInputAllowed("live","orion",true,true), false);
 assert.equal(remoteInputAllowed("live","user",false,true), false);
 assert.equal(remoteInputAllowed("live","user",true,false), false);
});
test("follow mode uses the latest real action and ignores unrelated messages", () => {
 assert.equal(latestWorkspaceTab([]), undefined);
 const events = [{type:"tool.started",data:{tool:"browser_open"}},{type:"terminal.started",data:{command:"npm test"}},{type:"message.delta",data:{content:"Checking"}}];
 assert.equal(latestWorkspaceTab(events), "Terminal");
 assert.equal(latestWorkspaceTab([...events,{type:"file.edit",data:{path:"src/app.ts"}}]), "Changes");
 assert.equal(latestWorkspaceTab([{type:"desktop.target",data:{surface:"desktop"}}]), "Desktop");
 assert.equal(latestWorkspaceTab([{type:"tool.started",data:{tool:"read_file"}}]), "Code");
});
test("terminal transcript keeps incremental output and reports actual failure", () => {
 assert.equal(terminalTranscript([{type:"terminal.started",data:{command:"npm test"}},{type:"terminal.output",data:{data:"first "}},{type:"terminal.output",data:{data:"second"}},{type:"terminal.completed",data:{exitOk:false}}]), "$ npm test\nfirst second\n[Command failed]\n");
 assert.equal(terminalTranscript([{type:"message.delta",data:{content:"ignored"}}]), "");
 assert.equal(terminalTranscript([{type:"terminal.output",data:{data:"x".repeat(110000)}}]).length,100000);
});
