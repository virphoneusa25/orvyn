import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { ago } from "../lib/format";
import { navigate, useLocation } from "../lib/router";
import { useStore } from "../lib/store";
import { useApi, type Artifact, type Project, type SessionRow } from "../lib/useApi";
import { uploadFiles } from "../lib/upload";
import { FolderGlyph, Icon } from "../components/Icons";
import { Modal } from "../components/Bits";
import { ChatThread } from "../components/ChatThread";
import { FileRow } from "../components/FileRow";

export function Projects() {
  const { toast } = useStore();
  const { query } = useLocation();
  const { data, loading, reload } = useApi<{ projects: Project[] }>("/projects");
  const sessions = useApi<{ sessions: SessionRow[] }>("/sessions");
  const [creating, setCreating] = useState(query.get("new") === "1");
  const [name, setName] = useState("");
  const list = data?.projects ?? [];
  const chatsIn = (id: string) => (sessions.data?.sessions ?? []).filter((s) => s.projectId === id);

  return (
    <>
      <div className="spread">
        <div><h1 className="page-title">Projects</h1><p className="page-sub">Group chats and files. Projects are shared with ORVYN Desktop.</p></div>
        <button className="btn btn--primary" onClick={() => setCreating(true)} data-testid="new-project"><Icon.plus size={18} /> New project</button>
      </div>
      {loading && !data ? <div className="empty">Loading…</div> : null}
      {!loading && !list.length ? (
        <div className="card empty"><FolderGlyph hue={0} /><h3>No projects yet</h3>Create a project to keep related chats and files together.</div>
      ) : null}
      <div className="three" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
        {list.map((p, i) => {
          const chats = chatsIn(p.id);
          const last = chats.reduce((m, s) => Math.max(m, s.updatedAt), p.createdAt);
          return (
            <button key={p.id} className="card card--pad qa__btn" style={{ minHeight: 96 }} onClick={() => navigate(`/projects/${p.id}`)} data-testid="project-card">
              <FolderGlyph hue={i} />
              <span style={{ minWidth: 0 }}><b>{p.name}</b><span>{chats.length} chat{chats.length === 1 ? "" : "s"} · updated {ago(last)}</span></span>
              <span className="qa__chev"><Icon.chev size={16} /></span>
            </button>
          );
        })}
      </div>
      {creating ? (
        <Modal title="New project" onClose={() => { setCreating(false); navigate("/projects", { replace: true }); }}>
          <form onSubmit={async (e) => {
            e.preventDefault();
            try {
              const r = await api<{ project: Project }>("/projects", { method: "POST", body: { name: name.trim() || "Untitled project" } });
              setCreating(false); setName(""); reload();
              navigate(`/projects/${r.project.id}`);
            } catch (err: any) { toast(err.message); }
          }}>
            <div className="field"><label htmlFor="pname">Project name</label><input id="pname" className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Marketing site" /></div>
            <div className="modal__actions">
              <button type="button" className="btn" onClick={() => setCreating(false)}>Cancel</button>
              <button type="submit" className="btn btn--primary" data-testid="create-project">Create</button>
            </div>
          </form>
        </Modal>
      ) : null}
    </>
  );
}

export function ProjectDetail({ id, chat }: { id: string; chat?: string }) {
  const { toast } = useStore();
  const project = useApi<{ project: Project }>(`/projects/${encodeURIComponent(id)}`);
  const sessions = useApi<{ sessions: SessionRow[] }>(`/sessions?projectId=${encodeURIComponent(id)}`);
  const files = useApi<{ artifacts: Artifact[] }>(`/artifacts?projectId=${encodeURIComponent(id)}`);
  const upload = useRef<HTMLInputElement | null>(null);
  const [chatId, setChatId] = useState<string | null>(chat ?? null);
  useEffect(() => { setChatId(chat ?? null); }, [chat]);

  if (project.error) return <div className="card empty" data-testid="project-missing"><h3>Project not found</h3>It may have been removed, or it belongs to another account.<div style={{ marginTop: 14 }}><button className="btn" onClick={() => navigate("/projects")}>All projects</button></div></div>;
  const p = project.data?.project;
  const chats = [...(sessions.data?.sessions ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
  const projectFiles = [...(files.data?.artifacts ?? [])].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <>
      <div className="spread">
        <div className="row">
          <button className="btn btn--ghost btn--sm" onClick={() => navigate("/projects")} aria-label="All projects"><Icon.chev size={16} /></button>
          <FolderGlyph hue={1} />
          <h1 className="page-title" data-testid="project-name">{p?.name ?? "…"}</h1>
        </div>
        <div className="row">
          <button className="btn" onClick={() => upload.current?.click()}><Icon.upload size={18} /> Upload files</button>
          <button className="btn btn--primary" onClick={() => { setChatId(null); navigate(`/projects/${id}`); }}><Icon.plus size={18} /> New chat</button>
        </div>
      </div>
      <input ref={upload} type="file" multiple hidden onChange={async (e) => {
        const list = Array.from(e.target.files ?? []); e.target.value = "";
        if (!list.length) return;
        const r = await uploadFiles(list, { projectId: id });
        toast(r.skipped.length ? `Uploaded ${r.ok}. Skipped: ${r.skipped.join(", ")}` : `Uploaded ${r.ok} file${r.ok === 1 ? "" : "s"}.`);
        files.reload();
      }} />
      <div className="chats" style={{ height: "calc(100vh - 170px)", marginTop: 14 }}>
        <div className="grid" style={{ alignContent: "start", minHeight: 0, overflow: "auto" }}>
          <section className="card card--pad">
            <div className="card__head"><h3>Chats</h3></div>
            <div className="list">
              {chats.map((s) => (
                <button key={s.sessionId} className={`chats__item${s.sessionId === chatId ? " is-on" : ""}`} onClick={() => navigate(`/projects/${id}/chats/${s.sessionId}`)}>
                  <Icon.chat size={18} /><span style={{ minWidth: 0 }}><b>{s.title}</b><span>{ago(s.updatedAt)}</span></span>
                </button>
              ))}
              {!chats.length ? <div className="list__empty">No chats in this project yet.</div> : null}
            </div>
          </section>
          <section className="card card--pad">
            <div className="card__head"><h3>Files</h3></div>
            <div className="list">
              {projectFiles.map((a) => <FileRow key={a.artifactId} a={a} />)}
              {!projectFiles.length ? <div className="list__empty">No files in this project yet.</div> : null}
            </div>
          </section>
        </div>
        <section className="card chat-pane">
          <div className="chat-pane__head"><h2>{chats.find((s) => s.sessionId === chatId)?.title ?? "New chat in this project"}</h2></div>
          <ChatThread sessionId={chatId} projectId={id} placeholder={`Ask about ${p?.name ?? "this project"}…`}
            onSession={(sid) => { setChatId(sid); navigate(`/projects/${id}/chats/${sid}`, { replace: true }); window.setTimeout(() => { sessions.reload(); files.reload(); }, 400); }} />
        </section>
      </div>
    </>
  );
}
