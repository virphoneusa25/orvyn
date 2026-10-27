// Verify the packaged customer application against a hosted backend.
// No inference credential is provided to Windows or the downloaded application.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {spawn} from 'node:child_process';
import {_electron as electron} from 'playwright';
const root=process.cwd();const base=process.env.ORVYN_CLOUD_URL||'https://staging.orvyn.virphoneusa.com';
assert.match(base,/^https:\/\/(staging\.orvyn\.virphoneusa\.com|orvyn\.virphoneusa\.com)$/);
const container=base.includes('staging.')?'backend-staging':'orvyn-backend-1';
const screenshotPath=path.join(root,'desktop-hf-runtime.png');
const diagnosticsPath=path.join(root,'desktop-hf-runtime-diagnostics.json');
const fixtureScript=await readFile(path.join(root,'scripts/acceptance/hosted-release-fixture.cjs'),'utf8');
const sshExecutable=process.platform==='win32'?path.join(process.env.WINDIR||'C:/Windows','System32/OpenSSH/ssh.exe'):'ssh';
async function remote(action,id=''){
 return new Promise((resolve,reject)=>{
 const child=spawn(sshExecutable,['-i',process.env.OVH_SSH_KEY,'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','StrictHostKeyChecking=accept-new','ubuntu@40.160.11.123',`docker exec -i ${container} node - ${action} ${id}`],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 let output='',diagnostic='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>{diagnostic=(diagnostic+b).slice(-16384);});child.stdin.end(fixtureScript);
 child.on('error',()=>reject(new Error('Hosted fixture SSH failed')));child.on('exit',code=>{if(code!==0){
 // Report only fixed categories: remote errors must never leak session/key values.
 const category=/UNPROTECTED|bad permissions|invalid format|Load key/i.test(diagnostic)?'SSH key format/permissions':/Permission denied.*publickey/i.test(diagnostic)?'SSH authentication':/timed out|refused|resolve hostname/i.test(diagnostic)?'SSH connectivity':/Cannot find module/i.test(diagnostic)?'fixture module unavailable':/SQLITE|database is locked/i.test(diagnostic)?'fixture database':/guard|Invalid fixture/i.test(diagnostic)?'fixture ownership guard':'remote fixture execution';
 return reject(new Error(`Hosted fixture ${action} failed (${category}; exit ${code})`));
 }try{resolve(JSON.parse(output.trim()));}catch{reject(new Error('Hosted fixture returned invalid evidence'));}});
 });
}
const fixture=await remote('create');
// Mask the disposable test password so it cannot appear in any CI log.
console.log('::add-mask::'+fixture.password);
let app, window, scratch, turns, telemetry, uiStream, failure, failureStage='launch';
const diagnostics={environment:'packaged Windows Desktop with hosted backend',host:base,stage:failureStage,rendererErrors:[],usage:[],screenshot:null};
try{
 scratch=await mkdtemp(path.join(os.tmpdir(),'orvyn-hosted-desktop-'));
 const env={...process.env,APPDATA:scratch,ORVYN_CLOUD_URL:base};
 for(const key of Object.keys(env))if(/(API_KEY|HF_TOKEN|SSH_PRIVATE_KEY|OVH_SSH_KEY|TOKEN|SECRET)/i.test(key))delete env[key];
 delete env.ELECTRON_RUN_AS_NODE;
 app=await electron.launch({executablePath:path.join(root,'apps/desktop/release/win-unpacked/ORVYN.exe'),env,timeout:60000});
 window=await app.firstWindow();
 window.on('pageerror',error=>diagnostics.rendererErrors.push({category:/network|fetch|socket/i.test(error.message)?'renderer_network_error':'renderer_error'}));
 window.on('console',message=>{if(message.type()==='error')diagnostics.rendererErrors.push({category:'renderer_console_error',line:message.location().lineNumber||undefined});});
 await window.waitForLoadState('domcontentloaded');
 const boot=await window.evaluate(async()=>window.orvyn.config.get());assert.equal(boot.backendUrl,base);assert.equal(boot.apiKey,'');
 assert.equal(await app.evaluate(()=>Boolean(process.env.HUGGINGFACE_API_KEY||process.env.HF_TOKEN)),false);
 // Exercise the actual Desktop sign-in form with this isolated disposable account.
 await window.getByTestId('ob-welcome-signin').click();
 await window.locator('#ob-email').fill(fixture.email);
 await window.locator('#ob-password').fill(fixture.password);
 await window.getByRole('button',{name:'Sign In'}).click();
 await window.locator('[data-testid="onboarding"]').waitFor({state:'detached',timeout:30000});
 failureStage='desktop-visible-stream';
 await window.locator('#ov-mission-input').waitFor({state:'visible',timeout:30000});
 await window.evaluate(()=>{window.__orvynAcceptanceDiagnostics={healthCommit:null,httpStatuses:{},turns:[],uiStream:{progressSamples:[]}};window.__orvynVisibleStreamSamples=[];window.__orvynStreamObserver=new MutationObserver(()=>{const text=Array.from(document.querySelectorAll('.chat-stream__column img[alt="ORION"]')).map(img=>img.parentElement?.innerText||'').join('\n');if(text.includes('ORVYN_DESKTOP_STREAM_OK')){const samples=window.__orvynVisibleStreamSamples;if(samples[samples.length-1]!==text.length)samples.push(text.length);}});window.__orvynStreamObserver.observe(document.body,{subtree:true,childList:true,characterData:true});});
 const uiBefore=await window.evaluate(async base=>{const cfg=await window.orvyn.config.get(),r=await fetch(base+'/api/v1/usage',{headers:{Authorization:'Bearer '+cfg.apiKey}}),data=await r.json();return {status:r.status,ids:(data.events||[]).map(e=>e.id)};},base);
 await window.locator('#ov-mission-input').fill('What are five short labels, with the first exactly ORVYN_DESKTOP_STREAM_OK and the rest A, B, C, and D?');
 await window.locator('#ov-mission-input').press('Control+Enter');
 await window.waitForFunction(()=>Array.from(document.querySelectorAll('.chat-stream__column img[alt="ORION"]')).some(img=>(img.parentElement?.innerText||'').includes('ORVYN_DESKTOP_STREAM_OK')),undefined,{timeout:55000});
 const uiAfter=await window.evaluate(async({base,before})=>{window.__orvynStreamObserver?.disconnect();const cfg=await window.orvyn.config.get(),r=await fetch(base+'/api/v1/usage',{headers:{Authorization:'Bearer '+cfg.apiKey}}),data=await r.json(),ids=new Set(before.ids),assistant=Array.from(document.querySelectorAll('.chat-stream__column img[alt="ORION"]')).map(img=>img.parentElement?.innerText||'').join('\n'),samples=window.__orvynVisibleStreamSamples||[];const uiStream={httpStatus:r.status,progressSamples:samples.length,progressSampleLengths:samples,usageIds:(data.events||[]).filter(e=>!ids.has(e.id)).map(e=>e.id),markerVisible:assistant.includes('ORVYN_DESKTOP_STREAM_OK')};window.__orvynAcceptanceDiagnostics.uiStream=uiStream;return uiStream;},{base,before:uiBefore});
 uiStream=uiAfter;
 assert.equal(uiStream.markerVisible,true);assert.ok(uiStream.usageIds.length>0);assert.ok(uiStream.progressSamples>=2,'Desktop stream did not visibly update progressively');
 failureStage='authenticated-streaming';
 turns=await window.evaluate(async({base,expectedUserId})=>{
 const config=await window.orvyn.config.get(),token=config.apiKey;
 const authResponse=await fetch(base+'/api/v1/auth/me',{headers:{Authorization:'Bearer '+token}}),auth=await authResponse.json();
 if(!authResponse.ok||auth.user?.id!==expectedUserId)throw new Error('Desktop authenticated session did not match the disposable account');
 const health=await(await fetch(base+'/api/v1/health')).json();
 const editRes=await fetch(base+'/api/v1/edit/inline',{method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({selection:'function add(a, b) { return a - b; }',instruction:'Fix subtraction to addition. Return only the corrected function.',filePath:'math.js',language:'JavaScript'})});
 const edit=await editRes.json();if(!editRes.ok)throw new Error('Hosted inline edit failed');
 const diagnostics=window.__orvynAcceptanceDiagnostics||{turns:[]};diagnostics.healthCommit=health.commit;diagnostics.httpStatuses={...diagnostics.httpStatuses,health:200,inlineEdit:editRes.status};diagnostics.turns=[];window.__orvynAcceptanceDiagnostics=diagnostics;
 const safeId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value)?value:undefined;
 const errorCategory=(code,error)=>{if(/^CREDITS_/.test(code||''))return'billing_rejected';if(code==='TICKET_EXPIRED'||code==='SESSION_EXPIRED')return'authentication_expired';if(/not verified|unverified|unsupported|not available|not found|inaccessible/i.test(error||''))return'model_unavailable_or_unverified';if(/timeout|timed out|stopped responding/i.test(error||''))return'provider_or_stream_timeout';if(/rate limit|429|provider|inference|HTTP 5\d\d/i.test(error||''))return'provider_failure';if(/tenant|permission|authorization/i.test(error||''))return'authorization_failure';return'backend_stream_error';};
 async function turn(model='auto',cancel=false,prompt='',surface='desktop'){return new Promise((resolve,reject)=>{
 const ws=new WebSocket(base.replace(/^http/,'ws')+'/ws/chat?token='+encodeURIComponent(token));let route,text='',eventTypes=[];const record={requestedModel:model==='auto'?'auto':model,surface,state:'connecting',eventTypes};diagnostics.turns.push(record);const timer=setTimeout(()=>{record.state=ws.readyState===WebSocket.OPEN?'open':'not_open';record.errorCategory='stream_timeout';ws.close();reject(new Error('Hosted Desktop stream timed out'));},55000);
 ws.onopen=()=>{record.state='open';};ws.onclose=ev=>{record.closed={code:ev.code,clean:ev.wasClean};};
 ws.onmessage=ev=>{let c;try{c=JSON.parse(ev.data);}catch{clearTimeout(timer);record.errorCategory='invalid_stream_frame';reject(new Error('Hosted Desktop stream returned an invalid frame'));return;}const kind=c.type|| (c.done?'done':c.heartbeat?'heartbeat':c.activity?'activity':c.toolCall?'tool_call':c.routing?'routing':c.delta?'delta':'other');eventTypes.push(String(kind).slice(0,40));record.missionId ||= safeId(c.missionId||c.runId);record.eventId ||= safeId(c.eventId||c.id);record.correlationId ||= safeId(c.correlationId||c.requestId);if(c.type==='connection.ready'){record.connectionAcknowledged=true;ws.send(JSON.stringify({task:prompt?'chat':'code',surface,history:prompt.includes('Asterisk')?[{role:'user',content:'Tell me about VirPhone.'}]:[],userMessage:prompt||(cancel?'List the first 10000 positive integers, one per line.':'Reply with a short greeting.'),requestedModelId:model}));}if(c.routing){route={provider:c.routing.provider,modelId:c.routing.modelId,reason:c.routing.reason};record.route=route;}if(c.delta){text+=c.delta;if(cancel){clearTimeout(timer);record.state='cancelled_after_first_delta';ws.close();resolve({route,cancelled:true});}}if(c.done){clearTimeout(timer);record.finalState=c.error?'failed':'completed';record.responseChars=text.length;record.errorCode=typeof c.code==='string'&&/^[A-Z0-9_]{2,64}$/.test(c.code)?c.code:undefined;record.errorCategory=c.error?errorCategory(record.errorCode,String(c.error).slice(0,300)):undefined;ws.close();if(c.error)reject(new Error('Hosted Desktop stream failed'));else resolve({route,hasText:Boolean(text),text});}};ws.onerror=()=>{clearTimeout(timer);record.errorCategory='websocket_transport_error';reject(new Error('Hosted Desktop websocket failed'));};
 });}
 async function trackedTurn(prompt,surface){const usageUrl=base+'/api/v1/usage';const headers={Authorization:'Bearer '+token};const before=await(await fetch(usageUrl,{headers})).json();const ids=new Set((before.events||[]).map(e=>e.id));const result=await turn('auto',false,prompt,surface);await new Promise(r=>setTimeout(r,150));const after=await(await fetch(usageUrl,{headers})).json();return {...result,surface,usageIds:(after.events||[]).filter(e=>!ids.has(e.id)).map(e=>e.id)};}
 const auto=await turn();const pinned=await turn('hf:moonshotai/Kimi-K2.7-Code:deepinfra');
 const writing=[];const research=[];
 for(const surface of ['desktop','cloud']){writing.push(await trackedTurn('Write a two-sentence marketing caption for an ORVYN coding assistant. No browsing is needed.',surface));research.push(await trackedTurn('Explain Asterisk VoIP briefly, focusing on Asterisk itself.',surface));}
 const cancelled=await turn('auto',true);
 await new Promise(r=>setTimeout(r,2000));const response=await fetch(base+'/api/v1/usage',{headers:{Authorization:'Bearer '+token}});const usage=await response.json();
 diagnostics.httpStatuses.usage=response.status;
 return {health,login:{authenticated:true,status:authResponse.status},edit:auto&&edit.edited,auto,pinned,writing,research,cancelled,usage:usage.events,diagnostics};
 },{base,expectedUserId:fixture.userId});
 assert.match(turns.edit,/return\s+(a\s*\+\s*b|b\s*\+\s*a)/);
 assert.equal(turns.login.authenticated,true);
 assert.equal(turns.auto.route?.provider,'ORVYN');assert.match(turns.auto.route?.modelId,/^ORVYN/);assert.equal(turns.auto.hasText,true);
 assert.equal(turns.pinned.route?.reason,'Explicit model selection');assert.equal(turns.cancelled.cancelled,true);
 assert.doesNotMatch(JSON.stringify([turns.auto.route,turns.pinned.route,turns.writing.map(t=>t.route),turns.research.map(t=>t.route),turns.cancelled.route,turns.usage]),/huggingface|nebius|fireworks|deepinfra|deepseek|cheaperinference|zai-org|moonshotai/i);
 assert.ok(turns.writing.every(t=>t.hasText));assert.ok(turns.research.every(t=>/asterisk/i.test(t.text)&&!/virphone/i.test(t.text)));
 // Actual identity is verified over the existing operator SSH path, never
 // returned through the customer API or injected into the renderer.
 telemetry=await remote('telemetry',fixture.userId);const streams=telemetry.events.filter(e=>e.ok&&e.method==='stream');
 assert.ok(streams.length>=6);assert.equal(streams[0].provider,'huggingface');assert.equal(streams[0].modelId,'hf:moonshotai/Kimi-K2.7-Code:deepinfra');
 assert.equal(streams[1].provider,'huggingface');assert.equal(streams[1].modelId,'hf:moonshotai/Kimi-K2.7-Code:deepinfra');
 for(const writing of turns.writing){const events=streams.filter(e=>writing.usageIds.includes(e.id));assert.ok(events.length>0);assert.ok(events.every(e=>e.provider==='deepseek'));}
 assert.ok(streams.every(e=>e.billingRecorded&&e.creditsCharged>0&&e.providerCostUsd>0));
 assert.ok(turns.usage.some(e=>e.ok&&e.method==='stream'));assert.ok(turns.usage.some(e=>!e.ok&&e.method==='stream'));assert.ok(turns.usage.some(e=>e.ok&&e.method==='generate'));
 failureStage='acceptance-assertions-passed';
 console.log(JSON.stringify({environment:'packaged Windows Desktop with hosted backend',host:base,commit:turns.health.commit,passed:true,customerProviderIdentityHidden:true,visibleDesktopStream:uiStream,auto:streams[0],pinned:streams[1],cancellation:true,inferenceSecretsInApp:false,usage:telemetry.events}));
}catch(error){if(!failure)failure=error;if(window&&!diagnostics.desktop)diagnostics.desktop=await window.evaluate(()=>window.__orvynAcceptanceDiagnostics||null).catch(()=>null);}
finally{
 diagnostics.stage=failure?failureStage:'passed';
 if(app){try{if(!diagnostics.desktop)diagnostics.desktop=await window.evaluate(()=>window.__orvynAcceptanceDiagnostics||null).catch(()=>null);await window.screenshot({path:screenshotPath,timeout:15000});diagnostics.screenshot='captured';}catch{diagnostics.screenshot='capture_failed';}try{await app.close();}catch{}}
 try{telemetry=await remote('telemetry',fixture.userId);diagnostics.usage=(telemetry.events||[]).map(e=>({id:e.id,provider:e.provider,modelId:e.modelId,method:e.method,ok:e.ok,promptTokens:e.promptTokens,completionTokens:e.completionTokens,billingRecorded:e.billingRecorded,creditsCharged:e.creditsCharged,providerCostUsd:e.providerCostUsd,errorCategory:e.errorCategory}));}catch{diagnostics.usageCapture='unavailable';}
 try{await writeFile(diagnosticsPath,JSON.stringify(diagnostics,null,2));}catch{}
 try{const result=await remote('cleanup',fixture.userId);assert.equal(result.fixtureCleaned,true);console.log(JSON.stringify(result));}catch(error){if(!failure)failure=error;}
 if(scratch)await rm(scratch,{recursive:true,force:true}).catch(()=>{});
}
if(failure){const failureCategory=diagnostics.desktop?.turns?.map(t=>t.errorCategory).find(Boolean)||'acceptance_assertion_failed';console.error(JSON.stringify({event:'desktop.acceptance.failed',stage:diagnostics.stage,errorCategory:failureCategory,diagnosticsPath,screenshot:diagnostics.screenshot}));throw new Error(`Hosted Desktop verification failed at ${failureStage}; sanitized evidence saved`);}
