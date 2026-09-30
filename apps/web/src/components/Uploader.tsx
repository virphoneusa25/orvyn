import { useCallback, useState } from "react";
import { uploadFiles, useWindowDrop } from "../lib/upload";
import { useStore } from "../lib/store";
import { signal } from "../lib/events";
import { Bar } from "./Bits";

/** Upload with visible progress, plus drag-and-drop anywhere on the page. */
export function useUploader(opts: { projectId?: string; onDone?: () => void; dropLabel?: string; drop?: boolean } = {}) {
  const { toast } = useStore();
  const [progress, setProgress] = useState<{ done: number; total: number; name: string } | null>(null);
  const start = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setProgress({ done: 0, total: files.length, name: files[0]!.name });
    const r = await uploadFiles(files, { projectId: opts.projectId, onProgress: (done, total, name) => setProgress({ done, total, name }) });
    setProgress(null);
    toast(r.skipped.length ? `Uploaded ${r.ok}. Skipped: ${r.skipped.join(", ")}` : `Uploaded ${r.ok} file${r.ok === 1 ? "" : "s"}.`);
    signal("files");
    opts.onDone?.();
  }, [opts.projectId, opts.onDone, toast]); // eslint-disable-line react-hooks/exhaustive-deps
  const over = useWindowDrop((f) => void start(f), opts.drop !== false);
  const ui = (
    <>
      {over ? <div className="drop-overlay" data-testid="drop-overlay"><div>Drop files to upload<span>{opts.dropLabel ?? "They'll be added to your Files."} Up to 7 MB each.</span></div></div> : null}
      {progress ? (
        <div className="upload-progress" role="status" data-testid="upload-progress">
          <div className="spread"><b>Uploading {Math.min(progress.done + 1, progress.total)} of {progress.total}</b></div>
          <div className="muted" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{progress.name}</div>
          <Bar used={progress.done} limit={progress.total} hidePct />
        </div>
      ) : null}
    </>
  );
  return { start, ui, busy: Boolean(progress) };
}
