import { test } from "node:test";
import assert from "node:assert/strict";
import { extractLeakedToolMarkup, stripLeakedToolMarkup, visibleAssistantDelta } from "./leakedToolMarkup";

const xml = `<tool_call> fetch_url
<arg_key>url</arg_key>
<arg_value>https://www.fortunebusinessinsights.com/voice-over-internet-protocol-voip-market-102756</arg_value>
</tool_call>`;

test("leaked XML tool calls are recovered and removed from assistant text", () => {
  const { text, calls } = extractLeakedToolMarkup(`Search hiccuped — retrying.\n${xml}\n`);
  assert.equal(text.trim(), "Search hiccuped — retrying.");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "fetch_url");
  assert.equal(calls[0]?.arguments.url, "https://www.fortunebusinessinsights.com/voice-over-internet-protocol-voip-market-102756");
});

test("an in-progress XML dump is held back until it completes or the turn ends", () => {
  const first = visibleAssistantDelta("", "I'll open it.\n<tool_call> fetch_url\n<arg_key>");
  assert.equal(first.visible, "I'll open it.\n");
  assert.equal(first.delta, "I'll open it.\n");
  const second = visibleAssistantDelta(first.visible, `I'll open it.\n${xml}Done.`);
  assert.equal(second.visible, "I'll open it.\nDone.");
  assert.equal(second.delta, "Done.");
  assert.equal(stripLeakedToolMarkup(`I'll open it.\n${xml.slice(0, 20)}`), "I'll open it.\n");
});
