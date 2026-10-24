import { test } from "node:test";
import assert from "node:assert/strict";
import { ABOUT_USER, learnFromUserMessage, mightTeachAboutUser, userMemoryPrompt, type MemoryRow, type MemoryStoreLike } from "./userMemory";

function fakeStore(): MemoryStoreLike & { rows: MemoryRow[] } {
  const rows: MemoryRow[] = [];
  return {
    rows,
    listMemories: () => [...rows],
    saveMemory: (m) => { const i = rows.findIndex((r) => r.id === m.id); if (i >= 0) rows[i] = { ...rows[i], ...m }; else rows.push({ ...m }); },
    deleteMemory: (id) => { const i = rows.findIndex((r) => r.id === id); if (i >= 0) rows.splice(i, 1); },
  };
}
const model = (reply: string) => ({ calls: 0, async generate() { this.calls++; return { content: reply }; } });

test("ORION learns durable facts the user states, and uses them in every prompt", async () => {
  const store = fakeStore();
  const m = model('{"add":["Runs Kernel AI, an AI research and model company.","Chose KXM (Kernel Execution Model) as the model family name."],"update":[],"remove":[]}');
  const r = await learnFromUserMessage(store, m, "We're Kernel AI and we decided to call our model family KXM — Kernel Execution Model.");
  assert.equal(r.added.length, 2);
  assert.ok(store.rows.every((x) => x.kind === ABOUT_USER && x.scope === "global" && x.source === "learned"));
  const prompt = userMemoryPrompt(store, "What API ids should the models use?");
  assert.match(prompt, /What you know about the user/);
  assert.match(prompt, /Chose KXM/);
  // The same fact again is not duplicated; an update replaces it in place.
  const id = store.rows[1]!.id;
  await learnFromUserMessage(store, model(`{"add":["Runs Kernel AI, an AI research and model company."],"update":[{"id":"${id}","content":"Chose KXM-1 as the first model generation name."}],"remove":[]}`), "Actually we're going with KXM-1 as the first generation name for our models.");
  assert.equal(store.rows.length, 2);
  assert.equal(store.rows[1]!.content, "Chose KXM-1 as the first model generation name.");
});

test("no model call for small talk; secrets are never stored; forgetting removes", async () => {
  const store = fakeStore();
  const m = model('{"add":["x"],"update":[],"remove":[]}');
  assert.equal(mightTeachAboutUser("What is 2+2?"), false);
  await learnFromUserMessage(store, m, "What is 2+2?");
  assert.equal(m.calls, 0);
  await learnFromUserMessage(store, m, "Remember that my API key is sk-abcdef1234567890 for our server");
  assert.equal(store.rows.length, 0, "a message with a secret is not learned from");
  store.saveMemory({ id: "mem_1", scope: "global", kind: ABOUT_USER, title: "t", content: "Uses Azure for VirPhone." });
  await learnFromUserMessage(store, model('{"add":[],"update":[],"remove":["mem_1"]}'), "Please forget that we use Azure for our servers, we moved off it.");
  assert.equal(store.rows.length, 0);
});

test("remember that … is saved as said even without a model", async () => {
  const store = fakeStore();
  await learnFromUserMessage(store, undefined, "Remember that our brand color is #6C5CFF");
  assert.equal(store.rows[0]?.content, "our brand color is #6C5CFF.");
  assert.equal(store.rows[0]?.source, "user");
});

test("asynchronous memory waits for privacy settings and write acknowledgement", async () => {
  const { userMemoryPromptAsync } = await import("./userMemory");
  const sync = fakeStore();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let acknowledged = false;
  const store = {
    getSetting: async () => JSON.stringify({ memory: true }),
    listMemories: async () => sync.listMemories(),
    saveMemory: async (input: Parameters<MemoryStoreLike["saveMemory"]>[0]) => { await gate; sync.saveMemory(input); },
    deleteMemory: async (id: string) => sync.deleteMemory(id),
  };
  const learning = learnFromUserMessage(store, undefined, "Remember that our brand color is violet").then((result) => { acknowledged = true; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(acknowledged, false);
  release();
  assert.equal((await learning).added.length, 1);
  assert.match(await userMemoryPromptAsync(store, "brand color"), /violet/);
  const disabled = { ...store, getSetting: async () => JSON.stringify({ memory: false }), listMemories: async () => { throw new Error("must not read disabled memory"); } };
  assert.equal(await userMemoryPromptAsync(disabled, "brand"), "");
  assert.deepEqual(await learnFromUserMessage(disabled, undefined, "Remember that our color is blue"), { added: [], updated: [], removed: [] });
});

test("unavailable asynchronous privacy settings prevent learning and model calls", async () => {
  const sync = fakeStore();
  const m = model('{"add":["Uses violet"],"update":[],"remove":[]}');
  const store = { ...sync, getSetting: async (): Promise<string | null> => { throw new Error("storage unavailable"); } };
  assert.deepEqual(await learnFromUserMessage(store, m, "Remember that our brand color is violet"), { added: [], updated: [], removed: [] });
  assert.equal(m.calls, 0);
  assert.equal(sync.rows.length, 0);
});
