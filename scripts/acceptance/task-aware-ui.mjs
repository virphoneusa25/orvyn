// Deterministic server rendering: no Electron, capture, input, provider or network.
import {build} from 'esbuild';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const root=process.cwd(),output=join(mkdtempSync(join(tmpdir(),'orvyn-ui-mock-')),'fixture.cjs');
await build({stdin:{contents:`import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {DesktopView} from './apps/desktop/src/renderer/components/workspace/DesktopView';import {CloudWorkbench} from './apps/web/src/components/CloudWorkbench';globalThis.window={};console.log('SSR mock surfaces');export const desktop=renderToStaticMarkup(React.createElement(DesktopView,{active:false,projectRoot:'fixture'}));export const cloud=renderToStaticMarkup(React.createElement(CloudWorkbench,{}));`,resolveDir:root,loader:'tsx'},outfile:output,bundle:true,platform:'node',format:'cjs',loader:{'.css':'empty','.webm':'dataurl','.png':'dataurl'},logLevel:'silent'});
const {desktop,cloud}=createRequire(import.meta.url)(output);
assert.match(desktop,/This computer/);assert.doesNotMatch(desktop,/Cloud Desktop|virtual desktop|Cloud sandbox/i);
for(const label of ['Browser','Desktop','Code','Files','Terminal'])assert.ok(cloud.includes('>'+label+'</button>'),label);
assert.doesNotMatch(cloud,/<textarea/);assert.match(cloud,/Cloud sandbox/);
console.log('PASS: Desktop exposes local computer only; Cloud preserves all workspace tabs and a single chat surface.');
