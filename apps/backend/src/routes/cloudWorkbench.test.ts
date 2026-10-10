import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {cloudWorkbenchRouter} from './cloudWorkbench';
import type {Tenant} from '../tenancy/TenantManager';
import {clearBrowserControl} from '../computerUse/cloudBrowserControl';
async function fixture(){
 const calls:any[]=[];
 const run={id:'owned',projectRoot:'/tenant-a/project-one',status:'running',events:[{type:'run.execution',data:{executionTargetActual:'ovh_worker'}},{type:'tool.started',data:{tool:'browser_open'}}]};
 const tenant={id:'tenant-a',runStore:{get:(id:string)=>id==='owned'?run:undefined},agentRuntime:{cancel:(id:string)=>{calls.push(['cancel',id]);run.status='cancelled'}},multiAgentRuntime:{cancel:()=>false}} as unknown as Tenant;
 const rpc={execute:async(id:string,tool:string,args:Record<string,unknown>)=>{calls.push([id,tool,args]);if(tool==='browser_screenshot')run.status='completed';return {requestId:'mock',runId:id,ok:true,output:'fixture file',durationMs:0,meta:{screenshot:{b64:'Zml4dHVyZQ==',mediaType:'image/png'}}}}};
 const app=express();app.use(express.json());app.use((req,_res,next)=>{req.tenant=tenant;next()});app.use(cloudWorkbenchRouter({rpc}));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));const address=server.address() as {port:number};
 return {run,calls,url:`http://127.0.0.1:${address.port}`,close:()=>new Promise<void>(resolve=>server.close(()=>resolve()))};
}
test('cloud view refuses another tenant run and all physical execution targets',async()=>{const f=await fixture();try{assert.equal((await fetch(f.url+'/other/files')).status,404);for(const target of ['local_host','local_sandbox']){f.run.events[0].data={executionTargetActual:target};assert.equal((await fetch(f.url+'/owned/files')).status,409)}assert.equal(f.calls.length,0)}finally{await f.close()}});
test('browser view streams the actual mocked worker frame for the owned run',async()=>{const f=await fixture();try{const response=await fetch(f.url+'/owned/browser/stream');assert.equal(response.headers.get('content-type')?.includes('text/event-stream'),true);const text=await response.text();assert.match(text,/Zml4dHVyZQ==/);assert.deepEqual(f.calls[0],['owned','browser_screenshot',{fullPage:false}])}finally{await f.close()}});
test('view cannot start a browser for a task that did not use one',async()=>{const f=await fixture();f.run.events.pop();try{assert.equal((await fetch(f.url+'/owned/browser/stream')).status,409);assert.equal(f.calls.length,0)}finally{await f.close()}});
test('input requires takeover; file reads and stop stay bound to the selected run',async()=>{const f=await fixture();const post=(path:string,body:unknown)=>fetch(f.url+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});try{assert.equal((await post('/owned/browser/input',{type:'click',x:1,y:1})).status,409);assert.equal((await post('/owned/browser/control',{owner:'user'})).status,200);assert.equal((await post('/owned/browser/input',{type:'click',x:1,y:1})).status,200);assert.equal((await fetch(f.url+'/owned/files?path=src%2Fapp.ts&projectRoot=%2Fother')).status,200);assert.deepEqual(f.calls.find(c=>c[1]==='read_file'),['owned','read_file',{path:'src/app.ts'}]);assert.equal((await post('/owned/stop',{})).status,200);assert.ok(f.calls.some(c=>c[0]==='cancel'&&c[1]==='owned'))}finally{clearBrowserControl('owned');await f.close()}});

test('nested listings use the selected run workspace without changing existing file reads', async () => {
 const f = await fixture();
 try {
  assert.equal((await fetch(f.url + '/owned/files?path=src&list=1&projectRoot=%2Fother')).status, 200);
  assert.deepEqual(f.calls[0], ['owned', 'list_directory', { path: 'src' }]);
  assert.equal((await fetch(f.url + '/owned/files?path=src%2Fapp.ts')).status, 200);
  assert.deepEqual(f.calls[1], ['owned', 'read_file', { path: 'src/app.ts' }]);
 } finally { await f.close(); }
});
