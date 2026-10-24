import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { LocalStore } from "../persistence/LocalStore";
import { listValidatedSkills, matchValidatedSkills, seedValidatedSkills, skillsPromptFor } from "./validatedSkills";

test("seeded skills are validated and match a logo request", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orvyn-vskill-"));
  const store = new LocalStore("tenant-a", dir);
  const seeded = (await seedValidatedSkills(store));
  assert.ok(seeded.some((s) => s.id === "skill_deliver_file" && s.validated));
  assert.equal((await listValidatedSkills(store)).filter((s) => s.validated).length >= 3, true);
  const matched = (await matchValidatedSkills("Generate a virphone logo in png format", store));
  assert.ok(matched.some((s) => s.id === "skill_deliver_file"));
  const prompt = (await skillsPromptFor("Generate a virphone logo in png format", store));
  assert.match(prompt, /Files → Generated/);
  assert.match(prompt, /validated/);
  store.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("code and visual skills match their jobs",  async () => {
  assert.ok((await matchValidatedSkills("Fix the failing tests")).some((s) => s.id === "skill_code_with_tests"));
  assert.ok((await matchValidatedSkills("The dashboard layout overflows")).some((s) => s.id === "skill_visual_verify"));
  assert.equal((await skillsPromptFor("What time is it?")), "");
});
