// Exercises only a disposable window created by this test, never user applications.
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(process.platform!=='win32') {console.log('Windows native acceptance skipped on this platform.');process.exit(0);}
const dir=mkdtempSync(path.join(tmpdir(),'native-desktop-fixture-'));
const token=randomBytes(32).toString('hex');
const helper=spawn(path.join(root,'apps/desktop/resources/native/orvyn-native-desktop.exe'),[],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,ORVYN_NATIVE_TOKEN:token}});
const pending=new Map();let sequence=0,fixture;
createInterface({input:helper.stdout}).on('line',line=>{const msg=JSON.parse(line);pending.get(msg.id)?.(msg.result);pending.delete(msg.id);});
async function call(command,auth=token) {
 const id=String(++sequence);
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Helper timed out.'));},10000);
  pending.set(id,result=>{clearTimeout(timer);resolve(result);});
  helper.stdin.write(JSON.stringify({...command,token:auth,id})+'\n');
 });
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try {
 assert.equal((await call({action:'windows'},'wrong-token')).ok,false);
 assert.equal((await call({action:'screenshot',expiresAt:1})).ok,false);
 // Interactive fixture tests are opt-in so headless CI never manipulates a real desktop.
 if(process.argv.includes('--interactive-fixture')) {
  const source=path.join(dir,'Fixture.cs');
  writeFileSync(source,`using System;using System.IO;using System.Windows.Forms;
class Fixture { [STAThread] static void Main(string[] args) {
 var f=new Form {Text="Native Desktop Acceptance Fixture",Width=520,Height=300};
 var text=new TextBox {Name="fixture-input",AccessibleName="Fixture input",Dock=DockStyle.Top};
 var password=new TextBox {AccessibleName="fixture-private",UseSystemPasswordChar=true,Text="never-return-this-password",Dock=DockStyle.Bottom};
 f.Controls.Add(text);f.Controls.Add(password);
 text.TextChanged+=(s,e)=>File.WriteAllText(args[0],text.Text);
 f.Shown+=(s,e)=>{text.Focus();File.WriteAllText(args[1],f.Handle.ToInt64().ToString());};
 var timer=new Timer {Interval=20000};timer.Tick+=(s,e)=>f.Close();timer.Start();Application.Run(f);
}}`);
  const compiler=path.join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const built=spawnSync(compiler,['/nologo','/target:winexe',`/out:${dir}/Fixture.exe`,'/r:System.Windows.Forms.dll','/r:System.Drawing.dll',source],{stdio:'inherit',windowsHide:true});
  assert.equal(built.status,0);
  const output=path.join(dir,'typed.txt'),handle=path.join(dir,'handle.txt');
  fixture=spawn(path.join(dir,'Fixture.exe'),[output,handle],{windowsHide:false,stdio:'ignore'});
  for(let n=0;n<40 && !existsSync(handle);n++) await sleep(100);
  const windows=await call({action:'windows'});
  const target=windows.windows?.find(w=>w.handle===readFileSync(handle,'utf8'));
  assert.ok(target,'Disposable fixture must be an eligible application.');
  const scoped={...target,expiresAt:Date.now()+30000};
  const screenshot=await call({...scoped,action:'screenshot'});
  assert.equal(screenshot.ok,true);assert.equal(screenshot.screenshot.mediaType,'image/png');
  assert.equal(Buffer.from(screenshot.screenshot.b64,'base64').subarray(1,4).toString(),'PNG');
  const controls=await call({...scoped,action:'inspect'});
  assert.equal(controls.ok,true);assert.equal(controls.output.includes('never-return-this-password'),false);
  assert.equal((await call({...scoped,action:'screenshot',started:'wrong'})).ok,false);
  assert.equal((await call({...scoped,action:'screenshot',expiresAt:Date.now()-1})).ok,false);
  assert.equal((await call({...scoped,action:'key',key:'Ctrl+R'})).ok,false);
  assert.equal((await call({...scoped,action:'click',x:-1,y:-1})).ok,false);
  const focused=await call({...scoped,action:'focus'});assert.equal(focused.ok,true);
  const literal='{ENTER}+^% hello';
  const typed=await call({...scoped,action:'type',text:literal});assert.equal(typed.ok,true,typed.error);
  for(let n=0;n<40 && (!existsSync(output)||readFileSync(output,'utf8')!==literal);n++) await sleep(50);
  assert.equal(readFileSync(output,'utf8'),literal,'Typing must be literal Unicode, never SendKeys syntax.');
  console.log('PASS: private fixture capture, accessibility redaction, identity/expiry/input bounds, literal Unicode input.');
 }
 console.log('PASS: helper authentication and missing/expired grant rejection.');
} finally {fixture?.kill();helper.kill();await sleep(100);rmSync(dir,{recursive:true,force:true});}
