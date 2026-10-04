// Verify the packaged customer application against a hosted backend.
// No inference credential is provided to Windows or the downloaded application.
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {spawn} from 'node:child_process';
import {_electron as electron} from 'playwright';
const root=process.cwd();const base=process.env.ORVYN_CLOUD_URL||'https://staging.orvyn.virphoneusa.com';
assert.match(base,/^https:\/\/(staging\.orvyn\.virphoneusa\.com|orvyn\.virphoneusa\.com)$/);
const container=base.includes('staging.')?'backend-staging':'orvyn-backend-1';
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
// Mask the test account session as defense in depth, never print its value elsewhere.
console.log('::add-mask::'+fixture.token);
const scratch=await mkdtemp(path.join(os.tmpdir(),'orvyn-hosted-desktop-'));
const env={...process.env,APPDATA:scratch,ORVYN_CLOUD_URL:base};
for(const key of Object.keys(env))if(/(API_KEY|HF_TOKEN|SSH_PRIVATE_KEY|OVH_SSH_KEY|TOKEN|SECRET)/i.test(key))delete env[key];
delete env.ELECTRON_RUN_AS_NODE;
let app;
try{
 app=await electron.launch({executablePath:path.join(root,'apps/desktop/release/win-unpacked/ORVYN.exe'),env,timeout:60000});
 const window=await app.firstWindow();await window.waitForLoadState('domcontentloaded');
 const boot=await window.evaluate(async()=>window.orvyn.config.get());assert.equal(boot.backendUrl,base);assert.equal(boot.apiKey,'');
 assert.equal(await app.evaluate(()=>Boolean(process.env.HUGGINGFACE_API_KEY||process.env.HF_TOKEN)),false);
 // Use the same encrypted account-session settings and renderer transport as sign-in.
 await window.evaluate(async({base,token})=>{await window.orvyn.config.set({backendUrl:base,apiKey:token});},{base,token:fixture.token});
 const turns=await window.evaluate(async({base,token})=>{
 const health=await(await fetch(base+'/api/v1/health')).json();
 const editRes=await fetch(base+'/api/v1/edit/inline',{method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({selection:'function add(a, b) { return a - b; }',instruction:'Fix subtraction to addition. Return only the corrected function.',filePath:'math.js',language:'JavaScript'})});
 const edit=await editRes.json();if(!editRes.ok)throw new Error('Hosted inline edit failed');
 async function turn(model='auto',cancel=false,prompt='',surface='desktop'){return new Promise((resolve,reject)=>{
 const ws=new WebSocket(base.replace(/^http/,'ws')+'/ws/chat?token='+encodeURIComponent(token));let route,text='';const timer=setTimeout(()=>{ws.close();reject(new Error('Hosted Desktop stream timed out'));},55000);
 ws.onmessage=ev=>{const c=JSON.parse(ev.data);if(c.type==='connection.ready')ws.send(JSON.stringify({task:prompt?'chat':'code',surface,history:prompt.includes('Asterisk')?[{role:'user',content:'Tell me about VirPhone.'}]:[],userMessage:prompt||(cancel?'List the first 10000 positive integers, one per line.':'Reply with a short greeting.'),requestedModelId:model}));if(c.routing)route=c.routing;if(c.delta){text+=c.delta;if(cancel){clearTimeout(timer);ws.close();resolve({route,cancelled:true});}}if(c.done){clearTimeout(timer);ws.close();if(c.error)reject(new Error('Hosted Desktop stream failed'));else resolve({route,hasText:Boolean(text),text});}};ws.onerror=()=>{clearTimeout(timer);reject(new Error('Hosted Desktop websocket failed'));};
 });}
 async function trackedTurn(prompt,surface){const usageUrl=base+'/api/v1/usage';const headers={Authorization:'Bearer '+token};const before=await(await fetch(usageUrl,{headers})).json();const ids=new Set((before.events||[]).map(e=>e.id));const result=await turn('auto',false,prompt,surface);await new Promise(r=>setTimeout(r,150));const after=await(await fetch(usageUrl,{headers})).json();return {...result,surface,usageIds:(after.events||[]).filter(e=>!ids.has(e.id)).map(e=>e.id)};}
 const auto=await turn();const pinned=await turn('hf:zai-org/GLM-5.3:deepinfra');
 const writing=[];const research=[];
 for(const surface of ['desktop','cloud']){writing.push(await trackedTurn('Write a two-sentence marketing caption for an ORVYN coding assistant. No browsing is needed.',surface));research.push(await trackedTurn('Explain Asterisk VoIP briefly, focusing on Asterisk itself.',surface));}
 const cancelled=await turn('auto',true);
 await new Promise(r=>setTimeout(r,2000));const response=await fetch(base+'/api/v1/usage',{headers:{Authorization:'Bearer '+token}});const usage=await response.json();
 return {health,edit:auto&&edit.edited,auto,pinned,writing,research,cancelled,usage:usage.events};
 },{base,token:fixture.token});
 assert.match(turns.edit,/return\s+(a\s*\+\s*b|b\s*\+\s*a)/);
 assert.equal(turns.auto.route?.provider,'ORVYN');assert.match(turns.auto.route?.modelId,/^ORVYN/);assert.equal(turns.auto.hasText,true);
 assert.equal(turns.pinned.route?.reason,'Explicit model selection');assert.equal(turns.cancelled.cancelled,true);
 assert.doesNotMatch(JSON.stringify([turns.auto.route,turns.pinned.route,turns.writing.map(t=>t.route),turns.research.map(t=>t.route),turns.cancelled.route,turns.usage]),/huggingface|nebius|fireworks|deepinfra|deepseek|cheaperinference|zai-org|moonshotai/i);
 assert.ok(turns.writing.every(t=>t.hasText));assert.ok(turns.research.every(t=>/asterisk/i.test(t.text)&&!/virphone/i.test(t.text)));
 // Actual identity is verified over the existing operator SSH path, never
 // returned through the customer API or injected into the renderer.
 const telemetry=await remote('telemetry',fixture.userId);const streams=telemetry.events.filter(e=>e.ok&&e.method==='stream');
 assert.ok(streams.length>=6);assert.equal(streams[0].provider,'huggingface');assert.equal(streams[0].modelId,'hf:moonshotai/Kimi-K2.7-Code:deepinfra');
 assert.equal(streams[1].provider,'huggingface');assert.equal(streams[1].modelId,'hf:zai-org/GLM-5.3:deepinfra');
 for(const writing of turns.writing){const events=streams.filter(e=>writing.usageIds.includes(e.id));assert.ok(events.length>0);assert.ok(events.every(e=>e.provider==='deepseek'));}
 assert.ok(streams.every(e=>e.billingRecorded&&e.creditsCharged>0&&e.providerCostUsd>0));
 assert.ok(turns.usage.some(e=>e.ok&&e.method==='stream'));assert.ok(turns.usage.some(e=>!e.ok&&e.method==='stream'));assert.ok(turns.usage.some(e=>e.ok&&e.method==='generate'));
 await window.screenshot({path:path.join(root,'desktop-hf-runtime.png')});
 console.log(JSON.stringify({environment:'packaged Windows Desktop with hosted backend',host:base,commit:turns.health.commit,passed:true,customerProviderIdentityHidden:true,auto:streams[0],pinned:streams[1],cancellation:true,inferenceSecretsInApp:false,usage:telemetry.events}));
}finally{if(app)await app.close();const result=await remote('cleanup',fixture.userId);assert.equal(result.fixtureCleaned,true);console.log(JSON.stringify(result));}
