// apps/desktop/src/renderer/useInlineEdit.ts
//
// Glue between Monaco and <InlineEdit>. Captures the current selection on
// Ctrl+K and writes an accepted edit back through Monaco's edit stack, so
// Ctrl+Z undoes it like any normal edit.
import { useEffect, useRef, useState } from "react";
import type { editor } from "monaco-editor";

export interface InlineEditState {
  selection: string;
  language?: string;
}

export function useInlineEdit(filePath?: string) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const [state, setState] = useState<InlineEditState | null>(null);

  function attach(instance: editor.IStandaloneCodeEditor) {
    editorRef.current = instance;
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isCtrlK = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k";
      if (!isCtrlK) return;
      e.preventDefault();

      const ed = editorRef.current;
      if (!ed) return;
      const model = ed.getModel();
      const sel = ed.getSelection();
      if (!model || !sel) return;

      // With no selection, fall back to the current line — matches how Cursor
      // behaves and avoids a dead keypress.
      const range = sel.isEmpty()
        ? { startLineNumber: sel.startLineNumber, startColumn: 1, endLineNumber: sel.startLineNumber, endColumn: model.getLineMaxColumn(sel.startLineNumber) }
        : sel;

      const text = model.getValueInRange(range);
      if (!text.trim()) return;

      setState({ selection: text, language: model.getLanguageId() });
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [filePath]);

  function accept(newText: string) {
    const ed = editorRef.current;
    const model = ed?.getModel();
    const sel = ed?.getSelection();
    if (!ed || !model || !sel) return;

    const range = sel.isEmpty()
      ? {
          startLineNumber: sel.startLineNumber,
          startColumn: 1,
          endLineNumber: sel.startLineNumber,
          endColumn: model.getLineMaxColumn(sel.startLineNumber),
        }
      : sel;

    // executeEdits (not setValue) so this joins the undo stack.
    ed.executeEdits("orvyn-inline-edit", [{ range, text: newText, forceMoveMarkers: true }]);
    ed.focus();
  }

  return { attach, state, close: () => setState(null), accept };
}
