import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LONG = "x".repeat(4000);
const URL = "https://orvyn.virphoneusa.com/api/v1/sites/" + "a".repeat(1800);
const PATH = "/mnt/orvyn/workspaces/" + "segment/".repeat(200) + "virphone-hero.svg";
const JSON_BLOB = JSON.stringify({ command: LONG, url: URL });
const STACK = `Error: boom\n    at ${PATH}:1:1\n    at ${URL}`;

function page(): string {
  return `<!doctype html><meta charset="utf-8"><style>
    html, body { margin: 0; height: 100%; }
    .chat-shell, .chat-stream, .chat-stream__column, .chat-composer, .tool-line, .tool-line__row, .message-content {
      min-width: 0; max-width: 100%;
    }
    .chat-shell { width: 100%; height: 100%; display: flex; flex-direction: column; overflow: hidden; }
    .chat-stream { flex: 1; overflow-y: auto; overflow-x: hidden; }
    .chat-stream__column { width: 100%; }
    .tool-line__row { display: flex; align-items: center; gap: 8px; overflow: hidden; }
    .tool-line__verb, .tool-line__by { flex: none; white-space: nowrap; }
    .tool-line__target { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tool-line__live, .message-content, .stack { white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; max-width: 100%; }
    .chat-composer { width: 100%; display: flex; }
    .chat-composer input { flex: 1; min-width: 0; }
  </style>
  <div class="chat-shell" id="chat">
    <div class="chat-stream" id="stream">
      <div class="chat-stream__column">
        <div class="tool-line"><div class="tool-line__row"><span class="tool-line__verb">Used shell</span><span class="tool-line__by">VERIFIER</span><code class="tool-line__target">${LONG}</code></div></div>
        <div class="message-content">${URL}</div>
        <div class="message-content">${PATH}</div>
        <pre class="tool-line__live">${JSON_BLOB}</pre>
        <pre class="stack">${STACK}</pre>
      </div>
    </div>
    <div class="chat-composer"><input value="can you make the hero background animated"><button>Send</button></div>
  </div>
  <script>
    const chat = document.getElementById("chat");
    const stream = document.getElementById("stream");
    document.title = [
      document.documentElement.scrollWidth,
      document.documentElement.clientWidth,
      chat.scrollWidth,
      chat.clientWidth,
      stream.scrollWidth,
      stream.clientWidth
    ].join(",");
  </script>`;
}

const WIDTHS = [1920, 1600, 1440, 1366, 1280, 1024];

test("long tool commands do not widen the conversation", { skip: !existsSync("/opt/google/chrome/chrome") }, () => {
  const dir = mkdtempSync(join(tmpdir(), "orvyn-overflow-"));
  const chrome = "/opt/google/chrome/chrome";
  for (const width of WIDTHS) {
    const file = join(dir, `chat-${width}.html`);
    writeFileSync(file, page());
    const run = spawnSync(chrome, [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      `--user-data-dir=${join(dir, `profile-${width}`)}`,
      `--window-size=${width},720`,
      "--virtual-time-budget=2000",
      `file://${file}`,
      "--dump-dom",
    ], { encoding: "utf8", timeout: 20_000 });
    assert.equal(run.status, 0, run.stderr);
    const title = /<title>([^<]+)<\/title>/.exec(run.stdout)?.[1] ?? "";
    const [docScroll, docClient, chatScroll, chatClient, streamScroll, streamClient] = title.split(",").map(Number);
    assert.ok(docScroll <= docClient, `${width} document ${title}`);
    assert.ok(chatScroll <= chatClient, `${width} chat ${title}`);
    assert.ok(streamScroll <= streamClient, `${width} stream ${title}`);
  }
});
