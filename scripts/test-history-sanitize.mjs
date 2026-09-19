// scripts/test-history-sanitize.mjs
// Regression test for the context_length_exceeded bug: a chat history
// containing a generated image's base64 data URL (megabytes) must not be
// forwarded to the model. Before the fix this request failed with
// "maximum context length is 128000 tokens ... resulted in ~1M tokens".
import WebSocket from "ws";

const fakeBase64 = "iVBORw0KGgoAAAANSUhEUg" + "A".repeat(2_000_000); // ~2 MB, ≈500k tokens
const history = [
  { role: "user", content: "make me a logo" },
  { role: "assistant", content: `Here's a generated mockup:\n\n![logo](data:image/png;base64,${fakeBase64})\n\nSaved as \`.orvyn/generated/img-test.png\`` },
];

const ws = new WebSocket("ws://localhost:4570/ws/chat");
let out = "";
const timeout = setTimeout(() => {
  console.error("FAIL: timed out waiting for reply");
  process.exit(1);
}, 60_000);

ws.on("open", () => {
  ws.send(JSON.stringify({
    task: "chat",
    history,
    userMessage: "Reply with exactly: SANITIZED-OK",
    context: { mode: "ask" },
  }));
});
ws.on("message", (raw) => {
  const chunk = JSON.parse(raw.toString());
  if (chunk.delta) out += chunk.delta;
  if (chunk.done) {
    clearTimeout(timeout);
    ws.close();
    if (/context.?length|maximum context|reduce the length/i.test(out)) {
      console.error(`FAIL: model still received the oversized history:\n${out.slice(0, 400)}`);
      process.exit(1);
    }
    if (chunk.error) {
      console.error(`FAIL: ${chunk.error}`);
      process.exit(1);
    }
    console.log(`PASS — model answered normally with 2 MB of base64 in history.\nReply: ${out.slice(0, 200)}`);
  }
});
ws.on("error", (e) => {
  clearTimeout(timeout);
  console.error(`FAIL: ws error ${e.message}`);
  process.exit(1);
});
