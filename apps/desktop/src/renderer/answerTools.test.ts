import { test } from "node:test";
import assert from "node:assert/strict";
import { shareMarkdown, speakableText } from "./answerTools.ts";

test("read aloud skips code and markdown symbols", () => {
  const t = speakableText("## Names\n**KXM** is best.\n\n```\nkxm-1-mini\n```\n- [Docs](https://x.y) are `here`.");
  assert.equal(t, "Names KXM is best. (code block) Docs are here.");
});

test("share: question, answer and sources as markdown", () => {
  const md = shareMarkdown({ question: "Name ideas?", answer: "Go with **KXM**.", sources: [{ url: "https://nodejs.org/x", domain: "nodejs.org", title: "Node", kind: "read" }] });
  assert.match(md, /^\*\*Question:\*\* Name ideas\?/);
  assert.match(md, /Go with \*\*KXM\*\*\./);
  assert.match(md, /- \[Node\]\(https:\/\/nodejs\.org\/x\)/);
});
