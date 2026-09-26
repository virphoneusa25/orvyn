import React, { useEffect, useMemo, useState } from "react";
import { apiUrl, authHeaders } from "../connection";
import { listChatSessions, openChatSession, deleteChatSession, subscribeChat } from "../chatSession";

type MemoryItem = { id:string; scope:"global"|"project"; projectRoot?:string|null; kind:string; title:string; content:string; source?:string|null; pinned:boolean; updatedAt:number };
type Artifact = { id:string; project_root?:string|null; run_id?:string|null; kind:string; name:string; path:string; media_type?:string|null; created_at:number };

export function MemoryPanel({ projectRoot, onOpenChat }: { projectRoot:string|null; onOpenChat:()=>void }) {
  const [tab,setTab]=useState<"memory"|"conversations"|"files">("memory");
  const [items,setItems]=useState<MemoryItem[]>([]);
  const [artifacts,setArtifacts]=useState<Artifact[]>([]);
  const [q,setQ]=useState("");
  const [,tick]=useState(0);
  const chats=listChatSessions();
  useEffect(()=>subscribeChat(()=>tick(x=>x+1)),[]);
  const load=()=> {
    const suffix=projectRoot?`?projectRoot=${encodeURIComponent(projectRoot)}`:"";
    fetch(apiUrl("/memory"+suffix),{headers:authHeaders()}).then(r=>r.json()).then(d=>setItems(d.memories??[])).catch(()=>setItems([]));
    fetch(apiUrl("/artifacts"+suffix),{headers:authHeaders()}).then(r=>r.json()).then(d=>setArtifacts(d.artifacts??[])).catch(()=>setArtifacts([]));
  };
  useEffect(load,[projectRoot]);
  const filtered=useMemo(()=>items.filter(m=>(m.title+" "+m.content+" "+m.kind).toLowerCase().includes(q.toLowerCase())),[items,q]);
  const about=useMemo(()=>filtered.filter(m=>m.kind==="about_user"),[filtered]);
  const notes=useMemo(()=>filtered.filter(m=>m.kind!=="about_user"),[filtered]);
  const [draft,setDraft]=useState("");
  const [draftFor,setDraftFor]=useState<"about"|"note"|null>(null);
  const [noteScope,setNoteScope]=useState<"global"|"project">("global");
  const [editing,setEditing]=useState<{id:string;text:string}|null>(null);
  async function addMemory(kind:"about"|"note"){
    const content=draft.trim();
    if(!content) return;
    const scope=kind==="about"?"global":(noteScope==="project"&&projectRoot?"project":"global");
    await fetch(apiUrl("/memory"),{method:"POST",headers:{"Content-Type":"application/json",...authHeaders()},body:JSON.stringify({content,title:content.slice(0,60),scope,projectRoot,kind:kind==="about"?"about_user":"knowledge",source:"user"})});
    setDraft("");setDraftFor(null);load();
  }
  async function saveEdit(){
    if(!editing) return;
    const content=editing.text.trim();
    if(content) await fetch(apiUrl("/memory/"+encodeURIComponent(editing.id)),{method:"PATCH",headers:{"Content-Type":"application/json",...authHeaders()},body:JSON.stringify({content,title:content.slice(0,60),source:"user"})});
    setEditing(null);load();
  }
  const sourceLabel=(m:MemoryItem)=>m.source==="learned"?"Learned from your conversations":m.source==="user"?"You told ORION":`Source: ${m.source||"unknown"}`;
  const row=(m:MemoryItem)=><div key={m.id} style={card} data-testid="memory-item" data-kind={m.kind}>
    <div style={{display:"flex",gap:8,alignItems:"center"}}>
      {m.kind!=="about_user"&&<b>{m.title}</b>}
      {m.kind!=="about_user"&&<span style={tag}>{m.scope}</span>}
      {m.pinned&&<span style={tag}>pinned</span>}
      <span style={{marginLeft:"auto",display:"flex",gap:4}}>
        <button style={linkBtn} onClick={()=>setEditing({id:m.id,text:m.content})}>Edit</button>
        {m.kind!=="about_user"&&<button onClick={async()=>{await fetch(apiUrl("/memory/"+encodeURIComponent(m.id)),{method:"PATCH",headers:{"Content-Type":"application/json",...authHeaders()},body:JSON.stringify({pinned:!m.pinned})});load();}} style={linkBtn}>{m.pinned?"Unpin":"Pin"}</button>}
        <button onClick={async()=>{await fetch(apiUrl("/memory/"+encodeURIComponent(m.id)),{method:"DELETE",headers:authHeaders()});load();}} style={linkBtn}>{m.kind==="about_user"?"Forget":"Delete"}</button>
      </span>
    </div>
    {editing?.id===m.id
      ?<div style={{marginTop:7}}><textarea value={editing.text} onChange={e=>setEditing({id:m.id,text:e.target.value})} rows={3} style={{...searchStyle,marginBottom:6,resize:"vertical"}} autoFocus/>
        <div style={{display:"flex",gap:6}}><button style={pill(true)} onClick={()=>void saveEdit()}>Save</button><button style={pill(false)} onClick={()=>setEditing(null)}>Cancel</button></div></div>
      :<div style={{fontSize:12.5,lineHeight:1.55,marginTop:m.kind==="about_user"?0:7,whiteSpace:"pre-wrap"}}>{m.content}</div>}
    <div style={{fontSize:10.5,color:"var(--orvyn-text-muted)",marginTop:7}}>{sourceLabel(m)} · {new Date(m.updatedAt).toLocaleString()}</div>
  </div>;
  const composer=(kind:"about"|"note")=>draftFor===kind&&<div style={{...card,borderColor:"var(--orvyn-purple)"}}>
    <textarea value={draft} onChange={e=>setDraft(e.target.value)} rows={2} autoFocus data-testid={`memory-draft-${kind}`}
      placeholder={kind==="about"?"Something ORION should know about you or your work, e.g. \"We run VirPhone USA on Kamailio + FreeSWITCH.\"":"A note, decision or instruction ORION should reuse."}
      style={{...searchStyle,marginBottom:6,resize:"vertical"}}/>
    <div style={{display:"flex",gap:6,alignItems:"center"}}>
      <button style={pill(true)} data-testid={`memory-save-${kind}`} onClick={()=>void addMemory(kind)}>Save</button>
      <button style={pill(false)} onClick={()=>{setDraft("");setDraftFor(null);}}>Cancel</button>
      {kind==="note"&&projectRoot&&<label style={{fontSize:11,marginLeft:"auto",color:"var(--orvyn-text-muted)"}}><input type="checkbox" checked={noteScope==="project"} onChange={e=>setNoteScope(e.target.checked?"project":"global")}/> Only this project</label>}
    </div>
  </div>;
  return <div style={{height:"100%",display:"flex",flexDirection:"column",background:"var(--orvyn-surface-1)"}}>
    <div style={{padding:"18px 20px 10px",borderBottom:"1px solid var(--orvyn-border-soft)"}}>
      <div style={{fontSize:18,fontWeight:700}}>Memory</div>
      <div style={{fontSize:12,color:"var(--orvyn-text-muted)",marginTop:3}}>Persistent ORION knowledge, conversations, and saved artifacts.</div>
      <div style={{display:"flex",gap:6,marginTop:14}}>
        {(["memory","conversations","files"] as const).map(x=><button key={x} onClick={()=>setTab(x)} style={pill(tab===x)}>{x==="memory"?"Agent Memory":x==="conversations"?"Conversations":"Files & Artifacts"}</button>)}
      </div>
    </div>
    <div style={{flex:1,overflow:"auto",padding:20}}>
      {tab==="memory"&&<>
        <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search memory…" style={searchStyle}/>
        <div style={sectionHead}><span>About you</span><span style={{fontWeight:400,color:"var(--orvyn-text-muted)"}}>ORION uses this in every conversation</span><button style={{...linkBtn,marginLeft:"auto"}} data-testid="memory-add-about" onClick={()=>{setDraft("");setDraftFor("about");}}>+ Add</button></div>
        {composer("about")}
        {about.length===0&&draftFor!=="about"?<Empty text="Nothing yet. ORION learns what you tell it about yourself and your work (companies, products, names, stack, decisions) — or add it here."/>:about.map(row)}
        <div style={{...sectionHead,marginTop:18}}><span>Notes</span><span style={{fontWeight:400,color:"var(--orvyn-text-muted)"}}>Project decisions, instructions, reusable knowledge</span><button style={{...linkBtn,marginLeft:"auto"}} onClick={()=>{setDraft("");setDraftFor("note");}}>+ Add</button></div>
        {composer("note")}
        {notes.length===0&&draftFor!=="note"?<Empty text="No saved notes yet."/>:notes.map(row)}
      </>}
      {tab==="conversations"&&(chats.length===0?<Empty text="No saved conversations yet."/>:chats.map(s=><div key={s.id} style={card}>
        <div style={{display:"flex",alignItems:"center",gap:8}}><b style={{flex:1}}>{s.title||"Untitled"}</b><button style={linkBtn} onClick={()=>{openChatSession(s.id);onOpenChat();}}>Open</button><button style={linkBtn} onClick={()=>deleteChatSession(s.id)}>Delete</button></div>
        <div style={{fontSize:11,color:"var(--orvyn-text-muted)",marginTop:5}}>{s.count} messages · {new Date(s.updatedAt).toLocaleString()}</div>
      </div>))}
      {tab==="files"&&(artifacts.length===0?<Empty text="No durable artifacts have been registered yet. Generated and mission files will appear here as they are persisted."/>:artifacts.map(a=><div key={a.id} style={card}><b>{a.name}</b><span style={{...tag,marginLeft:8}}>{a.kind}</span><div style={{fontFamily:"var(--font-mono)",fontSize:11.5,color:"var(--orvyn-text-secondary)",marginTop:6}}>{a.path}</div></div>))}
    </div>
  </div>;
}
function Empty({text}:{text:string}){return <div style={{padding:"36px 12px",textAlign:"center",color:"var(--orvyn-text-muted)",fontSize:12}}>{text}</div>}
const card:React.CSSProperties={padding:"12px 14px",border:"1px solid var(--orvyn-border-soft)",borderRadius:8,background:"var(--orvyn-surface-2)",marginBottom:8};
const tag:React.CSSProperties={fontSize:9,textTransform:"uppercase",letterSpacing:.6,color:"var(--orvyn-purple-hi)",border:"1px solid var(--orvyn-border)",borderRadius:999,padding:"2px 6px"};
const sectionHead:React.CSSProperties={display:"flex",gap:10,alignItems:"baseline",fontSize:12.5,fontWeight:700,margin:"4px 0 8px"};
const linkBtn:React.CSSProperties={background:"transparent",border:"none",color:"var(--orvyn-purple-hi)",cursor:"pointer",fontSize:11};
const searchStyle:React.CSSProperties={width:"100%",boxSizing:"border-box",background:"var(--orvyn-bg)",border:"1px solid var(--orvyn-border)",borderRadius:7,color:"var(--orvyn-text)",padding:"8px 10px",marginBottom:12};
function pill(active:boolean):React.CSSProperties{return {background:active?"var(--orvyn-purple)":"transparent",border:"1px solid var(--orvyn-border)",borderRadius:999,color:active?"#fff":"var(--orvyn-text-secondary)",padding:"5px 10px",fontSize:11,cursor:"pointer"}}
