import { test, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

test('deployment config isolates resources and removes inherited mock/self-update variables', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lh-config-test-'));
  try {
    const file = join(dir,'wrangler.json');
    writeFileSync(file, JSON.stringify({main:'index.js',vars:{LINE_API_BASE_URL:'http://localhost:8790',MANIFEST_URL:'old'},assets:{binding:'ASSETS'}}));
    execFileSync(process.execPath,['scripts/deploy/patch-cloudflare-config.mjs',file], {env:{...process.env,
      WORKER_NAME:'test-worker',CLOUDFLARE_ACCOUNT_ID:'account',D1_DATABASE_NAME:'db',D1_DATABASE_ID:'db-id',R2_BUCKET_NAME:'bucket',
      INBOX_QUEUE_NAME:'inbox',INBOX_DLQ_NAME:'dlq',WORKER_URL:'https://worker.example',ADMIN_ORIGIN:'https://admin.example'}});
    const config=JSON.parse(readFileSync(file,'utf8'));
    expect(config.vars).toMatchObject({MANUAL_REPLY_ONLY:'true',WORKER_URL:'https://worker.example'});
    expect(config.vars.LINE_API_BASE_URL).toBeUndefined();
    expect(config.vars.MANIFEST_URL).toBeUndefined();
    expect(config.queues.consumers[0]).toMatchObject({max_retries:10,dead_letter_queue:'dlq'});
    expect(config.r2_buckets[0].bucket_name).toBe('bucket');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

for (const state of ['empty','tracked','untracked']) {
  test(`D1 migration ${state} state is handled without replaying historical schema`, () => {
    const dir=mkdtempSync(join(tmpdir(),'lh-migration-test-'));
    try {
      const shim=join(dir,'pnpm');
      writeFileSync(shim,`#!${process.execPath}
const fs=require('fs');
const args=process.argv.slice(2); const i=args.indexOf('--command');
if(i>=0) {
 const sql=args[i+1];
 if(sql.includes('sqlite_master')) console.log(JSON.stringify([{results:${JSON.stringify(state==='empty'?[]:state==='tracked'?[{name:'friends'},{name:'_migrations'}]:[{name:'friends'}])}}]));
 else console.log(JSON.stringify([{results:JSON.parse(fs.readFileSync('packages/db/bootstrap-meta.json','utf8')).includedMigrations.slice(0,-1).map(name=>({name}))}]));
} else { fs.writeFileSync(${JSON.stringify(join(dir,'applied.sql'))},fs.readFileSync(args[args.indexOf('--file')+1])); console.log('[]'); }
`);
      chmodSync(shim,0o700);
      const result=spawnSync(process.execPath,['scripts/deploy/migrate-cloudflare.mjs','--remote'],{encoding:'utf8',env:{...process.env,D1_DATABASE_NAME:'test-db',PATH:dir+':'+process.env.PATH}});
      if(state==='untracked') { expect(result.status).not.toBe(0);expect(result.stderr).toContain('no migration ledger'); }
      else {
        expect(result.status, result.stderr).toBe(0);
        const sql=readFileSync(join(dir,'applied.sql'),'utf8');
        expect(sql).toContain('INSERT');
        if(state==='empty') { expect(sql).toContain('CREATE TABLE IF NOT EXISTS friends');expect(sql).toContain('078_message_content_updates.sql'); }
        else { expect(sql).toContain('content_updated_at');expect(sql).not.toContain('CREATE TABLE IF NOT EXISTS friends'); }
      }
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
}
