const path = require('node:path');
require('esbuild').buildSync({ entryPoints: [path.resolve(__dirname, '../src/localWorker/sandboxToolsEntry.ts')],
  outfile: path.resolve(__dirname, '../dist/localWorker/sandbox-tools.cjs'), platform: 'node', target: 'node22', format: 'cjs', bundle: true });
