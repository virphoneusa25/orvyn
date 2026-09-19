// apps/desktop/src/renderer/monaco-setup.ts
//
// THE "Loading..." BUG FIX.
//
// @monaco-editor/react defaults to fetching Monaco from a CDN (jsdelivr) at
// runtime. In a packaged Electron app that request is blocked by the CSP (and
// fails outright if the machine is offline), so <Editor> renders its
// "Loading..." fallback forever.
//
// This module points the loader at the copy of monaco-editor already in
// node_modules, and wires up the web workers through Vite's ?worker imports so
// syntax highlighting / IntelliSense actually run. Import this ONCE, before
// any <Editor> is rendered (e.g. at the top of main.tsx).

import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import "monaco-editor/esm/vs/basic-languages/monaco.contribution";

import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case "json":
        return new jsonWorker();
      case "css":
      case "scss":
      case "less":
        return new cssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new htmlWorker();
      case "typescript":
      case "javascript":
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

// Use the bundled monaco rather than the CDN.
loader.config({ monaco });

// A theme tuned to the Orvyn palette, so the editor doesn't look like stock
// VS Code sitting inside a custom shell.
monaco.editor.defineTheme("orvyn-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "5A6478", fontStyle: "italic" },
    { token: "comment.php", foreground: "5A6478", fontStyle: "italic" },
    { token: "comment.js", foreground: "5A6478", fontStyle: "italic" },
    { token: "comment.ts", foreground: "5A6478", fontStyle: "italic" },
    { token: "keyword", foreground: "C792EA" },
    { token: "keyword.php", foreground: "C792EA" },
    { token: "keyword.js", foreground: "C792EA" },
    { token: "keyword.ts", foreground: "C792EA" },
    { token: "keyword.flow", foreground: "C792EA" },
    { token: "metatag", foreground: "5B6CFF" },
    { token: "metatag.php", foreground: "5B6CFF" },
    { token: "tag", foreground: "F07178" },
    { token: "tag.php", foreground: "F07178" },
    { token: "tag.html", foreground: "F07178" },
    { token: "tag.xml", foreground: "F07178" },
    { token: "string", foreground: "7FD1B9" },
    { token: "string.php", foreground: "7FD1B9" },
    { token: "string.html", foreground: "7FD1B9" },
    { token: "string.js", foreground: "7FD1B9" },
    { token: "string.ts", foreground: "7FD1B9" },
    { token: "number", foreground: "E8B93F" },
    { token: "number.php", foreground: "E8B93F" },
    { token: "type", foreground: "8BB9FF" },
    { token: "type.php", foreground: "8BB9FF" },
    { token: "type.js", foreground: "8BB9FF" },
    { token: "identifier", foreground: "D8DEE9" },
    { token: "variable", foreground: "EECB8B" },
    { token: "variable.php", foreground: "EECB8B" },
    { token: "function", foreground: "82AAFF" },
    { token: "delimiter", foreground: "8B93A7" },
    { token: "delimiter.php", foreground: "8B93A7" },
    { token: "attribute.name", foreground: "A9B4FF" },
    { token: "attribute.name.html", foreground: "A9B4FF" },
    { token: "attribute.value", foreground: "7FD1B9" },
    { token: "attribute.value.html", foreground: "7FD1B9" },
  ],
  colors: {
    "editor.background": "#0B0E14",
    "editor.foreground": "#D8DEE9",
    "editorLineNumber.foreground": "#3A4459",
    "editor.selectionBackground": "#26355F",
    "editor.lineHighlightBackground": "#11151F",
    "editorCursor.foreground": "#5B6CFF",
    "editorIndentGuide.background1": "#1C2330",
    "editor.inactiveSelectionBackground": "#1E2536",
  },
});

export { monaco };
