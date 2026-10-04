// Server-side, bounded release fixture. Session credentials are returned only to
// the CI test process; inference keys never leave the server.
const {randomUUID,randomBytes}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const fs=require('node:fs');const path=require('node:path');
const root=process.env.ORVYN_RELEASE_DIST||'/app/dist';
const {AuthService}=require(root+'/auth/AuthService.js');
const {defaultDataDir}=require(root+'/persistence/LocalStore.js');
const {LEGAL_VERSION}=require(root+'/legal/documents.js');
const {onboardingStore}=require(root+'/onboarding/OnboardingStore.js');
const {creditLedger}=require(root+'/billing/creditLedgerInstance.js');
const data=defaultDataDir();const action=process.argv[2]||'create';
if(action==='create'){
 const auth=new AuthService();const tag=randomUUID();
 const account=auth.register('release-smoke-'+tag+'@example.invalid',randomBytes(32).toString('hex'),'Release Verification','isolated Windows release verification');
 auth.markEmailVerified(account.user.id);auth.acceptLegal(account.user.id,LEGAL_VERSION,'release-verification');
 onboardingStore().ensure(account.user.id,'complete');onboardingStore().update(account.user.id,{step:'complete'});
 const tenantId=account.organization.tenantId;
 creditLedger.setPlan(tenantId,'starter',Date.now(),'release-verification');
 fs.writeFileSync(path.join(data,'release-smoke-'+account.user.id+'.json'),JSON.stringify({userId:account.user.id,tenantId,organizationId:account.organization.id,createdAt:Date.now()}),{mode:0o600});
 console.log(JSON.stringify({token:account.token,userId:account.user.id,tenantId,organizationId:account.organization.id}));auth.close();creditLedger.close();
}else if(action==='cleanup'||action==='telemetry'){
 const id=process.argv[3];if(!/^[a-f0-9-]{36}$/.test(id||''))throw new Error('Invalid fixture id');
 const marker=path.join(data,'release-smoke-'+id+'.json');const fixture=JSON.parse(fs.readFileSync(marker,'utf8'));
 const auth=new DatabaseSync(path.join(data,'auth.db'));auth.exec('PRAGMA busy_timeout=5000');
 const user=auth.prepare('SELECT email FROM users WHERE id=?').get(id);
 if(!user||!/^release-smoke-[a-f0-9-]{36}@example\.invalid$/.test(user.email)||fixture.userId!==id)throw new Error('Fixture ownership guard failed');
 const org=auth.prepare('SELECT tenant_id FROM organizations WHERE id=? AND kind=?').get(fixture.organizationId,'personal');
 if(!org||org.tenant_id!==fixture.tenantId||auth.prepare('SELECT count(*) AS n FROM organization_members WHERE organization_id=?').get(fixture.organizationId).n!==1)throw new Error('Fixture organization guard failed');
 if(action==='telemetry'){
  const usage=new DatabaseSync(path.join(data,fixture.tenantId+'.db'),{readOnly:true});usage.exec('PRAGMA busy_timeout=5000');
  const events=usage.prepare('SELECT provider,model_id AS modelId,method,ok,prompt_tokens AS promptTokens,completion_tokens AS completionTokens FROM usage_events WHERE ts>=? ORDER BY ts ASC').all(fixture.createdAt);
  console.log(JSON.stringify({events}));usage.close();auth.close();creditLedger.close();return;
 }
 const clean=(db,keys)=>{
 db.exec('BEGIN IMMEDIATE');try{for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()){
 const columns=new Set(db.prepare('PRAGMA table_info("'+name+'")').all().map(c=>c.name));
 for(const [column,value]of keys)if(columns.has(column))db.prepare('DELETE FROM "'+name+'" WHERE "'+column+'"=?').run(value);
 }db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}};
 clean(auth,[['user_id',id],['tenant_id',fixture.tenantId],['organization_id',fixture.organizationId]]);
 auth.prepare('DELETE FROM organizations WHERE id=?').run(fixture.organizationId);auth.prepare('DELETE FROM users WHERE id=?').run(id);auth.close();
 // Billing records are an immutable audit trail. Keep the bounded fixture's
 // usage/grant records; remove its sign-in access and tenant data only.
 for(const suffix of ['.db','.db-wal','.db-shm'])fs.rmSync(path.join(data,fixture.tenantId+suffix),{force:true});
 fs.rmSync(marker);console.log(JSON.stringify({fixtureCleaned:true}));creditLedger.close();
}else throw new Error('Unknown fixture action');
