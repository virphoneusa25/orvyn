import type { editor, languages, IDisposable, CancellationToken } from "monaco-editor";
import { monaco } from "./monaco-setup";
import { apiUrl, authHeaders } from "./connection";

let registered: IDisposable | null = null;
let inflight: AbortController | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function requestComplete(body: {
  prefix: string;
  suffix: string;
  language?: string;
  filePath?: string;
}): Promise<string> {
  inflight?.abort();
  inflight = new AbortController();
  return fetch(apiUrl("/complete"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
    signal: inflight.signal,
  })
    .then((res) => (res.ok ? res.json() : { completion: "" }))
    .then((data) => String(data.completion ?? ""))
    .catch(() => "");
}

export function registerTabAutocomplete(): IDisposable {
  registered?.dispose();
  registered = monaco.languages.registerInlineCompletionsProvider("*", {
    provideInlineCompletions: (model: editor.ITextModel, position, _context, token: CancellationToken) =>
      new Promise<languages.InlineCompletions>((resolve) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () => {
          if (token.isCancellationRequested) {
            resolve({ items: [] });
            return;
          }
          const prefix = model.getValueInRange({
            startLineNumber: Math.max(1, position.lineNumber - 40),
            startColumn: 1,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          });
          if (prefix.trim().length < 8) {
            resolve({ items: [] });
            return;
          }
          const suffix = model.getValueInRange({
            startLineNumber: position.lineNumber,
            startColumn: position.column,
            endLineNumber: Math.min(model.getLineCount(), position.lineNumber + 20),
            endColumn: model.getLineMaxColumn(Math.min(model.getLineCount(), position.lineNumber + 20)),
          });
          const completion = await requestComplete({
            prefix,
            suffix,
            language: model.getLanguageId(),
            filePath: model.uri.path.replace(/^\//, ""),
          });
          if (!completion || token.isCancellationRequested) {
            resolve({ items: [] });
            return;
          }
          resolve({
            items: [
              {
                insertText: completion,
                range: {
                  startLineNumber: position.lineNumber,
                  startColumn: position.column,
                  endLineNumber: position.lineNumber,
                  endColumn: position.column,
                },
              },
            ],
          });
        }, 350);
      }),
    freeInlineCompletions: () => undefined,
  });
  return registered;
}
