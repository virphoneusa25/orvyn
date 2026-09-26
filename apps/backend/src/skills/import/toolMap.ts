/** External names that correspond to a tool registered on ToolGateway. Unlisted names stay unresolved. */
const EXTERNAL_TOOL_MAP: Record<string, string> = {
  read: "read_file",
  read_file: "read_file",
  write: "write_file",
  write_file: "write_file",
  edit: "edit_file",
  multiedit: "edit_file",
  edit_file: "edit_file",
  bash: "terminal",
  shell: "terminal",
  terminal: "terminal",
  grep: "search_code",
  search_code: "search_code",
  glob: "find_file",
  find_file: "find_file",
  ls: "list_directory",
  list_directory: "list_directory",
  websearch: "web_search",
  web_search: "web_search",
  webfetch: "fetch_url",
  fetch_url: "fetch_url",
  browser: "browser_open",
  browser_open: "browser_open",
  browser_navigate: "browser_navigate",
  browser_click: "browser_click",
  browser_screenshot: "browser_screenshot",
  screenshot: "browser_screenshot",
  ssh: "ssh_exec",
  ssh_exec: "ssh_exec",
  run_tests: "run_tests",
  run_typecheck: "run_typecheck",
  create_document: "create_document",
};

export function canonicalToolKey(name: string): string {
  return name.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/** Returns the ORVYN tool name, or null when no registered equivalent exists. */
export function mapExternalTool(name: string, known: Set<string>): string | null {
  const key = canonicalToolKey(name);
  const compact = key.replace(/_/g, "");
  const mapped = EXTERNAL_TOOL_MAP[key] ?? EXTERNAL_TOOL_MAP[compact] ?? null;
  if (!mapped || !known.has(mapped)) return null;
  return mapped;
}
