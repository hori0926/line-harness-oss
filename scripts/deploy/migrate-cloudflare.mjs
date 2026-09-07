#!/usr/bin/env node
// Bootstrap empty D1; use the ledger only for an already-managed installation.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const database = process.env.D1_DATABASE_NAME;
if (!database) throw new Error('D1_DATABASE_NAME is required');
if (!process.argv.includes('--remote')) throw new Error('Pass --remote explicitly');
const run = args => execFileSync('pnpm', ['exec','wrangler','d1','execute',database,'--remote','--yes',...args], {encoding:'utf8',maxBuffer:16*1024*1024});
const query = sql => JSON.parse(run(['--command',sql,'--json']))[0].results;
const tables = query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'");
const names = new Set(tables.map(row=>row.name));
const temp = mkdtempSync(join(tmpdir(), 'line-migration-'));
try {
 if (names.size === 0 || (names.size === 1 && names.has('_migrations'))) {
   // Bootstrap SQL + ledger in the same D1 import, so interruption is retryable.
   const included = JSON.parse(readFileSync('packages/db/bootstrap-meta.json','utf8')).includedMigrations;
   const ledger = `CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);\n` +
     included.map(name=>`INSERT OR IGNORE INTO _migrations VALUES ('${name.replaceAll("'","''")}',datetime('now'));`).join('\n');
   const file = join(temp,'bootstrap.sql');
   writeFileSync(file,readFileSync('packages/db/bootstrap.sql','utf8')+'\n'+ledger+'\n');
   run(['--file',file]);
   console.log('Initialized empty D1 from versioned bootstrap');
 } else {
   if (!names.has('_migrations')) throw new Error('Existing D1 has no migration ledger. Inspect its schema before deploying; refusing to guess.');
   const applied = new Set(query('SELECT name FROM _migrations').map(row=>row.name));
   if (!applied.size) throw new Error('Existing nonempty D1 has an empty ledger. Refusing to replay historical migrations.');
   for (const name of readdirSync('packages/db/migrations').filter(n=>/^\d+_.*\.sql$/.test(n)).sort()) {
     if (applied.has(name)) continue;
     const file=join(temp,name);
     writeFileSync(file,readFileSync(join('packages/db/migrations',name),'utf8')+`\nINSERT INTO _migrations VALUES ('${name.replaceAll("'","''")}',datetime('now'));\n`);
     run(['--file',file]);
     console.log(`Applied ${name}`);
   }
 }
} finally { rmSync(temp,{recursive:true,force:true}); }
