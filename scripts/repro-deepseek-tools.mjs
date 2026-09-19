// scripts/repro-deepseek-tools.mjs
// Reproduce the mission worker's 2-round tool-call flow against DeepSeek to
// find why round 2 errors ("Worker model error" in the mission transcript).
const KEY = process.env.DEEPSEEK_API_KEY || "sk-431208cd8644462d840897b5ba87845c";
const URL = "https://api.deepseek.com/v1/chat/completions";

const tools = [
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List files in a directory",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
];

async function call(messages) {
  const res = await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: "deepseek-flash", messages, tools, temperature: 0.2, top_p: 1, max_tokens: 8192, stream: false }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return JSON.parse(text);
}

const messages = [
  { role: "system", content: "You are a coding agent. Use tools to inspect the project, then create files as asked." },
  { role: "user", content: "YOUR TASK: read hello.txt and report its content. Project root: /tmp/x" },
];

const r1 = await call(messages);
const m1 = r1.choices[0].message;
console.log("round 1 finish:", r1.choices[0].finish_reason, "| tool_calls:", m1.tool_calls?.length ?? 0, "| content:", JSON.stringify(m1.content)?.slice(0, 80), "| reasoning:", (m1.reasoning_content ?? "").slice(0, 60));

if (!m1.tool_calls?.length) { console.log("no tool call round 1 — model answered directly"); process.exit(0); }

// Mirror MultiAgentRuntime EXACTLY: only the FIRST tool call is kept and answered.
const call1 = m1.tool_calls[0];
messages.push({ role: "assistant", content: m1.content || null, tool_calls: [{ id: call1.id, type: "function", function: { name: call1.function.name, arguments: call1.function.arguments } }] });
messages.push({ role: "tool", tool_call_id: call1.id, content: "version=2\nedited by agent" });

try {
  const r2 = await call(messages);
  const m2 = r2.choices[0].message;
  console.log("round 2 finish:", r2.choices[0].finish_reason, "| tool_calls:", m2.tool_calls?.length ?? 0, "| content:", JSON.stringify(m2.content)?.slice(0, 200));
} catch (err) {
  console.error("ROUND 2 FAILED:", err.message.slice(0, 500));
}

// Variant: model made MULTIPLE tool calls round 1 but we only answer the first.
if (m1.tool_calls.length > 1) console.log(`NOTE: model made ${m1.tool_calls.length} tool calls in round 1; runtime only answers the first.`);
