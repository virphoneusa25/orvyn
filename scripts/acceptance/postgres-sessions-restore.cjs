const assert=require('node:assert/strict');
const {PostgresWorkSessionStore}=require('../../apps/backend/dist/sessions/PostgresWorkSessionStore.js');
async function main(){
 const store=await PostgresWorkSessionStore.connect(process.env.ORVYN_PG_URL,'ci-session-restore-fixture');
 try{
  if(!process.argv.includes('--verify')){
   const session=await store.create({title:'Restore fixture',userId:'synthetic-user',projectRoot:'/synthetic/project'});
   await store.attachRun(session.sessionId,'ci-restore-run');
   await store.appendMessage(session.sessionId,{messageId:'ci-restore-message',role:'user',content:'Unicode Ω, NUL \0 and literal \\0',meta:{escaped:'\0\\0'}});
   await store.rememberFiles(session.workspaceId,['src/restore.ts']);
  }else{
   const session=await store.sessionOfRun('ci-restore-run');assert.ok(session);
   const message=await store.getMessage('ci-restore-message');assert.equal(message.content,'Unicode Ω, NUL \0 and literal \\0');assert.equal(message.meta.escaped,'\0\\0');
   assert.deepEqual(await store.knownFiles(session.workspaceId),['src/restore.ts']);
   assert.equal((await store.appendMessage(session.sessionId,{role:'assistant',content:'After recovery'})).sequence,2);
  }
  console.log('PostgreSQL session backup/restore fixture passed');
 }finally{await store.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
