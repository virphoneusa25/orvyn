// Offline cutover tooling. Never pass the live data directory as the source.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {readAuthSnapshot}=require('../dist/identity/AuthStorageSnapshot');
const {readLedgerSnapshot}=require('../dist/billing/LedgerStorageSnapshot');
const {readStripeSnapshot}=require('../dist/billing/StripeStorageSnapshot');
const {readTenantDataSnapshot,PostgresTenantStorage}=require('../dist/persistence/PostgresTenantStorage');
const {readSessionSnapshot,PostgresSessionStorage}=require('../dist/sessions/PostgresSessionStorage');
const {PostgresAuthStorage}=require('../dist/identity/PostgresAuthStorage');
const {PostgresLedgerStorage}=require('../dist/billing/PostgresLedgerStorage');
const {PostgresStripeStorage}=require('../dist/billing/PostgresStripeStorage');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rows=snapshot=>Object.values(snapshot).reduce((n,table)=>n+(Array.isArray(table)?table.length:table.rows.length),0);
const canonical=snapshot=>JSON.stringify(Object.entries(snapshot).sort(([a],[b])=>a.localeCompare(b)).map(([name,table])=>[name,table.columns?.slice().sort(),(Array.isArray(table)?table:table.rows).map(row=>JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a],[b])=>a.localeCompare(b))))).sort()]));
function preflight(source,options={}){
 const root=fs.realpathSync(path.join(source,'sqlite'));
 const manifest=JSON.parse(fs.readFileSync(path.join(source,'manifest.json'),'utf8'));
 if(!Array.isArray(manifest.databases)||!manifest.databases.length)throw new Error('Snapshot database inventory is missing');
 const retained=new Set(options.retain||[]),seen=new Set(),files=new Map();
 for(const name of retained)if(!['execution.sqlite','desktop-releases.db'].includes(name))throw new Error('Only explicitly supported operational stores may be retained');
 for(const item of manifest.databases){
  if(typeof item.path!=='string'||seen.has(item.path))throw new Error('Invalid or duplicate snapshot path');seen.add(item.path);
  const file=fs.realpathSync(path.resolve(root,item.path));
  if(!file.startsWith(root+path.sep)||!fs.statSync(file).isFile()||sha(file)!==item.sha256)throw new Error('Snapshot path or checksum verification failed');
  files.set(item.path,file);
 }
 const inventory=[];
 function scan(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())scan(full);else {
 const name=path.relative(root,full),base=name.replace(/-(wal|shm)$/,'');
 if(files.has(base)&&name.endsWith('-shm'))continue;
 if(files.has(base)&&name.endsWith('-wal')&&fs.statSync(full).size===0)continue;
 inventory.push(name);
 }}}
 scan(root);
 if(inventory.length!==files.size||inventory.some(name=>!files.has(name)))throw new Error('Snapshot contains unlisted files');
 for(const required of ['auth.db','billing.sqlite','payments.sqlite'])if(!files.has(required)||retained.has(required))throw new Error('Required core snapshot is missing or retained');
 const auth=readAuthSnapshot(files.get('auth.db')),ledger=readLedgerSnapshot(files.get('billing.sqlite')),payments=readStripeSnapshot(files.get('payments.sqlite'));
 const tenants=[],sessions=[],excluded=[];
 for(const [name,file]of files){
  if(['auth.db','billing.sqlite','payments.sqlite'].includes(name))continue;
  if(retained.has(name)){excluded.push(name);continue;}
  const session=name.match(/^([A-Za-z0-9_-]+)-sessions\.db$/),tenant=name.match(/^([A-Za-z0-9_-]+)\.db$/);
  if(session)sessions.push({id:session[1],file,snapshot:readSessionSnapshot(file,session[1])});
  else if(tenant)tenants.push({id:tenant[1],file,snapshot:readTenantDataSnapshot(file,tenant[1])});
  else throw new Error('Unclassified database in snapshot; explicitly review retained operational stores');
 }
 for(const name of retained)if(!files.has(name))throw new Error('Retained database is not in the verified inventory');
 const summary={sourceVerified:true,databases:files.size,retainedOperationalDatabases:excluded.length,
  identityRecords:rows(auth),ledgerRecords:rows(ledger),legacyLedgerRecords:Object.entries(ledger).filter(([key])=>key.startsWith("__legacy_")).reduce((n,[,rows])=>n+rows.length,0),paymentRecords:rows(payments),tenantDatabases:tenants.length,sessionDatabases:sessions.length,
  tenantRecords:tenants.reduce((n,t)=>n+rows(t.snapshot),0),sessionRecords:sessions.reduce((n,t)=>n+rows(t.snapshot),0)};
 return {auth,ledger,payments,tenants,sessions,summary,files,manifest};
}
async function migrate(source,url,options={}){
 if(typeof url!=='string'||!url.trim())throw new Error('An explicit PostgreSQL target URL is required');
 if(options.writesPaused!==true)throw new Error('Migration requires an offline snapshot taken with all application writers paused');
 const plan=preflight(source,options); // Validate every source family before opening a target.
 const stores=[new PostgresAuthStorage(url),new PostgresLedgerStorage(url),new PostgresStripeStorage(url)];
 try{
  for(let i=0;i<stores.length;i++){
   const store=stores[i],snapshot=[plan.auth,plan.ledger,plan.payments][i];
   await store.init();await store.importSnapshot(snapshot);if(!(await store.verify(snapshot)).matches)throw new Error('Core migration content parity failed');
  }
  for(const [items,Storage]of [[plan.tenants,PostgresTenantStorage],[plan.sessions,PostgresSessionStorage]]){
   for(const item of items){
    const store=await Storage.connect(url,item.id);
    try{await store.importSqlite(item.file);if(canonical(await store.exportSnapshot())!==canonical(item.snapshot))throw new Error('Tenant/session migration content parity failed');}
    finally{await store.close();}
   }
  }
  for(const item of plan.manifest.databases)if(sha(plan.files.get(item.path))!==item.sha256)throw new Error('Offline source changed during migration');
  return {...plan.summary,completeCoreParity:true,activationPerformed:false};
 }finally{await Promise.allSettled(stores.map(store=>store.close()));}
}
module.exports={preflight,migrate};
if(require.main===module){
 const args=process.argv.slice(2),source=args.find(a=>a.startsWith('--source='))?.slice(9),retain=args.filter(a=>a.startsWith('--retain=')).map(a=>a.slice(9));
 (async()=>{
  if(!source)throw new Error('Usage: migrate-cloud-postgres.cjs --source=OFFLINE_SNAPSHOT [--retain=OPERATIONAL_FILE] [--apply --writes-paused]');
  const result=args.includes('--apply')?await migrate(source,process.env.DATABASE_URL||process.env.ORVYN_PG_URL,{retain,writesPaused:args.includes('--writes-paused')}):preflight(source,{retain}).summary;
  console.log(JSON.stringify(result));
 })().catch(error=>{console.error(error.message);process.exitCode=1;});
}
