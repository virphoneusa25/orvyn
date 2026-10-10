import {Router} from 'express';
import {isTerminal} from '../agent/events';
import {requireTenant} from '../middleware/tenant';
import {toolRpc} from '../execution/ToolRpc';
import {browserControl,setBrowserControl,clearBrowserControl} from '../computerUse/cloudBrowserControl';
import {makeReadFileTool,makeListDirectoryTool} from '../ai/tools/fileTools';
import {findSandboxSession,stopSandboxDesktop} from '../desktop/sandboxDesktop';
export function cloudWorkbenchRouter(dependencies: {rpc: Pick<typeof toolRpc,"execute">} = {rpc:toolRpc}){
 const rpc=dependencies.rpc;
 const router=Router();
 router.use('/:runId', (req,res,next)=>{
   const run=requireTenant(req).runStore.get(req.params.runId);
   if(!run)return res.status(404).json({error:'Run not found'});
   const execution=[...run.events].reverse().find(e=>e.type==='run.execution');
   if(execution?.data?.executionTargetActual!=='ovh_worker')return res.status(409).json({error:'This run has no isolated cloud worker workspace.'});
   res.locals.run=run;next();
 });
 router.get('/:runId/browser/frame',async(req,res)=>{
   const frame=[...res.locals.run.events].reverse().find((event:any)=>event.type==='browser.frame' && typeof event.data?.artifactId==='string');
   if(!frame)return res.status(404).json({error:'This task has no saved browser frame.'});
   try{
     const {record,bytes}=await requireTenant(req).artifactService.read(frame.data.artifactId);
     if(record.runId!==req.params.runId || !record.mimeType?.startsWith('image/'))return res.status(404).json({error:'Browser frame not found.'});
     res.set('Cache-Control','no-store');
     res.json({ok:true,screenshot:{b64:bytes.toString('base64'),mediaType:record.mimeType}});
   }catch{res.status(404).json({error:'The saved browser frame is no longer available.'})}
 });
 router.get('/:runId/browser/stream',async(req,res)=>{
   const run=res.locals.run;
   const browserStarted=run.events.some((e:any)=>e.type==='tool.started' && String(e.data?.tool??'').startsWith('browser_'));
   if(!browserStarted)return res.status(409).json({error:'No browser has been started by this task.'});
   if(isTerminal(run.status))return res.status(409).json({error:'The cloud browser ended with this run.'});
   res.set({'Content-Type':'text/event-stream','Cache-Control':'no-store, no-transform','X-Accel-Buffering':'no'});res.flushHeaders();
   let closed=false;res.on('close',()=>{closed=true});
   while(!closed){
     const current=requireTenant(req).runStore.get(run.id ?? req.params.runId);
     if(!current || isTerminal(current.status))break;
     try{
       const result=await rpc.execute(req.params.runId,'browser_screenshot',{fullPage:false},10000);
       if(closed)break;
       if(!res.writableNeedDrain)res.write(`data: ${JSON.stringify({ok:result.ok,error:result.error,...result.meta,control:browserControl(req.params.runId)})}\n\n`);
     }catch(error){if(!closed)res.write(`data: ${JSON.stringify({ok:false,error:String(error)})}\n\n`);break}
     if(!closed)await new Promise(resolve=>setTimeout(resolve,800));
   }
   if(!closed)res.end();
 });
 router.post('/:runId/browser/control',(req,res)=>{
   if(isTerminal(res.locals.run.status))return res.status(409).json({error:'The cloud browser ended with this run.'});
   const owner=req.body?.owner;
   if(owner!=='user' && owner!=='orion')return res.status(400).json({error:'Choose user or orion'});
   setBrowserControl(req.params.runId,owner);res.json(browserControl(req.params.runId));
 });
 router.post('/:runId/browser/input',async(req,res)=>{
   if(isTerminal(res.locals.run.status))return res.status(409).json({error:'The cloud browser ended with this run.'});
   if(browserControl(req.params.runId).owner!=='user')return res.status(409).json({error:'Take control first'});
   const body=req.body??{};
   if(!['click','type','key','scroll'].includes(body.type))return res.status(400).json({error:'Unsupported browser input'});
   try{res.json(await rpc.execute(req.params.runId,'browser_input',{type:body.type,x:body.x,y:body.y,text:body.text,key:body.key,deltaY:body.deltaY},15000))}catch(error){res.status(409).json({error:String(error)})}
 });
 router.get('/:runId/files',async(req,res)=>{
   const run=res.locals.run;
   const name=req.query.path===undefined || req.query.list==='1'?'list_directory':'read_file';
   const args={path:String(req.query.path??'.')};
   try{
     const active=!isTerminal(run.status);
     const result=active?await rpc.execute(req.params.runId,name,args,15000):await (name==='read_file'?makeReadFileTool(run.projectRoot):makeListDirectoryTool(run.projectRoot)).execute(args);
     res.status(result.ok?200:409).json(result);
   }catch(error){res.status(409).json({error:String(error)})}
 });
 router.post('/:runId/stop',async(req,res)=>{
   const tenant=requireTenant(req);tenant.agentRuntime.cancel(req.params.runId);tenant.multiAgentRuntime.cancel(req.params.runId);
   clearBrowserControl(req.params.runId);
   const desktop=findSandboxSession(tenant.id,res.locals.run.projectRoot);
   if(desktop)await stopSandboxDesktop(desktop);
   res.json({ok:true});
 });
 return router;
}
