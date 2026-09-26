import { test } from "node:test";
import assert from "node:assert/strict";
import { collectSources, sourceDomains } from "./runSources.ts";

const done = (tool: string, evidence: unknown[], extra: Record<string, unknown> = {}) => ({ type: "tool.completed", data: { tool, ...extra, envelope: { evidence } } });

test("sources: pages read first, then search results; no verifier checks, previews or localhost", () => {
  const sources = collectSources([
    done("web_search", [
      { type: "url", value: "https://www.nvidia.com/blog/x", label: "NVIDIA blog", extra: { kind: "search", title: "NVIDIA blog", snippet: "GPUs", query: "kxm" } },
      { type: "url", value: "https://huggingface.co/docs", label: "HF docs", extra: { kind: "search", title: "HF docs" } },
    ]),
    done("fetch_url", [{ type: "url", value: "https://huggingface.co/docs/", label: "Hugging Face", extra: { kind: "read", title: "Hugging Face" } }]),
    done("browser_open", [{ type: "browser", value: "bs_1", extra: { url: "https://vercel.com/" } }]),
    done("browser_open", [{ type: "browser", value: "bs_2", extra: { url: "https://orvyn.example/api/v1/sites/abc/" } }]),
    done("browser_open", [{ type: "browser", value: "bs_3", extra: { url: "http://localhost:5173/" } }]),
    done("browser_open", [{ type: "browser", value: "bs_4", extra: { url: "https://example.org/" } }], { verifier: true }),
  ]);
  assert.deepEqual(sources.map((s) => [s.domain, s.kind, s.title]), [
    ["huggingface.co", "read", "Hugging Face"],
    ["vercel.com", "read", "vercel.com"],
    ["nvidia.com", "search", "NVIDIA blog"],
  ]);
  assert.deepEqual(sourceDomains(sources, 2), ["huggingface.co", "vercel.com"]);
});
