// Use a verified, frozen SQLite backup; never pass a live changing database.
const {readSandboxSnapshot,sandboxFingerprint}=require('../dist/execution/sandbox/SandboxSnapshot');
const {PostgresSandboxDatabase}=require('../dist/execution/sandbox/PostgresSandboxDatabase');
async function main(){
 const args=process.argv.slice(2),source=args.find(a=>a.startsWith('--source='))?.slice(9);
 if(!source||!args.includes('--apply')||args.some(a=>a!=='--apply'&&!a.startsWith('--source=')))throw new Error('Explicit --source=<frozen-backup-file> --apply required');
 const url=process.env.DATABASE_URL||process.env.ORVYN_PG_URL;if(!url)throw new Error('PostgreSQL URL required');
 const snapshot=readSandboxSnapshot(source),database=await PostgresSandboxDatabase.connect(url);
 try{await database.importSnapshot(snapshot);if(sandboxFingerprint(await database.exportSnapshot())!==sandboxFingerprint(snapshot))throw new Error('Execution parity failed');console.log(JSON.stringify({executionMigrationVerified:true,records:Object.fromEntries(Object.entries(snapshot).map(([k,v])=>[k,v.length]))}));}finally{await database.close();}
}
main().catch(()=>{console.error('Execution migration failed; source retained and cutover must remain disabled');process.exitCode=1});
