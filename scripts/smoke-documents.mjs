import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const dir=await mkdtemp(join(tmpdir(),'orvyn-doc-smoke-'));
const token=randomUUID(); const port=4587;
const backend=spawn(process.execPath,[resolve('apps/backend/dist/index.js')],{cwd:resolve('apps/backend'),env:{...process.env,PORT:String(port),ORVYN_DATA_DIR:join(dir,'data'),ORVYN_API_KEY:token,ORVYN_PROJECTS_DIR:''},windowsHide:true,stdio:'pipe'});
let logs=''; backend.stderr.on('data',data=>logs+=data);
const base=`http://127.0.0.1:${port}/api/v1`;
const headers={'Content-Type':'application/json',Authorization:`Bearer ${token}`};
const html=resolve('apps/desktop/src/renderer/.documents-smoke.html');
const entry=resolve('apps/desktop/src/renderer/.documents-smoke.tsx');
let server,browser;
async function request(path,body){const res=await fetch(base+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined}); const data=await res.json();assert.ok(res.ok,JSON.stringify(data));return data;}
try {
  let ready=false;
  for(let i=0;i<60;i++){try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}
  assert.ok(ready,logs);
  const tools=await request('/tools?projectRoot='+encodeURIComponent(dir));
  assert.ok(tools.tools.some(t=>t.name==='create_document'));
  const input={name:'Product brief.pdf',title:'Product brief',content:'# Purpose\nORVYN creates useful documents.\n# Next steps\n- Review the draft\n- Share the approved result'};
  const denied=await fetch(base+'/tools/create_document/execute',{method:'POST',headers,body:JSON.stringify({args:input})});assert.equal(denied.status,428);
  const result=await request('/tools/create_document/execute',{args:input,approved:true});assert.equal(result.ok,true,JSON.stringify(result));
  const word=await request('/tools/create_document/execute',{args:{...input,name:'Product brief.docx'},approved:true});assert.equal(word.ok,true);
  const list=await request('/documents?projectRoot='+encodeURIComponent(dir));assert.equal(list.documents.length,2);
  const text=await request('/documents/Product%20brief.docx?preview=text&projectRoot='+encodeURIComponent(dir));assert.match(text.text,/useful documents/);
  const file=await fetch(base+'/documents/Product%20brief.pdf?projectRoot='+encodeURIComponent(dir),{headers});const bytes=Buffer.from(await file.arrayBuffer());assert.equal(bytes.subarray(0,4).toString(),'%PDF');
  const extracted=await request('/documents/extract',{name:'Product brief.pdf',b64:bytes.toString('base64')});assert.match(extracted.text,/useful documents/);
  await writeFile(html,'<html><body><div id="root"></div><script type="module" src="/.documents-smoke.tsx"></script></body></html>');
  await writeFile(entry,`import React from 'react';import {createRoot} from 'react-dom/client';import {DocumentsPanel} from './components/DocumentsPanel';import {saveConnectionConfig} from './connection';import './theme.css';window.orvyn={config:{set:async value=>value}};await saveConnectionConfig(${JSON.stringify({backendUrl:base.replace('/api/v1',''),apiKey:token})});createRoot(document.getElementById('root')).render(<div style={{width:440,margin:'20px auto'}}><DocumentsPanel projectRoot={${JSON.stringify(dir)}} revision={0}/></div>);`);
  server=await createServer({configFile:resolve('apps/desktop/vite.config.ts'),server:{host:'127.0.0.1',port:0},logLevel:'error'});await server.listen();
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
  const page=await browser.newPage({viewport:{width:900,height:950}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(server.resolvedUrls.local[0]+'.documents-smoke.html');
  await page.getByRole('button',{name:'Product brief.pdf',exact:true}).click();
  await page.getByText('Page 1 of 1',{exact:true}).waitFor();
  await page.waitForFunction(()=>{const c=document.querySelector('canvas');return c&&c.width>100;});
  await page.screenshot({path:join(tmpdir(),'orvyn-document-preview.png'),fullPage:true});
  await page.getByRole('button',{name:'Product brief.docx',exact:true}).click();
  await page.getByText('Text preview · Download to view the original formatting.').waitFor();
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download Product brief.docx'}).click();assert.equal((await download).suggestedFilename(),'Product brief.docx');
  assert.deepEqual(errors,[]);
  console.log('Document API and UI smoke passed: registered tools, approval gate, creation, extraction, Word text preview, PDF canvas preview, and download.');
} finally {
  await browser?.close();await server?.close();backend.kill();
  await new Promise(resolve=>backend.exitCode!==null?resolve():backend.once('exit',resolve));
  await rm(html,{force:true});await rm(entry,{force:true});await rm(dir,{recursive:true,force:true});
}
