import {spawnSync} from 'node:child_process';
import {mkdirSync, existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if(process.platform!=='win32') { console.log('Native desktop helper is currently Windows-only.'); process.exit(0); }
const framework=path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319');
const output=path.join(root,'apps/desktop/resources/native');
mkdirSync(output,{recursive:true});
const compiler=path.join(framework,'csc.exe');
if(!existsSync(compiler)) throw new Error('Windows .NET Framework C# compiler is required to build the native helper.');
const result=spawnSync(compiler,['/nologo','/target:exe','/platform:x64','/optimize+',`/out:${output}/orvyn-native-desktop.exe`, '/r:System.Drawing.dll','/r:System.Web.Extensions.dll',...['UIAutomationClient.dll','UIAutomationTypes.dll','WindowsBase.dll'].map(f=>`/r:${path.join(framework,'WPF',f)}`),path.join(root,'apps/desktop/native/WindowsDesktop.cs')],{stdio:'inherit',windowsHide:true});
process.exit(result.status ?? 1);
