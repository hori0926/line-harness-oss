import { LineClient } from '@line-crm/line-sdk';
import type { WebhookEvent } from '@line-crm/line-sdk';
import { getLineAccountById, getFriendByLineUserId, upsertFriend, jstNow, updateFriendFollowStatus } from '@line-crm/db';
import { createStickerMessageContent } from '@line-crm/shared';
import type { Env } from '../index.js';
import { applyLineApiBase } from '../middleware/line-api-base.js';
import { fetchAndStoreIncomingMedia, fetchAndStoreIncomingImageInternal } from './incoming-media.js';

// Only signed webhook events enter this queue. Credentials are resolved at delivery
// time, never copied into queue payloads. No automation/event-bus calls in this path.
export interface ManualInboxJob {
  event: WebhookEvent;
  accountId: string | null;
  workerUrl: string;
}

export async function receiveManualEvent(job: ManualInboxJob, env: Env['Bindings']): Promise<void> {
  const { event, accountId, workerUrl } = job;
  const userId = event.source.type === 'user' ? event.source.userId : undefined;
  if (!userId) return;
  if (event.type === 'unfollow') {
    await updateFriendFollowStatus(env.DB, userId, false);
    return;
  }
  if (event.type !== 'message' && event.type !== 'follow') return;
  const account = accountId ? await getLineAccountById(env.DB, accountId) : null;
  if (accountId && (!account || !account.is_active)) throw new Error('Inbox account unavailable');
  const token = account?.channel_access_token ?? env.LINE_CHANNEL_ACCESS_TOKEN;
  let friend = await getFriendByLineUserId(env.DB, userId);
  if (!friend || event.type === 'follow' || !friend.display_name) {
    let profile: Awaited<ReturnType<LineClient['getProfile']>> | undefined;
    try { profile = await new LineClient(token).getProfile(userId); } catch { /* signed event still records the user */ }
    friend = await upsertFriend(env.DB, { lineUserId: userId, ...(profile ? {
      displayName: profile.displayName, pictureUrl: profile.pictureUrl, statusMessage: profile.statusMessage,
    } : {}) });
  }
  if (accountId && friend.line_account_id !== accountId) {
    await env.DB.prepare('UPDATE friends SET line_account_id = ? WHERE id = ?').bind(accountId, friend.id).run();
  }
  if (event.type !== 'message') return;
  const msg = event.message as typeof event.message & {
    text?: string; quoteToken?: string; duration?: number; fileName?: string; fileSize?: number;
    latitude?: number; longitude?: number; address?: string; title?: string;
  };
  const id = `line:${accountId ?? 'default'}:${msg.id}`;
  const media = ['image', 'video', 'audio', 'file'].includes(msg.type);
  const pending = `[${msg.type}: 取得待ち]`;
  let content = msg.text ?? `[${msg.type}]`;
  if (media) content = pending;
  if (msg.type === 'sticker') content = JSON.stringify(createStickerMessageContent(msg)) || '[スタンプ]';
  if (msg.type === 'location') content = `${msg.title ?? '位置情報'} ${msg.address ?? ''} https://maps.google.com/?q=${msg.latitude},${msg.longitude}`;
  const existing = await env.DB.prepare('SELECT content FROM messages_log WHERE id = ?').bind(id).first<{ content: string }>();
  if (!existing) {
    const now = jstNow();
    const receivedAt = now; // ingestion cursor must advance even for delayed LINE redelivery
    // Commit inbox visibility and message together before fetching any binary.
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO chats (id, friend_id, status, last_message_at, created_at, updated_at)
        SELECT ?, ?, 'unread', ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM chats WHERE friend_id = ?)`)
        .bind(crypto.randomUUID(), friend.id, now, now, now, friend.id),
      env.DB.prepare(`UPDATE chats SET status = CASE WHEN status = 'resolved' THEN 'unread' ELSE status END,
        last_message_at = ?, updated_at = ? WHERE friend_id = ?`).bind(now, now, friend.id),
      env.DB.prepare(`INSERT OR IGNORE INTO messages_log
        (id, friend_id, direction, message_type, content, source, quote_token, created_at)
        VALUES (?, ?, 'incoming', ?, ?, 'user', ?, ?)`)
        .bind(id, friend.id, msg.type, content, msg.quoteToken ?? null, receivedAt),
    ]);
  }
  if (!media || (existing && existing.content !== pending && !existing.content.includes(': 取得失敗'))) return;
  const options = { r2: env.IMAGES, workerUrl, channelAccessToken: token,
    accountId: accountId ?? 'default', messageId: msg.id, duration: msg.duration,
    fileName: msg.fileName, fileSize: msg.fileSize };
  const stored = msg.type === 'image'
    ? await fetchAndStoreIncomingImageInternal(options)
    : await fetchAndStoreIncomingMedia({ ...options, kind: msg.type as 'video' | 'audio' | 'file' });
  if (!stored) throw new Error(`Incoming media unavailable: ${id}`);
  await env.DB.prepare('UPDATE messages_log SET content = ?, content_updated_at = ? WHERE id = ?').bind(JSON.stringify(stored), jstNow(), id).run();
}

export async function manualInboxQueue(batch: MessageBatch<ManualInboxJob>, env: Env['Bindings']): Promise<void> {
  applyLineApiBase(env);
  for (const message of batch.messages) {
    try {
      await receiveManualEvent(message.body, env);
      message.ack();
    } catch (error) {
      console.error('Manual inbox retry', { messageId: message.id, attempt: message.attempts });
      // On the last attempt retain the job in the configured dead-letter queue.
      // The placeholder remains visible; the operations guide explains redrive.
      const event = message.body.event;
      if (message.attempts >= 10 && event.type === 'message' && ['image', 'audio', 'video', 'file'].includes(event.message.type)) {
        const id = `line:${message.body.accountId ?? 'default'}:${event.message.id}`;
        await env.DB.prepare("UPDATE messages_log SET content = ?, content_updated_at = ? WHERE id = ? AND content LIKE '%: 取得待ち]'")
          .bind(`[${event.message.type}: 取得失敗。管理者に連絡してください]`, jstNow(), id).run();
      }
      message.retry({ delaySeconds: Math.min(300, 10 * 2 ** Math.min(message.attempts, 5)) });
    }
  }
}
