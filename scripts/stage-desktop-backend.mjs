import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stage=resolve(root,'apps/desktop/resources/backend');
if (stage !== resolve(root, 'apps/desktop/resources/backend')) throw new Error('Invalid staging directory');
await rm(stage,{recursive:true,force:true});
await mkdir(stage,{recursive:true});
const backend=JSON.parse(await readFile(resolve(root,'apps/backend/package.json'),'utf8'));
const workspace=JSON.parse(await readFile(resolve(root,'package.json'),'utf8'));
await writeFile(resolve(stage,'package.json'),JSON.stringify({name:'orvyn-local-engine',version:backend.version,private:true,dependencies:{...backend.dependencies,'@orvyn/ai-core':'file:./packages/ai-core'},overrides:workspace.overrides},null,2));
await cp(resolve(root,'apps/backend/dist'),resolve(stage,'dist'),{recursive:true,force:true});
await mkdir(resolve(stage,'packages/ai-core'),{recursive:true});
await cp(resolve(root,'packages/ai-core/dist'),resolve(stage,'packages/ai-core/dist'),{recursive:true,force:true});
await cp(resolve(root,'packages/ai-core/package.json'),resolve(stage,'packages/ai-core/package.json'),{force:true});
for (const name of ['skills','imported-skills']) {
  await cp(resolve(root,'resources',name),resolve(stage,'resources',name),{recursive:true});
}
const revision=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'});
const sha=process.env.ORVYN_BUILD_SHA || revision.stdout?.trim();
if (!sha) throw new Error('Desktop build requires a source revision');
await writeFile(resolve(stage,'build-info.json'),JSON.stringify({commit:sha,builtAt:new Date().toISOString()},null,2));
const result=spawnSync(process.platform==='win32'?'npm.cmd':'npm',['install','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:stage,stdio:'inherit',shell:process.platform==='win32'});
if(result.status!==0)process.exit(result.status??1);
await cp(process.execPath,resolve(stage,process.platform==='win32'?'node.exe':'node'),{force:true});
console.log('Staged self-contained local engine with Node and production dependencies.');
