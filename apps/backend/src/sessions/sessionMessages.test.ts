import assert from "node:assert/strict";
import test from "node:test";
import { ChatTurnRecorder, persistRunAnswer, runAnswerMessageId } from "./sessionMessages";
import type { WorkSessionPersistence } from "./WorkSessionStore";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("chat waits for admission and drains ordered reply writes before completion", async () => {
  const admission = deferred();
  const completion = deferred();
  const writes: unknown[] = [];
  let appends = 0;
  const store = {
    async appendMessage(_session: string, message: any) {
      if (++appends === 1) await admission.promise;
      writes.push(message);
      return { ...message, messageId: message.role === "assistant" ? "reply" : "user" };
    },
    async updateMessage(id: string, patch: any) {
      if (patch.status === "complete") await completion.promise;
      writes.push({ id, ...patch });
    },
  } as unknown as WorkSessionPersistence;
  const recorder = new ChatTurnRecorder(store, "chat", { userMessage: "hello" });
  let admitted = false;
  void recorder.ready.then(() => { admitted = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(admitted, false);
  assert.equal(appends, 1);
  admission.resolve();
  await recorder.ready;
  recorder.delta("discarded");
  recorder.retract();
  recorder.delta("saved");
  recorder.artifacts([{ artifactId: "file" }]);
  let finished = false;
  const finish = recorder.finish().then(() => { finished = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  completion.resolve();
  await finish;
  assert.deepEqual(writes.slice(2), [
    { id: "reply", content: "discarded" },
    { id: "reply", content: "" },
    { id: "reply", meta: { artifacts: [{ artifactId: "file" }] } },
    { id: "reply", content: "saved", status: "complete" },
  ]);
  recorder.delta("late");
  recorder.routing({ provider: "unused", modelId: "unused", reason: "late" });
  await recorder.finish();
  assert.equal(writes.length, 6);
});

test("failed admission rejects before a reply or inference can begin", async () => {
  let writes = 0;
  const failure = new Error("storage unavailable");
  const store = {
    async appendMessage() { writes++; throw failure; },
    async updateMessage() { writes++; },
  } as unknown as WorkSessionPersistence;
  const recorder = new ChatTurnRecorder(store, "chat", { userMessage: "hello" });
  await assert.rejects(recorder.ready, (error) => error === failure);
  await assert.rejects(recorder.finish(), (error) => error === failure);
  assert.equal(writes, 1);
});

test("failed intermediate writes remain visible at final acknowledgment", async () => {
  let writes = 0;
  const failure = new Error("connection lost");
  const store = {
    async appendMessage() { return { messageId: "reply" }; },
    async updateMessage() { writes++; throw failure; },
  } as unknown as WorkSessionPersistence;
  const recorder = new ChatTurnRecorder(store, "chat", { userMessage: "hello" });
  await recorder.ready;
  recorder.delta("answer");
  await assert.rejects(recorder.finish(), (error) => error === failure);
  assert.equal(writes, 1);
});


test("terminal answer repair propagates failure and replays the stable message with artifact metadata",async()=>{
 let available=false;const messages=new Map<string,any>();
 const sessions={async appendMessage(_session:string,message:any){if(!available)throw new Error("session unavailable");messages.set(message.messageId,message);return message;},async updateMessage(id:string,patch:any){Object.assign(messages.get(id),patch);}} as unknown as WorkSessionPersistence;
 const run={id:"replay-run",status:"completed",events:[{type:"message.grounded",data:{content:"Recovered answer"}},{type:"artifact.created",data:{artifactId:"artifact",name:"result.txt",mimeType:"text/plain"}}]};
 const store={get:()=>run} as unknown as import("../agent/events").RunStore;
 await assert.rejects(persistRunAnswer(sessions,store,"session",run.id),/session unavailable/);
 available=true;await persistRunAnswer(sessions,store,"session",run.id);await persistRunAnswer(sessions,store,"session",run.id);
 assert.equal(messages.size,1);const message=messages.get(runAnswerMessageId(run.id));assert.equal(message.content,"Recovered answer");assert.equal(message.meta.artifacts[0].artifactId,"artifact");
 run.status="blocked";messages.clear();await persistRunAnswer(sessions,store,"session",run.id);assert.equal(messages.size,0);
});
