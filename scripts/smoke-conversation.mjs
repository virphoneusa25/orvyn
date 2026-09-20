import { createServer } from 'vite';
import { chromium } from 'playwright';
import { writeFile, rm, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

// Render the production components with deterministic event fixtures; no model/account required.
const root = resolve('apps/desktop/src/renderer');
const html = resolve(root, '.conversation-smoke.html');
const entry = resolve(root, '.conversation-smoke.tsx');
let server;
let browser;
try {
  await writeFile(html, '<html><head><meta name="viewport" content="width=device-width,initial-scale=1" /></head><body><div id="root"></div><script type="module" src="/.conversation-smoke.tsx"></script></body></html>');
  await writeFile(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AgentActivityList } from './components/AgentActivityList';
import './theme.css';
let sequence = 0;
const ev = (type, data = {}) => ({ id: String(sequence), sequence: sequence++, timestamp: Date.now(), type, data, runId: 'fixture' });
const events = [
 ev('message.delta', { content: "I'll update the validation and check that both the Python worker and JavaScript client handle empty input." }), ev('message.completed'),
 ev('tool.started', {callId:'py',tool:'edit_file'}), ev('tool.input',{callId:'py',input:{path:'src/worker/validate.py'}}), ev('file.edit',{path:'src/worker/validate.py',preview:{additions:12,deletions:3}}), ev('tool.completed',{callId:'py'}),
 ev('tool.started', {callId:'js',tool:'edit_file'}), ev('tool.input',{callId:'js',input:{path:'src/client/validation.js'}}), ev('tool.completed',{callId:'js'}),
 ev('message.delta', {content:'Both changes are in place. I’m running the tests now.'}), ev('message.completed'),
 ev('tool.started',{callId:'cmd',tool:'terminal'}), ev('tool.input',{callId:'cmd',input:{command:'python -m pytest tests/validation -v'}}), ev('terminal.output',{callId:'cmd',data:'tests/validation/test_empty.py PASSED\\n12 passed in 0.42s'}), ev('tool.completed',{callId:'cmd',preview:'12 passed in 0.42s'}), ev('thinking')
];
createRoot(document.getElementById('root')).render(<main style={{maxWidth:800,margin:'30px auto',padding:20}}><AgentActivityList events={events} status="running" onApprove={() => {}} /></main>);
`);
  server = await createServer({ configFile: resolve('apps/desktop/vite.config.ts'), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${server.resolvedUrls.local[0]}.conversation-smoke.html`);
  await page.getByText('Thinking…', { exact: true }).waitFor();
  assert.equal(await page.getByRole('img', {name:'Python',exact:true}).count(), 1);
  assert.equal(await page.getByRole('img', {name:'JavaScript',exact:true}).count(), 1);
  const output = page.getByRole('button', {name:'Show output'});
  await output.focus();
  await page.keyboard.press('Enter');
  await page.getByText('tests/validation/test_empty.py PASSED', {exact:false}).waitFor();
  assert.equal(await page.getByRole('button', {name:'Hide output'}).getAttribute('aria-expanded'), 'true');
  const dir = resolve(tmpdir(), 'orvyn-conversation-smoke');
  await mkdir(dir, {recursive:true});
  await page.screenshot({path:resolve(dir,'desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal page overflow');
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.locator('.activity-pulse').evaluate(el => getComputedStyle(el).animationName), 'none');
  await page.screenshot({path:resolve(dir,'narrow.png'),fullPage:true});
  assert.deepEqual(errors, []);
  console.log(`Conversation smoke passed: icons, keyboard output toggle, narrow layout, reduced motion, no runtime errors. Screenshots: ${dir}`);
} finally {
  await browser?.close();
  await server?.close();
  await rm(html, {force:true});
  await rm(entry, {force:true});
}
