import { test } from "node:test";
import assert from "node:assert/strict";
import { stripLeakedToolMarkup } from "./leakedToolMarkup.ts";

test("raw XML tool calls never remain in the chat bubble", () => {
  const leaked = `Search hiccuped — retrying with different queries.\n<tool_call> fetch_url\n<arg_key>url</arg_key>\n<arg_value>https://example.com</arg_value>\n</tool_call>`;
  assert.equal(stripLeakedToolMarkup(leaked).trim(), "Search hiccuped — retrying with different queries.");
  assert.equal(stripLeakedToolMarkup("Hello\n<tool_call> fetch_url"), "Hello\n");
});
