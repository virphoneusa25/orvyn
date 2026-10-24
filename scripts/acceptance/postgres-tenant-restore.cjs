// Synthetic retained tenant fixture for the PostgreSQL dump/restore drill.
const assert=require('node:assert/strict');
const {PostgresTenantStore}=require('../../apps/backend/dist/persistence/PostgresTenantStore');
const {PostgresTenantStorage}=require('../../apps/backend/dist/persistence/PostgresTenantStorage');
const {McpHardening}=require('../../apps/backend/dist/mcp/hardening/hardening');
const {MarketplaceService}=require('../../apps/backend/dist/mcp/marketplace/service');
const manager={listServers:()=>[],searchTools:()=>[],statuses:()=>[]};
const {McpRegistry}=require('../../apps/backend/dist/mcp/McpRegistry');
const tenant='ci-tenant-restore-fixture',content='Restored Unicode 🌲 and NUL\0 and literal \\0';
(async()=>{
 const store=await PostgresTenantStore.connect(process.env.ORVYN_PG_URL,tenant);
 const migration=await PostgresTenantStorage.connect(process.env.ORVYN_PG_URL,tenant);
 try{
  if(!process.argv.includes('--verify')){
   await store.saveMission({id:'mission',runId:'run',projectRoot:content,goal:content,status:'completed',reviewCycles:1,createdAt:1700000000000,updatedAt:1700000000001,tasks:[]});
   const event={id:'usage',timestamp:1700000000000,modelId:'fixture',provider:'fixture',method:'generate',durationMs:1,ok:true};
   await store.saveUsageEvent(event);await store.enqueueBilling(event,false);
   await store.setSetting('fixture',content);
   const registry=new McpRegistry(store,tenant);await registry.ready;
   await registry.upsert({id:'mcp-fixture',name:'fixture',enabled:false,transport:'http',url:'https://fixture.invalid',createdAt:1,updatedAt:1},store);
   await registry.setPolicy('mcp-fixture',{serverDefaults:{READ:'DENY'},toolOverrides:{}},store);
   const harden=new McpHardening({},store,tenant);await harden.ready;
   await harden.setPolicy({mode:'allowlist-only',allowlist:['mcp-fixture']});
   await harden.appendAudit('fixture',{serverId:'mcp-fixture',token:'redacted'});
   const market=new MarketplaceService(manager,store,tenant);await market.ready;
   await market.upsertPrivateRegistry({id:'fixture',name:'fixture',enabled:false,url:'https://fixture.invalid'});
   market.cache.set('fixture',{name:'public listing'});await market.flushPersistence();
   await store.saveMemory({id:'memory',scope:'global',kind:'fixture',title:content,content});
   await store.saveArtifactStrict({id:'artifact',kind:'file',name:content,path:content,tenantId:tenant});
   await store.saveModel({id:'my:fixture',name:content});
   await store.saveLearningRecord({id:'learning',kind:'fixture',payload:{content}});
   await store.saveMissionCheckpoint('run',{content},'DONE');
   await store.savePreviewEnvironment({id:'preview',runId:'run',url:content,status:'ready'});
   await store.saveBlobRow({key:'blob',sha256:'hash',mediaType:'image/png',size:12,path:content,runId:'run'});
  }
  const snapshot=await migration.exportSnapshot();
  assert.equal(Object.keys(snapshot).length,11);
  for(const [name,table] of Object.entries(snapshot))assert.equal(table.rows.length,name==='settings'?6:1);
  assert.equal(await store.getSetting('fixture'),content);
  const restoredRegistry=new McpRegistry(store,tenant);await restoredRegistry.ready;
  assert.equal(restoredRegistry.list()[0].id,'mcp-fixture');
  assert.equal(restoredRegistry.policy('mcp-fixture').serverDefaults.READ,'DENY');
  const harden=new McpHardening({},store,tenant);await harden.ready;
  assert.equal(harden.policy().mode,'allowlist-only');
  assert.equal(harden.readAudit()[0].token,'[redacted]');
  const market=new MarketplaceService(manager,store,tenant);await market.ready;
  assert.equal(market.listPrivateRegistries()[0].id,'fixture');
  assert.deepEqual(market.cache.get('fixture').payload,{name:'public listing'});
  assert.equal((await store.getMemory('memory')).content,content);
  assert.equal((await store.getArtifact('artifact')).name,content);
  assert.deepEqual(await store.loadMissionCheckpoint('run'),{content});
  assert.equal((await store.pendingBilling())[0].event.id,'usage');
  console.log(JSON.stringify({tenantFixtureVerified:true,tables:11,restored:process.argv.includes('--verify')}));
 }finally{await store.close();await migration.close();}
})().catch(()=>{console.error('Tenant restore fixture failed');process.exitCode=1;});
