import {Orb} from "./Orb";
import {useEffect,useState,useRef} from 'react';
import {api,getToken} from '../lib/api';
import {readSseStream} from '../lib/sse';
import './cloudWorkbench.css';
type Tab='Browser'|'Desktop'|'Code'|'Files'|'Terminal';
export function CloudWorkbench({runId,events=[]}:{runId?:string;events?:Array<{type:string;data?:Record<string,any>}>}){
 const [tab,setTab]=useState<Tab>('Browser'),[picture,setPicture]=useState(''),[error,setError]=useState(''),[owner,setOwner]=useState('orion'),[file,setFile]=useState(''),[code,setCode]=useState('');
 const streamAbort=useRef<AbortController|null>(null);
 const activeRun=useRef(runId);activeRun.current=runId;
 const surface=events.find(e=>e.type==='desktop.target')?.data?.surface;
 useEffect(()=>{if(surface==='desktop')setTab('Desktop');else if(surface==='browser')setTab('Browser')},[runId,surface]);
 const browserStarted=events.some(e=>e.type==='tool.started' && String(e.data?.tool??'').startsWith('browser_'));
 useEffect(()=>{setPicture('');setError('');setOwner('orion');setCode('')},[runId]);
 useEffect(()=>{
   if(!runId || !['Browser','Desktop'].includes(tab))return;
   const controller=new AbortController();streamAbort.current=controller;setPicture('');setError('');
   const token=getToken();const headers=token?{Authorization:`Bearer ${token}`} : undefined;
   void(async()=>{
     if(tab==='Browser'){
       const r=await fetch(`/api/v1/cloud-workbench/${encodeURIComponent(runId)}/browser/stream`,{headers,signal:controller.signal});
       if(!r.ok||!r.body)throw new Error('No active cloud browser for this run. Start a browser task in chat.');
       await readSseStream(r.body,raw=>{if(controller.signal.aborted)return;const data=raw as any;if(data.screenshot?.b64)setPicture(`data:${data.screenshot.mediaType};base64,${data.screenshot.b64}`);if(data.control)setOwner(data.control.owner);if(data.error)setError(data.error)});
     }else{
       const state=await api(`/desktop/session?runId=${encodeURIComponent(runId)}`,{signal:controller.signal});
       if(!state.session?.live)throw new Error('No active cloud desktop for this run. Ask ORVYN to use its cloud desktop.');
       setOwner(state.session.controlOwner);
       const r=await fetch(`/api/v1/desktop/stream?runId=${encodeURIComponent(runId)}`,{headers,signal:controller.signal});
       if(!r.ok||!r.body)throw new Error('Cloud desktop stream unavailable');
       const reader=r.body.getReader(),decoder=new TextDecoder();let buffer='';
       try{while(!controller.signal.aborted){const next=await reader.read();if(next.done||controller.signal.aborted)break;buffer+=decoder.decode(next.value,{stream:true});const frames=buffer.split(/\r?\n\r?\n/);buffer=frames.pop()??'';for(const frame of frames){const data=frame.split(/\r?\n/).find(x=>x.startsWith('data:'))?.slice(5).trim();if(!data)continue;if(frame.startsWith('event: frame'))setPicture(`data:image/jpeg;base64,${data}`);if(frame.startsWith('event: state'))setOwner(JSON.parse(data).controlOwner)}}}finally{reader.releaseLock()}
     }
     if(!controller.signal.aborted){setPicture('');setError('Live session ended.')}
   })().catch(e=>{if(!controller.signal.aborted)setError(e.message)});
   return()=>controller.abort();
 },[runId,tab,browserStarted]);
 async function control(next:'user'|'orion'){
   if(!runId)return;
   try{await api(tab==='Browser'?`/cloud-workbench/${runId}/browser/control`:'/desktop/control',{method:'POST',body:{runId,owner:next}});setOwner(next)}catch(e:any){setError(e.message)}
 }
 async function input(body:Record<string,unknown>){if(!runId||owner!=='user')return;try{await api(tab==='Browser'?`/cloud-workbench/${runId}/browser/input`:'/desktop/input',{method:'POST',body:{runId,...body}})}catch(e:any){setError(e.message)}}
 async function read(path?:string){if(!runId)return;try{const requestedRun=runId;const r=await api(`/cloud-workbench/${runId}/files${path===undefined?'':`?path=${encodeURIComponent(path)}`}`);if(activeRun.current===requestedRun)setCode(r.output??'')}catch(e:any){setError(e.message)}}
 const terminal=events.filter(e=>e.type==='terminal.output'||e.type==='terminal.started'||e.type==='terminal.completed');
 return <aside className="cloud-workbench" aria-label="Cloud Workbench">
   <header><Orb className="cloud-workbench__orb"/><strong>ORVYN workspace</strong><span>Cloud sandbox</span></header>
   <nav aria-label="Workspace views">{(['Browser','Desktop','Code','Files','Terminal'] as Tab[]).map(t=><button key={t} aria-pressed={t===tab} onClick={()=>{setTab(t);if(t==='Files')void read()}}>{t}</button>)}</nav>
   {!runId?<p>Run a task in chat to open its workspace here.</p>:<>
   {['Browser','Desktop'].includes(tab)&&<><div className="cloud-workbench__controls"><span>{owner==='user'?'You have control':'ORVYN has control'}</span><button onClick={()=>void control(owner==='user'?'orion':'user')}>{owner==='user'?'Return to ORVYN':'Take control'}</button><button onClick={()=>void control('user')}>Pause agent input</button><button onClick={()=>{void api(`/cloud-workbench/${runId}/stop`,{method:'POST',body:{}}).then(()=>{streamAbort.current?.abort();setPicture('');setError('Task and cloud workspace stopped')}).catch(e=>setError(e.message))}}>Stop task</button></div>
   {picture?<img className="cloud-workbench__screen" src={picture} alt={`Live cloud ${tab.toLowerCase()}`} tabIndex={owner==='user'?0:-1} onClick={e=>{const r=e.currentTarget.getBoundingClientRect();void input({type:'click',x:Math.round((e.clientX-r.left)*e.currentTarget.naturalWidth/r.width),y:Math.round((e.clientY-r.top)*e.currentTarget.naturalHeight/r.height),viewWidth:e.currentTarget.naturalWidth,viewHeight:e.currentTarget.naturalHeight})}} onKeyDown={e=>{if(owner!=='user')return;e.preventDefault();void input(e.key.length===1?{type:'type',text:e.key}:{type:'key',key:e.key})}} onWheel={e=>void input({type:'scroll',deltaY:Math.max(-2000,Math.min(2000,e.deltaY))})}/>:<p>Waiting for this run’s live session.</p>}
   <p className="cloud-workbench__hint">This is an isolated cloud computer. Your physical screen is never shared here.</p></>}
   {(tab==='Code'||tab==='Files')&&<><form onSubmit={e=>{e.preventDefault();void read(file)}}><input aria-label="Project file path" value={file} onChange={e=>setFile(e.target.value)} placeholder="Project file, e.g. src/app.ts"/><button>Read file</button><button type="button" onClick={()=>void read()}>List files</button></form><pre>{code||'Choose a file from this run’s project.'}</pre></>}
   {tab==='Terminal'&&<><p>Live command output. Ask ORVYN in chat to run commands through your approval policy.</p><pre>{terminal.map(e=>String(e.data?.data??e.data?.command??(e.type==='terminal.completed'?'Command finished':'')).slice(0,8000)).join('\n')||'No command output for this run.'}</pre></>}
   {error&&<p role="status" className="cloud-workbench__error">{error}</p>}
   </>}
 </aside>;
}
