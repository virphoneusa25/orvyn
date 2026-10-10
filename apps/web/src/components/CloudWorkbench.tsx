import { useEffect, useRef, useState } from "react";
import { api, getToken } from "../lib/api";
import { readSseStream } from "../lib/sse";
import type { AgentProgressEvent } from "../lib/agentProgress";
import { fileEditsFromEvents } from "../lib/streamBlocks";
import { consumeDesktopFrames, latestWorkspaceTab, remoteInputAllowed, terminalTranscript, type WorkspaceConnection, type WorkspaceTab } from "../lib/cloudWorkbenchModel";
import { Icon } from "./Icons";
import { Orb } from "./Orb";
import { FileEditList } from "./StreamCards";
import "./cloudWorkbench.css";

const TABS = [
  ["Browser", Icon.globe], ["Desktop", Icon.monitor], ["Code", Icon.code],
  ["Files", Icon.folder], ["Changes", Icon.pen], ["Terminal", Icon.terminal],
] as const;

export function CloudWorkbench({ runId, runStatus, events = [], active = true, expanded = false, readOnly = false, onClose, onExpand }: {
  runId?: string;
  runStatus?: string;
  events?: AgentProgressEvent[];
  active?: boolean;
  expanded?: boolean;
  readOnly?: boolean;
  onClose?: () => void;
  onExpand?: () => void;
}) {
  const [tab, setTab] = useState<WorkspaceTab>("Browser");
  const [follow, setFollow] = useState(true);
  const [picture, setPicture] = useState("");
  const [pictureReady, setPictureReady] = useState(false);
  const [streamVersion, setStreamVersion] = useState(0);
  const lastPicture = useRef("");
  const receivedFrames = useRef<Record<string, string>>({});
  const [connection, setConnection] = useState<WorkspaceConnection>("idle");
  const [owner, setOwner] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [operationError, setOperationError] = useState("");
  const [pending, setPending] = useState(false);
  const [file, setFile] = useState("");
  const [code, setCode] = useState("");
  const [openedFile, setOpenedFile] = useState(false);
  const [entries, setEntries] = useState<string[]>([]);
  const [directory, setDirectory] = useState("");
  const [fileBusy, setFileBusy] = useState(false);
  const [fileError, setFileError] = useState("");
  const [retry, setRetry] = useState(0);
  const streamAbort = useRef<AbortController | null>(null);
  const fileAbort = useRef<AbortController | null>(null);
  const fileSequence = useRef(0);
  const binding = useRef({ runId, tab, active });
  binding.current = { runId, tab, active };
  const terminal = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  const edits = fileEditsFromEvents(events);
  const completedEdits = edits.filter(edit => !edit.pending);
  const pendingEdits = edits.filter(edit => edit.pending);
  const transcript = terminalTranscript(events);
  const ended = !!runStatus && ["completed", "cancelled", "error", "partial", "blocked"].includes(runStatus);
  const liveView = tab === "Browser" || tab === "Desktop";
  const browserStarted = events.some((event) => event.type === "tool.started" && String(event.data?.tool ?? "").startsWith("browser_"));
  const desktopStarted = events.some((event) => event.type.startsWith("desktop.") || (event.type === "tool.started" && /^(desktop_|computer_)/.test(String(event.data?.tool ?? ""))));
  const savedBrowserFrame = [...events].reverse().find(event => event.type === "browser.frame")?.data?.artifactId;
  const inputEnabled = remoteInputAllowed(connection, owner, pictureReady, !readOnly && !ended);
  const canControl = connection === "live" && pictureReady && !!owner && !readOnly && !ended;

  useEffect(() => {
    setTab("Browser"); setFollow(true); setFile(""); setCode(""); setOpenedFile(false); setEntries([]); setDirectory("");
    setFileError(""); setOperationError(""); setPending(false);
  }, [runId]);
  useEffect(() => {
    if (follow) { const next = latestWorkspaceTab(events); if (next) setTab(next); }
  }, [events, follow, runId]);
  useEffect(() => {
    fileAbort.current?.abort(); fileSequence.current++; setFileBusy(false);
    return () => { fileAbort.current?.abort(); fileSequence.current++; };
  }, [runId, tab, active]);
  useEffect(() => {
    if (terminal.current && stick.current) terminal.current.scrollTop = terminal.current.scrollHeight;
  }, [transcript, tab]);

  useEffect(() => {
    if (ended && runId && liveView) {
      setPicture(receivedFrames.current[`${runId}:${tab}`] ?? ""); setOwner(null); setError(""); setConnection("ended");
      return;
    }
    lastPicture.current = ""; setPicture(""); setPictureReady(false); setError(""); setOwner(null);
    if (!active || !runId || !liveView || ended || (tab === "Browser" ? !browserStarted : !desktopStarted)) {
      setConnection("idle"); return;
    }
    const controller = new AbortController();
    streamAbort.current = controller;
    setConnection("connecting"); setStreamVersion((value) => value + 1);
    const headers: Record<string, string> = {};
    const token = getToken(); if (token) headers.Authorization = `Bearer ${token}`;
    const acceptPicture = (url: string) => {
      if (controller.signal.aborted || lastPicture.current === url) return;
      lastPicture.current = url; receivedFrames.current[`${runId}:${tab}`] = url; setPictureReady(false); setPicture(url);
      setConnection("live"); setError("");
    };
    void (async () => {
      if (tab === "Browser") {
        const response = await fetch(`/api/v1/cloud-workbench/${encodeURIComponent(runId)}/browser/stream`, { headers, signal: controller.signal });
        if (!response.ok || !response.body) {
          const detail = await response.json().catch(() => ({}));
          throw new Error(detail.error || "The browser preview isn't available for this task.");
        }
        await readSseStream(response.body, (raw) => {
          if (controller.signal.aborted) return;
          const data = raw as { screenshot?: { b64: string; mediaType: string }; control?: { owner: string }; error?: string; ok?: boolean };
          if (data.ok === false || data.error) {
            setConnection("error"); setError(data.error || "The browser preview disconnected.");
          } else if (data.screenshot?.b64) {
            acceptPicture(`data:${data.screenshot.mediaType || "image/png"};base64,${data.screenshot.b64}`);
          }
          if (data.control) setOwner(data.control.owner);
        });
      } else {
        const state = await api(`/desktop/session?runId=${encodeURIComponent(runId)}`, { signal: controller.signal });
        if (!state.session?.live) throw new Error("This task has no active cloud desktop.");
        if (controller.signal.aborted) return;
        setOwner(state.session.controlOwner);
        const response = await fetch(`/api/v1/desktop/stream?runId=${encodeURIComponent(runId)}`, { headers, signal: controller.signal });
        if (!response.ok || !response.body) throw new Error("The desktop preview isn't available for this task.");
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let buffer = "";
        try {
          while (!controller.signal.aborted) {
            const next = await reader.read();
            buffer += decoder.decode(next.value ?? new Uint8Array(), { stream: !next.done });
            const parsed = consumeDesktopFrames(next.done ? buffer + "\n\n" : buffer);
            buffer = parsed.rest;
            for (const frame of parsed.frames) {
              if (controller.signal.aborted) break;
              if (frame.event === "frame") acceptPicture(`data:image/jpeg;base64,${frame.data}`);
              if (frame.event === "state") setOwner(JSON.parse(frame.data).controlOwner);
              if (frame.event === "end") { setConnection("ended"); return; }
            }
            if (next.done) break;
          }
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      }
      if (!controller.signal.aborted) setConnection("ended");
    })().catch((failure) => {
      if (!controller.signal.aborted) { setConnection("error"); setError(failure.message); }
    });
    return () => { controller.abort(); if (streamAbort.current === controller) streamAbort.current = null; };
  }, [active, runId, tab, liveView, ended, browserStarted, desktopStarted, retry]);

  // Completed and reopened runs replay the actual saved screenshot.
  useEffect(() => {
    if (!active || !runId || tab !== "Browser" || !ended || !savedBrowserFrame || receivedFrames.current[`${runId}:Browser`]) return;
    const controller = new AbortController();
    void api<{ screenshot: { b64: string; mediaType: string } }>(`/cloud-workbench/${encodeURIComponent(runId)}/browser/frame`, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted || !result.screenshot?.b64) return;
      const url = `data:${result.screenshot.mediaType};base64,${result.screenshot.b64}`;
      receivedFrames.current[`${runId}:Browser`] = url; setPictureReady(false); setPicture(url); setConnection("ended");
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [active, runId, tab, ended, savedBrowserFrame]);

  async function control(next: "user" | "orion") {
    if (!runId || !canControl || pending) return;
    const requested = { ...binding.current };
    setPending(true); setOperationError("");
    try {
      const result = await api(tab === "Browser" ? `/cloud-workbench/${encodeURIComponent(runId)}/browser/control` : "/desktop/control", { method: "POST", body: { runId, owner: next } });
      if (binding.current.runId === requested.runId && binding.current.tab === requested.tab) setOwner(result.owner ?? result.session?.controlOwner ?? next);
    } catch (failure: any) { if (binding.current.runId === requested.runId) setOperationError(failure.message); }
    finally { if (binding.current.runId === requested.runId) setPending(false); }
  }
  async function input(body: Record<string, unknown>) {
    if (!runId || !inputEnabled || pending) return;
    const requested = { ...binding.current };
    try {
      const result = await api(tab === "Browser" ? `/cloud-workbench/${encodeURIComponent(runId)}/browser/input` : "/desktop/input", { method: "POST", body: { runId, ...body } });
      if (result.ok === false) throw new Error(result.error || "The input could not be sent.");
    } catch (failure: any) {
      if (binding.current.runId === requested.runId && binding.current.tab === requested.tab) setOperationError(failure.message);
    }
  }
  async function stop() {
    if (!runId || readOnly || ended || pending) return;
    const requestedRun = runId; setPending(true); setOperationError("");
    try {
      await api(`/cloud-workbench/${encodeURIComponent(runId)}/stop`, { method: "POST", body: {} });
      if (binding.current.runId === requestedRun) { streamAbort.current?.abort(); setConnection("ended"); setOwner(null); }
    } catch (failure: any) { if (binding.current.runId === requestedRun) setOperationError(failure.message); }
    finally { if (binding.current.runId === requestedRun) setPending(false); }
  }
  async function read(path?: string, list = false) {
    if (!runId || !active) return;
    fileAbort.current?.abort();
    const controller = new AbortController(); fileAbort.current = controller;
    const sequence = ++fileSequence.current;
    setFileBusy(true); setFileError("");
    try {
      const result = await api(`/cloud-workbench/${encodeURIComponent(runId)}/files${path === undefined ? "" : `?path=${encodeURIComponent(path)}${list ? "&list=1" : ""}`}`, { signal: controller.signal });
      if (controller.signal.aborted || fileSequence.current !== sequence) return;
      if (result.ok === false) throw new Error(result.error || "Couldn't read this file.");
      if (list || path === undefined) {
        setDirectory(path ?? "");
        setEntries(String(result.output ?? "").split(/\r?\n/).filter(Boolean));
      } else { setFile(path); setCode(String(result.output ?? "")); setOpenedFile(true); setTab("Code"); setFollow(false); }
    } catch (failure: any) { if (!controller.signal.aborted && fileSequence.current === sequence) setFileError(failure.message); }
    finally { if (!controller.signal.aborted && fileSequence.current === sequence) setFileBusy(false); }
  }
  function select(next: WorkspaceTab) {
    setTab(next); setFollow(false); setOperationError("");
  }
  useEffect(() => { if (active && runId && tab === "Files") void read(); }, [active, runId, tab]);

  const previewStatus = ended ? "Task finished" : connection === "live" && pictureReady ? (owner === "user" ? "You have control" : owner === "orion" ? "ORVYN has control" : "Live preview") : connection === "connecting" ? "Connecting" : connection === "error" ? "Preview unavailable" : connection === "ended" ? "Session ended" : ended ? "Task finished" : "Not started";
  const lastUrl = [...events].reverse().find((event) => event.data?.url)?.data?.url;

  return (
    <aside id="cloud-workbench" className="cloud-workbench" aria-label="Cloud workspace" hidden={!active}>
      <header className="cloud-workbench__header">
        <Orb className="cloud-workbench__orb" /><div><strong>Workspace</strong><span>Cloud sandbox</span></div>
        <div className="cloud-workbench__header-actions">
          <button className="iconbtn cloud-workbench__expand" onClick={onExpand} aria-label={expanded ? "Restore split view" : "Expand workspace"} title={expanded ? "Restore split view" : "Expand workspace"}><Icon.layers size={17} /></button>
          <button className="iconbtn" onClick={onClose} aria-label="Close workspace" title="Close workspace"><Icon.x size={18} /></button>
        </div>
      </header>
      <div className="cloud-workbench__tabs" role="tablist" aria-label="Workspace views">
        {TABS.map(([name, Glyph]) => <button key={name} id={`workspace-tab-${name}`} role="tab" aria-selected={tab === name} aria-controls="workspace-content" tabIndex={tab === name ? 0 : -1} onClick={() => select(name)} onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault(); const index = TABS.findIndex(([value]) => value === name);
          const next = event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length;
          select(TABS[next]![0]); document.getElementById(`workspace-tab-${TABS[next]![0]}`)?.focus();
        }}><Glyph size={15} /><span>{name}</span>{name === "Changes" && completedEdits.length > 0 ? <small>{completedEdits.length}</small> : null}</button>)}
      </div>
      <div className="cloud-workbench__context">
        <span className={`cloud-workbench__status ${connection === "live" && pictureReady && liveView ? "is-live" : ""}`}><i />{!runId ? "No task selected" : liveView ? previewStatus : ended ? "Task finished" : "Task workspace"}</span>
        <button className="cloud-workbench__follow" aria-pressed={follow} onClick={() => setFollow(!follow)} title="Switch tabs as ORVYN works"><Icon.eye size={14} /> Follow agent</button>
      </div>
      <section id="workspace-content" role="tabpanel" aria-labelledby={`workspace-tab-${tab}`} tabIndex={0} className="cloud-workbench__content">
        {!runId ? <div className="cloud-workbench__empty"><Icon.layers size={32} /><h3>Your task workspace</h3><p>Ask ORVYN to browse, code, or use its cloud desktop. Watch the work here while the conversation stays in chat.</p></div> : <>
          {liveView ? <>
            <div className="cloud-workbench__preview-bar"><Icon.lock size={14} /><span title={typeof lastUrl === "string" ? lastUrl : undefined}>{tab === "Browser" && typeof lastUrl === "string" ? lastUrl : "Isolated cloud computer"}</span><button className="btn btn--sm" disabled={!canControl || pending} onClick={() => void control(owner === "user" ? "orion" : "user")}>{owner === "user" ? "Return to ORVYN" : "Take control"}</button></div>
            {picture ? <div className="cloud-workbench__preview"><img key={streamVersion} className="cloud-workbench__screen" src={picture} alt={`Cloud ${tab.toLowerCase()} preview`} tabIndex={inputEnabled ? 0 : -1} onLoad={() => setPictureReady(true)} onError={() => { if (runId) delete receivedFrames.current[`${runId}:${tab}`]; setPictureReady(false); setPicture(""); setConnection("error"); setError("The preview frame couldn't be displayed. Reconnect to try again."); }} onClick={(event) => {
              if (!inputEnabled) return; event.currentTarget.focus();
              const rect = event.currentTarget.getBoundingClientRect();
              void input({ type: "click", x: Math.round((event.clientX - rect.left) * event.currentTarget.naturalWidth / rect.width), y: Math.round((event.clientY - rect.top) * event.currentTarget.naturalHeight / rect.height), viewWidth: event.currentTarget.naturalWidth, viewHeight: event.currentTarget.naturalHeight });
            }} onKeyDown={(event) => { if (!inputEnabled) return; event.preventDefault(); void input(event.key.length === 1 ? { type: "type", text: event.key } : { type: "key", key: event.key }); }} onWheel={(event) => void input({ type: "scroll", deltaY: Math.max(-2000, Math.min(2000, event.deltaY)) })} /></div> : <div className="cloud-workbench__empty"><Icon.monitor size={32} /><h3>{connection === "connecting" ? "Opening live preview…" : connection === "error" ? "Preview unavailable" : ended ? "This task has finished" : `No ${tab.toLowerCase()} session yet`}</h3><p>{error || (ended ? "Files, changes, and command output remain available in the other tabs." : `Ask ORVYN in chat to use its cloud ${tab.toLowerCase()}. The preview opens when the session starts.`)}</p></div>}
            {picture && (connection === "ended" || connection === "error") ? <p className="cloud-workbench__notice" role="status">{error || (ended ? "Task finished. This is the last received frame." : "Session ended. This is the last received frame.")}</p> : null}
            {(connection === "error" || connection === "ended") && !ended ? <button className="btn btn--sm cloud-workbench__reconnect" onClick={() => setRetry((value) => value + 1)}><Icon.retry size={14} /> Reconnect preview</button> : null}
          </> : null}
          {tab === "Code" ? <>
            <form className="cloud-workbench__file-bar" onSubmit={(event) => { event.preventDefault(); if (file.trim()) void read(file.trim()); }}><Icon.file size={15} /><input aria-label="Project file path" value={file} onChange={(event) => setFile(event.target.value)} placeholder="src/app.ts" /><button className="btn btn--sm" disabled={fileBusy || !file.trim()}>Open</button></form>
            {openedFile ? <pre className="cloud-workbench__code">{code || "// This file is empty."}</pre> : <div className="cloud-workbench__empty"><Icon.code size={32} /><h3>Inspect a project file</h3><p>Choose a file in Files or enter its path above.</p><button className="btn btn--sm" onClick={() => select("Files")}>Browse files</button></div>}
          </> : null}
          {tab === "Files" ? <>
            <div className="cloud-workbench__file-bar"><Icon.folder size={15} /><span>{directory || "Project files"}</span>{directory ? <button className="btn btn--sm" disabled={fileBusy} onClick={() => void read()}>Project root</button> : null}<button className="iconbtn" aria-label="Refresh files" disabled={fileBusy} onClick={() => void read(directory || undefined, true)}><Icon.retry size={15} /></button></div>
            <div className="cloud-workbench__file-list">{entries.length ? entries.map((entry) => <button key={entry} disabled={fileBusy} onClick={() => { const path = directory ? `${directory.replace(/\/$/, "")}/${entry}` : entry; void read(path, entry.endsWith("/")); }}>{entry.endsWith("/") ? <Icon.folder size={16} /> : <Icon.file size={16} />}<span>{entry}</span><Icon.chev size={14} /></button>) : <div className="cloud-workbench__empty"><Icon.folder size={32} /><h3>{fileBusy ? "Loading project files…" : "No project files to show"}</h3><p>Files created by this task appear here.</p></div>}</div>
          </> : null}
          {tab === "Changes" ? edits.length ? <div className="cloud-workbench__changes"><p>{completedEdits.length} {completedEdits.length === 1 ? "file" : "files"} changed in this task{pendingEdits.length ? ` · Editing ${pendingEdits.length} ${pendingEdits.length === 1 ? "file" : "files"}` : ""}</p><FileEditList edits={edits} /><div className="cloud-workbench__changed-files">{completedEdits.filter((edit) => edit.status !== "deleted").map((edit) => <button className="btn btn--sm" key={edit.path} onClick={() => void read(edit.openPath ?? edit.path)}><Icon.code size={14} /> Open {edit.openPath ?? edit.path}</button>)}</div></div> : <div className="cloud-workbench__empty"><Icon.pen size={32} /><h3>No changes yet</h3><p>File edits and diffs appear here as ORVYN works.</p></div> : null}
          {tab === "Terminal" ? transcript ? <pre ref={terminal} className="cloud-workbench__terminal" onScroll={(event) => { const node = event.currentTarget; stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48; }}>{transcript}</pre> : <div className="cloud-workbench__empty"><Icon.terminal size={32} /><h3>No command output yet</h3><p>Commands and their output appear here when ORVYN runs them.</p></div> : null}
          {fileBusy && tab !== "Files" ? <p className="cloud-workbench__notice" role="status">Loading file…</p> : null}
          {fileError ? <p className="cloud-workbench__notice" role="alert">{fileError}</p> : null}
          {operationError ? <p className="cloud-workbench__notice" role="alert">{operationError}</p> : null}
        </>}
      </section>
      <footer className="cloud-workbench__footer"><span><Icon.lock size={12} /> Isolated cloud workspace</span>{runId && !ended && !readOnly ? <button className="cloud-workbench__stop" disabled={pending} onClick={() => void stop()}><Icon.stop size={12} /> Stop task</button> : null}</footer>
    </aside>
  );
}
