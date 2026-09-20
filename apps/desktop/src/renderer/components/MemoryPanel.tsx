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
  async function addMemory(){
    const content=window.prompt("What should ORION remember?");
    if(!content?.trim()) return;
    const scope=projectRoot && window.confirm("Store only for this project?\nOK = Project, Cancel = Global")?"project":"global";
    await fetch(apiUrl("/memory"),{method:"POST",headers:{"Content-Type":"application/json",...authHeaders()},body:JSON.stringify({content,scope,projectRoot,kind:"knowledge",source:"user"})});
    load();
  }
  return <div style={{height:"100%",display:"flex",flexDirection:"column",background:"var(--orvyn-surface-1)"}}>
    <div style={{padding:"18px 20px 10px",borderBottom:"1px solid var(--orvyn-border-soft)"}}>
      <div style={{fontSize:18,fontWeight:700}}>Memory</div>
      <div style={{fontSize:12,color:"var(--orvyn-text-muted)",marginTop:3}}>Persistent ORION knowledge, conversations, and saved artifacts.</div>
      <div style={{display:"flex",gap:6,marginTop:14}}>
        {(["memory","conversations","files"] as const).map(x=><button key={x} onClick={()=>setTab(x)} style={pill(tab===x)}>{x==="memory"?"Agent Memory":x==="conversations"?"Conversations":"Files & Artifacts"}</button>)}
        {tab==="memory"&&<button onClick={()=>void addMemory()} style={{...pill(true),marginLeft:"auto"}}>+ Add Memory</button>}
      </div>
    </div>
    <div style={{flex:1,overflow:"auto",padding:20}}>
      {tab==="memory"&&<>
        <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search memory…" style={searchStyle}/>
        {filtered.length===0?<Empty text="No saved memory yet. Add project decisions, instructions, or reusable knowledge."/>:filtered.map(m=><div key={m.id} style={card}>
          <div style={{display:"flex",gap:8,alignItems:"center"}}><b>{m.title}</b><span style={tag}>{m.scope}</span><span style={tag}>{m.kind}</span>{m.pinned&&<span style={tag}>pinned</span>}<button onClick={async()=>{await fetch(apiUrl("/memory/"+encodeURIComponent(m.id)),{method:"DELETE",headers:authHeaders()});load();}} style={{marginLeft:"auto",...linkBtn}}>Delete</button></div>
          <div style={{fontSize:12.5,lineHeight:1.55,marginTop:7,whiteSpace:"pre-wrap"}}>{m.content}</div>
          <div style={{fontSize:10.5,color:"var(--orvyn-text-muted)",marginTop:7}}>Source: {m.source||"unknown"} · {new Date(m.updatedAt).toLocaleString()}</div>
        </div>)}
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
const linkBtn:React.CSSProperties={background:"transparent",border:"none",color:"var(--orvyn-purple-hi)",cursor:"pointer",fontSize:11};
const searchStyle:React.CSSProperties={width:"100%",boxSizing:"border-box",background:"var(--orvyn-bg)",border:"1px solid var(--orvyn-border)",borderRadius:7,color:"var(--orvyn-text)",padding:"8px 10px",marginBottom:12};
function pill(active:boolean):React.CSSProperties{return {background:active?"var(--orvyn-purple)":"transparent",border:"1px solid var(--orvyn-border)",borderRadius:999,color:active?"#fff":"var(--orvyn-text-secondary)",padding:"5px 10px",fontSize:11,cursor:"pointer"}}
