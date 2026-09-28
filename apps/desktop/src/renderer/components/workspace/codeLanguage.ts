// Pure filename → Monaco language id (no JSX so tests run under
// --experimental-strip-types). FileEditorView re-exports it.

export function guessLanguage(path: string): string {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    md: "markdown",
    css: "css",
    html: "html",
    py: "python",
    rs: "rust",
    go: "go",
    yml: "yaml",
    yaml: "yaml",
    htm: "html",
    php: "php",
    sh: "shell",
    bash: "shell",
    ps1: "powershell",
    xml: "xml",
    svg: "xml",
    sql: "sql",
    scss: "scss",
    sass: "sass",
    less: "less",
    java: "java",
    cs: "csharp",
    c: "c",
    cpp: "cpp",
    h: "cpp",
    rb: "ruby",
    ini: "ini",
    env: "ini",
    toml: "ini",
    mjs: "javascript",
    cjs: "javascript",
    dockerfile: "dockerfile",
    mdx: "markdown",
  };
  return map[ext] ?? "plaintext";
}
