import React, { useEffect, useRef, useState } from "react";
import { apiUrl, authHeaders, getConnectionConfig } from "../connection";
import { FileTypeIcon } from "./ToolActivityRow";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
GlobalWorkerOptions.workerSrc = pdfWorker;

type DocumentFile = {name:string;size:number;modified:number};
function documentQuery(projectRoot: string | null): string {
  // Attached source documents are extracted on the selected backend. Cloud
  // deliverables live in its tenant workspace, never a Windows filesystem path.
  const url = new URL(getConnectionConfig().backendUrl);
  const local = ["localhost","127.0.0.1","[::1]"].includes(url.hostname);
  return local && projectRoot ? `projectRoot=${encodeURIComponent(projectRoot)}` : "";
}
export function DocumentsPanel({projectRoot, revision}:{projectRoot:string|null;revision:number}) {
  const [files,setFiles] = useState<DocumentFile[]>([]);
  const [selected,setSelected] = useState<string|null>(null);
  const [text,setText] = useState("");
  const [pdf,setPdf] = useState<Uint8Array|null>(null);
  const [error,setError] = useState<string|null>(null);
  const [loading,setLoading] = useState(false);
  const [refresh,setRefresh] = useState(0);
  const query = documentQuery(projectRoot);
  useEffect(() => {
    const controller = new AbortController();
    fetch(apiUrl(`/documents?${query}`),{headers:authHeaders(),signal:controller.signal}).then(async res => {const data=await res.json();if(!res.ok)throw new Error(data.error);setFiles(data.documents);setError(null);}).catch(e=>{if(e.name!=="AbortError")setError(e.message);});
    return ()=>controller.abort();
  },[query,revision,refresh]);
  useEffect(()=>{setSelected(null);setText("");setPdf(null);},[projectRoot]);
  useEffect(()=>{
    if(!selected)return;
    const controller=new AbortController();setLoading(true);setError(null);setText("");setPdf(null);
    const isPdf=/\.pdf$/i.test(selected);
    fetch(apiUrl(`/documents/${encodeURIComponent(selected)}?${query}${isPdf?"":"&preview=text"}`),{headers:authHeaders(),signal:controller.signal}).then(async res=>{
      if(!res.ok)throw new Error((await res.json()).error ?? "Preview unavailable");
      if(isPdf){const data=new Uint8Array(await res.arrayBuffer());if(!controller.signal.aborted)setPdf(data);}
      else {const data=await res.json();if(!controller.signal.aborted)setText(`${data.text}${data.note?`\n\n${data.note}`:""}${data.truncated?"\n[Preview truncated]":""}`);}
    }).catch(e=>{if(e.name!=="AbortError")setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>controller.abort();
  },[selected,query]);
  async function download(name:string){
    try {
      const res=await fetch(apiUrl(`/documents/${encodeURIComponent(name)}?${query}`),{headers:authHeaders()});
      if(!res.ok)throw new Error((await res.json()).error ?? "Download failed");
      const url=URL.createObjectURL(await res.blob()); const link=document.createElement("a");link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
    }catch(e:any){setError(e.message);}
  }
  return <section style={{padding:14,overflowY:"auto",minWidth:0}} aria-label="Documents">
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}><strong>Documents</strong><button className="activity-link" onClick={()=>setRefresh(v=>v+1)}>Refresh</button></div>
    <p style={{fontSize:12,color:"var(--text-secondary)",lineHeight:1.6}}>Ask ORVYN to write a Word document, PDF, spreadsheet or slide deck. Attach an existing document to read or rewrite it.</p>
    {error&&<p role="alert" className="activity-error">{error}</p>}
    {!files.length&&!error&&<p style={{fontSize:12,color:"var(--text-muted)"}}>Created documents will appear here.</p>}
    {files.map(file=><div key={file.name} className="activity-row" style={{margin:"8px 0",padding:8,border:"1px solid var(--border)",borderRadius:8}}>
      <FileTypeIcon name={file.name} ext={file.name.split(".").pop()?.toUpperCase()} />
      <button className="activity-link" style={{flex:1,minWidth:0,textAlign:"left",overflowWrap:"anywhere"}} onClick={()=>setSelected(file.name)}>{file.name}</button>
      <button className="activity-link" aria-label={`Download ${file.name}`} onClick={()=>void download(file.name)}>↓ Save</button>
    </div>)}
    {selected&&<h4 style={{overflowWrap:"anywhere"}}>{selected}</h4>}
    {loading&&<p role="status">Loading preview…</p>}
    {pdf&&<PdfPreview data={pdf} onError={setError} />}
    {text&&<><p style={{fontSize:11,color:"var(--text-muted)"}}>Text preview · Download to view the original formatting.</p><pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere",fontFamily:"inherit",fontSize:12,lineHeight:1.7}}>{text}</pre></>}
  </section>;
}
function PdfPreview({data,onError}:{data:Uint8Array;onError:(text:string)=>void}) {
  const canvas=useRef<HTMLCanvasElement>(null);
  const [page,setPage]=useState(1);const [pages,setPages]=useState(0);
  useEffect(()=>{
    let cancelled=false;
    const task=getDocument({data:data.slice()});
    task.promise.then(async pdf=>{
      if(cancelled)return;
      setPages(pdf.numPages);
      const sheet=await pdf.getPage(Math.min(page,pdf.numPages));
      if(cancelled||!canvas.current)return;
      const viewport=sheet.getViewport({scale:1.4});const node=canvas.current;
      node.width=viewport.width;node.height=viewport.height;
      await sheet.render({canvas:node,viewport}).promise;
    }).catch(e=>{if(!cancelled)onError(`PDF preview: ${e.message}`);});
    return ()=>{cancelled=true;void task.destroy();};
  },[data,page,onError]);
  useEffect(()=>setPage(1),[data]);
  return <div><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:12,marginBottom:10}}><button className="activity-link" disabled={page<=1} onClick={()=>setPage(p=>p-1)}>Previous</button><span>Page {page} of {pages||"…"}</span><button className="activity-link" disabled={!pages||page>=pages} onClick={()=>setPage(p=>p+1)}>Next</button></div><canvas ref={canvas} aria-label={`PDF page ${page}`} style={{width:"100%",height:"auto",background:"white"}} /></div>;
}
