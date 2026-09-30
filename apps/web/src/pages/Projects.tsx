import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { ago } from "../lib/format";
import { navigate, useLocation } from "../lib/router";
import { useStore } from "../lib/store";
import { signal, useSignal } from "../lib/events";
import { useApi, type Artifact, type Project, type SessionRow } from "../lib/useApi";
import { Icon } from "../components/Icons";
import { Empty, Modal, PageHead, hueFor } from "../components/Bits";
import { ChatThread } from "../components/ChatThread";
import { FileRow } from "../components/FileRow";
import { ActionMenu } from "../components/Menu";
import { useUploader } from "../components/Uploader";
import { useChatActions } from "./Chats";

function ProjectIcon({ name, size = 38 }: { name: string; size?: number }) {
  return <span className="project-card__icon" style={{ width: size, height: size, background: hueFor(name) }}>{name.slice(0, 1).toUpperCase()}</span>;
}

export function Projects() {
  const { query } = useLocation();
  const { data, loading, reload } = useApi<{ projects: Project[] }>("/projects");
  const sessions = useApi<{ sessions: SessionRow[] }>("/sessions");
  const files = useApi<{ artifacts: Artifact[] }>("/artifacts");
  const [creating, setCreating] = useState(query.get("new") === "1");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"recent" | "name">("recent");
  useSignal("projects", reload);
  const list = useMemo(() => {
    const lastOf = (p: Project) => (sessions.data?.sessions ?? []).filter((s) => s.projectId === p.id).reduce((m, s) => Math.max(m, s.updatedAt), p.updatedAt ?? p.createdAt);
    return (data?.projects ?? [])
      .filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()) || (p.description ?? "").toLowerCase().includes(q.toLowerCase()))
      .map((p) => ({ p, last: lastOf(p), chats: (sessions.data?.sessions ?? []).filter((s) => s.projectId === p.id).length, files: (files.data?.artifacts ?? []).filter((a) => a.projectId === p.id).length }))
      .sort((a, b) => sort === "name" ? a.p.name.localeCompare(b.p.name) : b.last - a.last);
  }, [data, sessions.data, files.data, q, sort]);

  return (
    <div className="page">
      <PageHead title="Projects" sub="Keep related chats and files together. Projects are shared with ORVYN Desktop.">
        <button className="btn btn--primary" onClick={() => setCreating(true)} data-testid="new-project"><Icon.plus size={17} /> New project</button>
      </PageHead>
      {data?.projects.length ? (
        <div className="files-bar">
          <label className="search"><Icon.search size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search projects" aria-label="Search projects" /></label>
          <div className="seg"><button className={sort === "recent" ? "is-on" : ""} onClick={() => setSort("recent")}>Recent</button><button className={sort === "name" ? "is-on" : ""} onClick={() => setSort("name")}>Name</button></div>
        </div>
      ) : null}
      {loading && !data ? <div className="projects-grid">{[0, 1, 2].map((i) => <div key={i} className="card skeleton" style={{ height: 156 }} />)}</div> : null}
      {data && !data.projects.length ? (
        <div className="card"><Empty icon={<Icon.folder size={24} />} title="No projects yet" action={<button className="btn btn--primary" onClick={() => setCreating(true)}><Icon.plus size={16} /> Create your first project</button>}>A project keeps a set of chats and files together — a launch, a client, a codebase.</Empty></div>
      ) : null}
      {list.length ? (
        <div className="projects-grid">
          {list.map(({ p, last, chats, files: nFiles }) => (
            <button key={p.id} className="card card--hover project-card" onClick={() => navigate(`/projects/${p.id}`)} data-testid="project-card">
              <div className="project-card__top">
                <ProjectIcon name={p.name} />
                <div><h3>{p.name}</h3><span className="muted" style={{ fontSize: 12 }}>Updated {ago(last)}</span></div>
              </div>
              <p>{p.description || (p.projectRoot ? "Linked to a folder in ORVYN Desktop." : "No description yet.")}</p>
              <div className="project-card__meta">
                <span><Icon.chat size={13} /> {chats} chat{chats === 1 ? "" : "s"}</span>
                <span><Icon.file size={13} /> {nFiles} file{nFiles === 1 ? "" : "s"}</span>
                {p.projectRoot ? <span><Icon.monitor size={13} /> Desktop</span> : null}
              </div>
            </button>
          ))}
          {!q ? <button className="card project-card project-new" onClick={() => setCreating(true)}><Icon.plus size={22} /><b>New project</b></button> : null}
        </div>
      ) : null}
      {creating ? <ProjectModal onClose={() => { setCreating(false); if (query.get("new")) navigate("/projects", { replace: true }); }} onSaved={(p) => { reload(); signal("projects"); navigate(`/projects/${p.id}`); }} /> : null}
    </div>
  );
}

function ProjectModal({ project, onClose, onSaved }: { project?: Project; onClose: () => void; onSaved: (p: Project) => void }) {
  const { toast } = useStore();
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={project ? "Project settings" : "New project"} onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const r = project
            ? await api<{ project: Project }>(`/projects/${project.id}`, { method: "PATCH", body: { name: name.trim() || project.name, description: description.trim() || null } })
            : await api<{ project: Project }>("/projects", { method: "POST", body: { name: name.trim() || "Untitled project" } });
          if (!project && description.trim()) await api(`/projects/${r.project.id}`, { method: "PATCH", body: { description: description.trim() } }).catch(() => undefined);
          onClose(); onSaved(r.project);
        } catch (err: any) { toast(err.message); } finally { setBusy(false); }
      }}>
        <div className="field"><label htmlFor="pname">Name</label><input id="pname" className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Marketing site" maxLength={80} /></div>
        <div className="field"><label htmlFor="pdesc">Description <span className="faint">(optional)</span></label><textarea id="pdesc" className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this project about?" maxLength={500} /></div>
        <div className="modal__actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={busy} data-testid="create-project">{project ? "Save" : "Create project"}</button>
        </div>
      </form>
    </Modal>
  );
}

export function ProjectDetail({ id, chat }: { id: string; chat?: string }) {
  const { toast } = useStore();
  const project = useApi<{ project: Project }>(`/projects/${encodeURIComponent(id)}`);
  const sessions = useApi<{ sessions: SessionRow[] }>(`/sessions?projectId=${encodeURIComponent(id)}`);
  const files = useApi<{ artifacts: Artifact[] }>(`/artifacts?projectId=${encodeURIComponent(id)}`);
  const [chatId, setChatId] = useState<string | null>(chat ?? null);
  const [tab, setTab] = useState<"chats" | "files">("chats");
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [over, setOver] = useState(false);
  const pick = useRef<HTMLInputElement | null>(null);
  const uploader = useUploader({ projectId: id, onDone: () => { files.reload(); setTab("files"); }, drop: false });
  const actions = useChatActions(() => sessions.reload(), chatId ?? undefined);
  useEffect(() => { setChatId(chat ?? null); }, [chat]);
  useSignal("sessions", sessions.reload);
  useSignal("files", files.reload);

  if (project.error) return <div className="page"><div className="card"><Empty testid="project-missing" icon={<Icon.folder size={24} />} title="Project not found" action={<button className="btn" onClick={() => navigate("/projects")}>All projects</button>}>It may have been removed, or it belongs to another account.</Empty></div></div>;
  const p = project.data?.project;
  const chats = [...(sessions.data?.sessions ?? [])].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  const projectFiles = [...(files.data?.artifacts ?? [])].filter((a) => a.kind !== "run").sort((a, b) => b.createdAt - a.createdAt);
  const current = chats.find((s) => s.sessionId === chatId);

  return (
    <div className="project">
      <aside className="project__side">
        <div className="project__head">
          <div className="crumb"><button onClick={() => navigate("/projects")}>Projects</button><Icon.chev size={12} /></div>
          <h1>{p ? <ProjectIcon name={p.name} size={30} /> : null}<span data-testid="project-name">{p?.name ?? "…"}</span>
            <ActionMenu label="Project actions" trigger={<Icon.more size={16} />} items={[
              { label: "Rename & describe", icon: <Icon.edit size={15} />, onClick: () => setEditing(true), testid: "project-edit" },
              { label: "Upload files", icon: <Icon.upload size={15} />, onClick: () => pick.current?.click() },
              "sep",
              { label: "Delete project", icon: <Icon.trash size={15} />, onClick: () => setRemoving(true), danger: true, testid: "project-delete" },
            ]} />
          </h1>
          <p>{p?.description || "Chats here share this project's files."}</p>
          <div className="project__actions">
            <button className="btn btn--primary btn--sm" onClick={() => { setChatId(null); navigate(`/projects/${id}`); }}><Icon.plus size={15} /> New chat</button>
            <button className="btn btn--sm" onClick={() => pick.current?.click()}><Icon.upload size={15} /> Upload</button>
          </div>
        </div>
        <div className="project__tabs">
          <div className="seg" style={{ width: "100%" }}>
            <button style={{ flex: 1, justifyContent: "center" }} className={tab === "chats" ? "is-on" : ""} onClick={() => setTab("chats")}>Chats · {chats.length}</button>
            <button style={{ flex: 1, justifyContent: "center" }} className={tab === "files" ? "is-on" : ""} onClick={() => setTab("files")} data-testid="project-files-tab">Files · {projectFiles.length}</button>
          </div>
        </div>
        <div className="project__body">
          {tab === "chats" ? (
            <>
              {chats.map((s) => (
                <div key={s.sessionId} className={`chats__row${s.sessionId === chatId ? " is-on" : ""}`}>
                  <button className="chats__item" onClick={() => navigate(`/projects/${id}/chats/${s.sessionId}`)}>
                    {s.pinned ? <Icon.pin size={14} /> : <Icon.chat size={14} />}<span><b>{s.title}</b><span>{ago(s.updatedAt)}</span></span>
                  </button>
                  <ActionMenu label={`Actions for ${s.title}`} trigger={<Icon.more size={16} />} items={actions.items(s)} />
                </div>
              ))}
              {sessions.data && !chats.length ? <div className="list__empty" style={{ padding: "12px 10px" }}>No chats in this project yet. Ask something on the right.</div> : null}
            </>
          ) : (
            <>
              <div className="list">{projectFiles.map((a) => <FileRow key={a.artifactId} a={a} />)}</div>
              {files.data && !projectFiles.length ? <div className="list__empty">No files in this project yet.</div> : null}
              <button className={`dropzone${over ? " is-over" : ""}`} onClick={() => pick.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
                onDrop={(e) => { e.preventDefault(); setOver(false); void uploader.start(Array.from(e.dataTransfer.files)); }}>
                <Icon.upload size={16} /><br />Drop files here or click to upload
              </button>
            </>
          )}
        </div>
      </aside>
      <section className="chat-pane">
        <div className="chat-pane__head">
          <h2>{current?.title ?? "New chat in this project"}</h2>
          {current ? <><button className="btn btn--sm btn--ghost" onClick={() => actions.share(current)}><Icon.share size={15} /> Share</button><ActionMenu label="Conversation actions" trigger={<Icon.more size={16} />} items={actions.items(current)} /></> : null}
        </div>
        <ChatThread sessionId={chatId} projectId={id} placeholder={`Message ORVYN about ${p?.name ?? "this project"}…`} emptyTitle={p ? `What's next for ${p.name}?` : undefined}
          onSession={(sid) => { setChatId(sid); navigate(`/projects/${id}/chats/${sid}`, { replace: true }); window.setTimeout(() => { sessions.reload(); files.reload(); }, 400); }} />
      </section>
      <input ref={pick} type="file" multiple hidden data-testid="project-upload" onChange={(e) => { const list = Array.from(e.target.files ?? []); e.target.value = ""; void uploader.start(list); }} />
      {uploader.ui}
      {actions.modals}
      {editing && p ? <ProjectModal project={p} onClose={() => setEditing(false)} onSaved={() => { project.reload(); signal("projects"); toast("Project saved."); }} /> : null}
      {removing && p ? (
        <Modal title={`Delete “${p.name}”?`} onClose={() => setRemoving(false)}>
          <p className="muted" style={{ marginTop: 0 }}>The project is removed. Its {chats.length} chat{chats.length === 1 ? "" : "s"} move back to Chats and its files stay in Files — nothing else is deleted.</p>
          <div className="modal__actions">
            <button className="btn" onClick={() => setRemoving(false)}>Cancel</button>
            <button className="btn btn--danger" data-testid="confirm-delete-project" onClick={async () => { try { await api(`/projects/${id}`, { method: "DELETE" }); signal("projects"); signal("sessions"); navigate("/projects"); toast("Project deleted."); } catch (err: any) { toast(err.message); } }}>Delete project</button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
