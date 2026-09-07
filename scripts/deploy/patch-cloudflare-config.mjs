#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const file = process.argv[2] ?? 'apps/worker/dist/line_harness/wrangler.json';
const required = name => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
const name = required('WORKER_NAME');
const config = JSON.parse(readFileSync(file, 'utf8'));
config.name = name;
config.account_id = required('CLOUDFLARE_ACCOUNT_ID');
config.d1_databases = [{ binding: 'DB', database_name: required('D1_DATABASE_NAME'), database_id: required('D1_DATABASE_ID') }];
config.r2_buckets = [{ binding: 'IMAGES', bucket_name: required('R2_BUCKET_NAME') }];
config.cache = { enabled: false };
config.vars = { WORKER_NAME: name, WORKER_URL: required('WORKER_URL'),
  ADMIN_ORIGIN: required('ADMIN_ORIGIN'), ADMIN_ALLOW_CROSS_SITE: 'true', MANUAL_REPLY_ONLY: 'true' };
const queue = required('INBOX_QUEUE_NAME');
config.queues = { producers: [{ binding: 'MANUAL_INBOX', queue }], consumers: [{ queue,
  max_batch_size: 1, max_batch_timeout: 1, max_retries: 10, max_concurrency: 1,
  dead_letter_queue: required('INBOX_DLQ_NAME') }] };
writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
console.log(`Configured ${name}: manual replies, durable inbox, isolated D1/R2`);
