import test from "node:test";
import assert from "node:assert/strict";
import { VERCEL_MCP_SERVER_SOURCE } from "./VercelMcpRuntime";

test("Vercel MCP generated source uses real newline framing for stdio JSON-RPC", () => {
  assert.match(
    VERCEL_MCP_SERVER_SOURCE,
    /indexOf\("\\n"\)/
  );
  assert.match(
    VERCEL_MCP_SERVER_SOURCE,
    /JSON\.stringify\(\{ jsonrpc: "2\.0", id, method, params \}\) \+ "\\n"/
  );
  assert.doesNotMatch(
    VERCEL_MCP_SERVER_SOURCE,
    /indexOf\("\\\\n"\)/
  );
  assert.doesNotMatch(
    VERCEL_MCP_SERVER_SOURCE,
    /\+ "\\\\n"/
  );
});

test("Vercel MCP generated source uses a real CRLF-aware SSE split regex", () => {
  assert.match(VERCEL_MCP_SERVER_SOURCE, /split\(\/\\r\?\\n\/\)/);
  assert.doesNotMatch(VERCEL_MCP_SERVER_SOURCE, /split\(\/\\\\r\?\\\\n\/\)/);
});
