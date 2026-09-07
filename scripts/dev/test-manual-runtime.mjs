#!/usr/bin/env node
// Runs actual workerd/D1/R2, not mocks of the Cloudflare storage APIs.
import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../..');
const workerRequire = createRequire(realpathSync(resolve(root, 'apps/worker/node_modules/wrangler/package.json')));
const { Miniflare } = workerRequire('miniflare');
const { build } = createRequire(require.resolve('tsx'))('esbuild');
const result = await build({ nodePaths: [resolve(root, 'apps/worker/node_modules')], bundle: true, write: false, format: 'esm', platform: 'browser',
  stdin: { resolveDir: root, sourcefile: 'manual-runtime-test.ts', loader: 'ts', contents: `
import { putBoundedMedia } from './apps/worker/src/services/incoming-media.ts';
import { receiveManualEvent, manualInboxQueue } from './apps/worker/src/services/manual-inbox.ts';
import { claimChatLease } from './apps/worker/src/services/chat-lease.ts';
import { chats } from './apps/worker/src/routes/chats.ts';
import { Hono } from 'hono';
import { LineClient } from '@line-crm/line-sdk';
const accepted = new Set();
let profileAttempts = 0;
LineClient.prototype.getProfile = async function(userId) {
  if (++profileAttempts === 1) throw new Error('temporary profile outage');
  return {userId,displayName:'復旧した表示名'};
};
let contentAttempts = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  if (String(args[0]).includes('/media-retry/content')) {
    if (++contentAttempts === 1) return new Response(null,{status:202});
    return new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'application/pdf'}});
  }
  return originalFetch(...args);
};
LineClient.prototype.pushMessage = async function(to, messages, retryKey) {
  accepted.add(retryKey);
  return {sentMessages:[{id:'mock-sent',quoteToken:'mock-sent-quote'}]};
};
export default { async fetch(request, env) {
 const body = await request.json();
 if (body.op === 'queue') {
   let acked = false, retried = false;
   await manualInboxQueue({messages:[{id:'queue-test',body:body.job,attempts:body.attempts,
     ack(){acked=true},retry(){retried=true}}]},env);
   return Response.json({acked,retried});
 }
 if (body.op === 'detail') {
   const app = new Hono();
   app.route('/',chats);
   return app.request('/api/chats/friend-test?since=2001-01-01T00:00:00.000Z', {}, env);
 }
 if (body.op === 'send') {
   const db = body.failLog ? {prepare(sql) {
     const statement = env.DB.prepare(sql);
     if (sql.startsWith('INSERT OR IGNORE INTO messages_log')) return {bind() {return {run() {throw new Error('simulated log outage');}};}};
     return statement;
   }} : env.DB;
   const app = new Hono();
   app.use('*', async(c,next)=>{c.set('staff',body.staff);await next();});
   app.route('/',chats);
   const response = await app.request('/api/chats/friend-test/send', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body.payload)}, {...env,DB:db,MANUAL_REPLY_ONLY:'true'});
   return Response.json({status:response.status,result:await response.json(),accepted:accepted.size});
 }
 if (body.op === 'lease') return Response.json(await claimChatLease(env.DB, 'friend-test', body.staff, body.now));
 if (body.op === 'receive') { await receiveManualEvent(body.job, env); return Response.json({ok:true}); }
 if (body.op === 'media') {
   let remaining = body.size;
   const stream = new ReadableStream({pull(c) {
     if (!remaining) return c.close();
     const size = Math.min(remaining, 1024 * 1024); remaining -= size; c.enqueue(new Uint8Array(size).fill(42));
   }});
   try { await putBoundedMedia(env.IMAGES, 'test.bin', stream, body.limit, {contentType:'application/octet-stream'});
     const object = await env.IMAGES.head('test.bin'); return Response.json({size:object.size});
   } catch { return Response.json({rejected:true}); }
 }
 return Response.json({error:'unknown'}, {status:400});
}};
` }});
const mf = new Miniflare({ modules: true, script: result.outputFiles[0].text,
  compatibilityDate: '2024-12-01', compatibilityFlags: ['nodejs_compat'],
  d1Databases: ['DB'], r2Buckets: ['IMAGES'], bindings: { LINE_CHANNEL_ACCESS_TOKEN: 'test-only', WORKER_URL: 'https://example.test' } });
try {
 const db = await mf.getD1Database('DB');
 const sql = readFileSync(resolve(root, 'packages/db/bootstrap.sql'), 'utf8').replace(/^--.*$/gm, '');
 for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
 await db.prepare("INSERT INTO friends (id,line_user_id,display_name) VALUES ('friend-test','Utest','テスト利用者')").run();
 const call = async body => {
  const response = await mf.dispatchFetch('https://test/', {method:'POST', body:JSON.stringify(body)});
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
 };
 const staffA = {id:'staff-a',name:'田中'}, staffB = {id:'staff-b',name:'佐藤'};
 const leases = await Promise.all([call({op:'lease',staff:staffA,now:1000}),call({op:'lease',staff:staffB,now:1000})]);
 assert.equal(leases.filter(l=>l.owned).length,1, 'concurrent staff must have one winner');
 const winner = leases[0].owned ? staffA : staffB, loser = leases[0].owned ? staffB : staffA;
 assert.equal((await call({op:'lease',staff:loser,now:2000})).owned,false);
 assert.equal((await call({op:'lease',staff:winner,now:3000})).owned,true);
 assert.equal((await call({op:'lease',staff:loser,now:94000})).owned,true,'abandoned lease expires');
 for (const size of [2048, 5*1024*1024, 12*1024*1024+123]) {
  assert.equal((await call({op:'media',size,limit:20*1024*1024})).size,size);
 }
 assert.equal((await call({op:'media',size:12*1024*1024,limit:10*1024*1024})).rejected,true);
 const job = { accountId:null,workerUrl:'https://test',event:{type:'message',timestamp:Date.now(),source:{type:'user',userId:'Utest'},message:{type:'text',id:'message-1',text:'手動で返信してください',quoteToken:'test-quote'}}};
 await call({op:'receive',job});
 await db.prepare("UPDATE chats SET status='resolved' WHERE friend_id='friend-test'").run();
 await call({op:'receive',job});
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM messages_log').first()).n,1);
 assert.equal((await db.prepare("SELECT status FROM chats WHERE friend_id='friend-test'").first()).status,'resolved','duplicate delivery must not reopen resolved chats');
 assert.equal((await db.prepare('SELECT quote_token FROM messages_log').first()).quote_token,'test-quote');
 const payload = {content:'担当者からの返信', requestId:crypto.randomUUID()};
 await call({op:'lease',staff:staffA,now:Date.now()});
 assert.equal((await call({op:'send',staff:staffB,payload})).status,409,'other staff must be rejected by server');
 const failed = await call({op:'send',staff:staffA,payload,failLog:true});
 assert.equal(failed.status,500);
 const retried = await call({op:'send',staff:staffA,payload});
 assert.equal(retried.status,200);
 assert.equal(retried.accepted,1,'uncertain send must retain its LINE retry key');
 const replay = await call({op:'send',staff:staffA,payload});
 assert.equal(replay.status,200);
 assert.equal(replay.accepted,1);
 assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM messages_log WHERE direction='outgoing'").first()).n,1);
 assert.equal((await call({op:'send',staff:staffA,payload:{...payload,content:'別の内容'}})).status,409,'retry key cannot change payload');
 const profileJob = { ...job,event:{...job.event,source:{type:'user',userId:'Uenrich'},message:{type:'text',id:'profile-1',text:'hello'}} };
 await call({op:'receive',job:profileJob});
 assert.equal((await db.prepare("SELECT display_name FROM friends WHERE line_user_id='Uenrich'").first()).display_name,null);
 await call({op:'receive',job:{...profileJob,event:{...profileJob.event,message:{...profileJob.event.message,id:'profile-2'}}}});
 assert.equal((await db.prepare("SELECT display_name FROM friends WHERE line_user_id='Uenrich'").first()).display_name,'復旧した表示名');
 const mediaJob = {...job,event:{...job.event,message:{type:'file',id:'media-retry',fileName:'見積書.pdf'}}};
 assert.deepEqual(await call({op:'queue',job:mediaJob,attempts:10}),{acked:false,retried:true});
 const failedMedia = await db.prepare("SELECT * FROM messages_log WHERE id='line:default:media-retry'").first();
 assert.match(failedMedia.content,/取得失敗/);
 assert.ok(failedMedia.content_updated_at);
 await db.prepare("UPDATE messages_log SET created_at='2000-01-01T00:00:00.000Z', content_updated_at='2000-01-01T00:00:00.000Z' WHERE id='line:default:media-retry'").run();
 assert.deepEqual(await call({op:'queue',job:mediaJob,attempts:11}),{acked:true,retried:false});
 const recoveredMedia = await db.prepare("SELECT * FROM messages_log WHERE id='line:default:media-retry'").first();
 assert.equal(JSON.parse(recoveredMedia.content).type,'file');
 assert.equal(recoveredMedia.created_at,'2000-01-01T00:00:00.000Z');
 assert.ok(recoveredMedia.content_updated_at);
 const delta = await call({op:'detail'});
 assert.equal(delta.success,true);
 const recoveredDelta = delta.data.messages.find(message => message.id === 'line:default:media-retry');
 assert.ok(recoveredDelta, 'delta includes old messages whose media content recovered');
 assert.equal(recoveredDelta.contentUpdatedAt,recoveredMedia.content_updated_at);
 assert.equal(JSON.parse(recoveredDelta.content).type,'file');
 console.log('PASS: workerd multipart (small/exact-part/multipart/oversize), atomic staff leases/expiry, inbox deduplication/quote persistence, send lease enforcement/uncertain-send recovery/replay, profile retry, failed-media redrive');
} finally { await mf.dispose(); }
