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

// Real layout check in a real headless Chrome. On a machine where Chrome
// cannot be driven (a CI runner with a different Chrome build, no display
// libraries), the measurement is skipped with the reason instead of failing:
// that is an environment gap, not a layout regression. Set
// ORVYN_REQUIRE_CHROME_TESTS=1 to make an unusable Chrome a hard failure.
test("long tool commands do not widen the conversation", { skip: !existsSync("/opt/google/chrome/chrome") }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "orvyn-overflow-"));
  const chrome = "/opt/google/chrome/chrome";
  const strict = process.env.ORVYN_REQUIRE_CHROME_TESTS === "1";
  for (const width of WIDTHS) {
    const file = join(dir, `chat-${width}.html`);
    writeFileSync(file, page());
    let title = "";
    let why = "";
    for (const headless of ["--headless=new", "--headless"]) {
      const run = spawnSync(chrome, [
        headless,
        "--disable-gpu",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        `--user-data-dir=${join(dir, `profile-${width}${headless.length}`)}`,
        `--window-size=${width},720`,
        "--virtual-time-budget=2000",
        "--dump-dom",
        `file://${file}`,
      ], { encoding: "utf8", timeout: 60_000 });
      title = /<title>(\d+(?:,\d+){5})<\/title>/.exec(run.stdout ?? "")?.[1] ?? "";
      if (title) break;
      why = `chrome ${headless} exited ${run.status ?? run.signal ?? run.error?.message}: ${String(run.stderr ?? "").trim().split("\n").slice(-3).join(" | ").slice(0, 300)}`;
    }
    if (!title) {
      if (strict) assert.fail(`${width}: could not measure the page (${why})`);
      t.skip(`headless Chrome unusable here: ${why}`);
      return;
    }
    const [docScroll, docClient, chatScroll, chatClient, streamScroll, streamClient] = title.split(",").map(Number);
    assert.ok(docScroll <= docClient, `${width} document ${title}`);
    assert.ok(chatScroll <= chatClient, `${width} chat ${title}`);
    assert.ok(streamScroll <= streamClient, `${width} stream ${title}`);
  }
});
