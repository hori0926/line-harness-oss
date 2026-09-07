export const CHAT_LEASE_MS = 90_000;
export async function claimChatLease(db: D1Database, friendId: string, staff: { id: string; name: string }, now = Date.now()) {
  await db.prepare(`INSERT INTO chat_leases (friend_id, staff_id, staff_name, expires_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(friend_id) DO UPDATE SET staff_id = excluded.staff_id, staff_name = excluded.staff_name,
      expires_at = excluded.expires_at
    WHERE chat_leases.expires_at <= ? OR chat_leases.staff_id = excluded.staff_id`)
    .bind(friendId, staff.id, staff.name, now + CHAT_LEASE_MS, now).run();
  const lease = await db.prepare('SELECT staff_id, staff_name, expires_at FROM chat_leases WHERE friend_id = ?')
    .bind(friendId).first<{ staff_id: string; staff_name: string; expires_at: number }>();
  return { owned: lease?.staff_id === staff.id && lease.expires_at > now,
    staffName: lease?.staff_name ?? '', expiresAt: lease?.expires_at ?? 0 };
}
