import { describe, expect, test } from 'vitest'
import {
  NEAR_BOTTOM_THRESHOLD_PX,
  applyChatListRow,
  countNewMessages,
  mergeMessages,
  shouldFollowScroll,
  shouldPollChatDetail,
  sinceForPoll,
  type SyncableMessage,
} from './message-sync'

function msg(overrides: Partial<SyncableMessage> & { id: string }): SyncableMessage {
  return {
    direction: 'incoming',
    messageType: 'text',
    content: '',
    createdAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  }
}

function gate(overrides: Partial<Parameters<typeof shouldPollChatDetail>[0]> = {}) {
  return {
    documentHidden: false,
    sending: false,
    hasSelectedChat: true,
    requestInFlight: false,
    ...overrides,
  }
}

describe('sinceForPoll', () => {
  test('メッセージが 1 件も無ければ null (= 全件取得にフォールバック)', () => {
    expect(sinceForPoll([])).toBeNull()
    expect(sinceForPoll(null)).toBeNull()
    expect(sinceForPoll(undefined)).toBeNull()
  })

  test('最新メッセージの createdAt を返す', () => {
    const since = sinceForPoll([
      msg({ id: 'a', createdAt: '2026-09-01T10:00:00.000Z' }),
      msg({ id: 'b', createdAt: '2026-09-01T10:05:00.000Z' }),
    ])
    expect(since).toBe('2026-09-01T10:05:00.000Z')
  })

  test('配列が時刻順に並んでいなくても最大値を返す', () => {
    const since = sinceForPoll([
      msg({ id: 'b', createdAt: '2026-09-01T10:05:00.000Z' }),
      msg({ id: 'a', createdAt: '2026-09-01T10:00:00.000Z' }),
    ])
    expect(since).toBe('2026-09-01T10:05:00.000Z')
  })

  test('楽観更新分しか無ければ null (クライアント時計を since にしない)', () => {
    const since = sinceForPoll([
      msg({ id: 'local-1', direction: 'outgoing', pending: true, createdAt: '2026-09-01T10:10:00.000Z' }),
    ])
    expect(since).toBeNull()
  })

  test('楽観更新分は最新でも無視され、サーバー由来の最新が since になる', () => {
    const since = sinceForPoll([
      msg({ id: 'a', createdAt: '2026-09-01T10:00:00.000Z' }),
      // 端末の時計が進んでいるケース。これを since にすると新着を取りこぼす。
      msg({ id: 'local-1', direction: 'outgoing', pending: true, createdAt: '2026-09-01T18:00:00.000Z' }),
    ])
    expect(since).toBe('2026-09-01T10:00:00.000Z')
  })
})

describe('mergeMessages (差分)', () => {
  const existing = [
    msg({ id: 'm1', content: 'こんにちは', createdAt: '2026-09-01T10:00:00.000Z' }),
    msg({ id: 'm2', content: '在庫はありますか', createdAt: '2026-09-01T10:01:00.000Z' }),
  ]

  test('差分を末尾に足す', () => {
    const merged = mergeMessages(
      existing,
      [msg({ id: 'm3', content: 'まだですか', createdAt: '2026-09-01T10:02:00.000Z' })],
      { isDelta: true },
    )
    expect(merged.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
  })

  test('既存 id が差分に含まれていても重複しない (同一ミリ秒の境界)', () => {
    const merged = mergeMessages(
      existing,
      [
        msg({ id: 'm2', content: '在庫はありますか', createdAt: '2026-09-01T10:01:00.000Z' }),
        msg({ id: 'm3', content: 'まだですか', createdAt: '2026-09-01T10:02:00.000Z' }),
      ],
      { isDelta: true },
    )
    expect(merged.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
  })

  test('重複した id はサーバー側の内容を採用する', () => {
    const merged = mergeMessages(
      existing,
      [msg({ id: 'm2', content: '在庫はありますか？(修正)', createdAt: '2026-09-01T10:01:00.000Z' })],
      { isDelta: true },
    )
    expect(merged.find((m) => m.id === 'm2')?.content).toBe('在庫はありますか？(修正)')
    expect(merged).toHaveLength(2)
  })

  test('差分が空でも既存配列が壊れない', () => {
    expect(mergeMessages(existing, [], { isDelta: true }).map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(mergeMessages(existing, null, { isDelta: true }).map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(mergeMessages(existing, undefined, { isDelta: true }).map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  test('既存が空でも差分だけで組み立てられる', () => {
    const merged = mergeMessages([], [msg({ id: 'm1' })], { isDelta: true })
    expect(merged.map((m) => m.id)).toEqual(['m1'])
    expect(mergeMessages(null, [msg({ id: 'm1' })], { isDelta: true })).toHaveLength(1)
  })

  test('時刻がずれて届いても createdAt の昇順に整う', () => {
    const merged = mergeMessages(
      [msg({ id: 'm2', createdAt: '2026-09-01T10:05:00.000Z' })],
      [msg({ id: 'm1', createdAt: '2026-09-01T10:00:00.000Z' })],
      { isDelta: true },
    )
    expect(merged.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  test('楽観更新分は、サーバー版が返ってきたら差し替える (id は違う)', () => {
    const pending = msg({
      id: 'local-uuid',
      direction: 'outgoing',
      content: '確認します',
      createdAt: '2026-09-01T10:02:00.000Z',
      pending: true,
    })
    const merged = mergeMessages(
      [...existing, pending],
      [msg({ id: 'server-id', direction: 'outgoing', content: '確認します', createdAt: '2026-09-01T10:02:01.000Z' })],
      { isDelta: true },
    )
    expect(merged.map((m) => m.id)).toEqual(['m1', 'm2', 'server-id'])
  })

  test('サーバー版がまだ返ってきていない楽観更新分は残す (送信直後に消さない)', () => {
    const pending = msg({
      id: 'local-uuid',
      direction: 'outgoing',
      content: '確認します',
      createdAt: '2026-09-01T10:02:00.000Z',
      pending: true,
    })
    const merged = mergeMessages(
      [...existing, pending],
      [msg({ id: 'm3', content: 'まだですか', createdAt: '2026-09-01T10:02:30.000Z' })],
      { isDelta: true },
    )
    expect(merged.map((m) => m.id)).toEqual(['m1', 'm2', 'local-uuid', 'm3'])
  })

  test('本文が違う outgoing は別メッセージとして残す', () => {
    const pending = msg({
      id: 'local-uuid',
      direction: 'outgoing',
      content: '確認します',
      createdAt: '2026-09-01T10:02:00.000Z',
      pending: true,
    })
    const merged = mergeMessages(
      [pending],
      [msg({ id: 'server-id', direction: 'outgoing', content: 'お待たせしました', createdAt: '2026-09-01T10:02:01.000Z' })],
      { isDelta: true },
    )
    expect(merged).toHaveLength(2)
  })

  test('本文が同じでも時刻が大きく離れていれば別メッセージ (定型文の再送)', () => {
    const pending = msg({
      id: 'local-uuid',
      direction: 'outgoing',
      content: 'ありがとうございます',
      createdAt: '2026-09-01T10:02:00.000Z',
      pending: true,
    })
    const merged = mergeMessages(
      [pending],
      [msg({ id: 'server-id', direction: 'outgoing', content: 'ありがとうございます', createdAt: '2026-09-01T12:00:00.000Z' })],
      { isDelta: true },
    )
    expect(merged).toHaveLength(2)
  })
})

describe('mergeMessages (全件)', () => {
  test('isDelta: false なら既存はサーバー版で置き換える', () => {
    const merged = mergeMessages(
      [msg({ id: 'stale', createdAt: '2026-09-01T09:00:00.000Z' })],
      [msg({ id: 'm1', createdAt: '2026-09-01T10:00:00.000Z' })],
      { isDelta: false },
    )
    expect(merged.map((m) => m.id)).toEqual(['m1'])
  })

  test('全件取得でも未確認の楽観更新分は消さない', () => {
    const pending = msg({
      id: 'local-uuid',
      direction: 'outgoing',
      content: '確認します',
      createdAt: '2026-09-01T10:30:00.000Z',
      pending: true,
    })
    const merged = mergeMessages(
      [msg({ id: 'stale' }), pending],
      [msg({ id: 'm1', createdAt: '2026-09-01T10:00:00.000Z' })],
      { isDelta: false },
    )
    expect(merged.map((m) => m.id)).toEqual(['m1', 'local-uuid'])
  })
})

describe('countNewMessages', () => {
  test('増えた分だけ数える', () => {
    expect(countNewMessages([msg({ id: 'a' })], [msg({ id: 'a' }), msg({ id: 'b' })])).toBe(1)
  })

  test('変化なしなら 0', () => {
    expect(countNewMessages([msg({ id: 'a' })], [msg({ id: 'a' })])).toBe(0)
    expect(countNewMessages(null, null)).toBe(0)
  })

  test('楽観更新分がサーバー版に差し替わっただけでも新着として数える (id が変わるため)', () => {
    // 送信中はポーリングしない前提なので実害は無いが、挙動を明示しておく
    const before = [msg({ id: 'local', direction: 'outgoing', pending: true })]
    const after = [msg({ id: 'server', direction: 'outgoing' })]
    expect(countNewMessages(before, after)).toBe(1)
  })
})

describe('shouldFollowScroll', () => {
  test('最下部なら追従する', () => {
    expect(shouldFollowScroll(0)).toBe(true)
  })

  test('しきい値ちょうどまでは追従する', () => {
    expect(shouldFollowScroll(NEAR_BOTTOM_THRESHOLD_PX)).toBe(true)
  })

  test('過去を遡って読んでいるなら追従しない', () => {
    expect(shouldFollowScroll(NEAR_BOTTOM_THRESHOLD_PX + 1)).toBe(false)
    expect(shouldFollowScroll(4000)).toBe(false)
  })

  test('しきい値を指定できる', () => {
    expect(shouldFollowScroll(30, 20)).toBe(false)
    expect(shouldFollowScroll(10, 20)).toBe(true)
  })

  test('測れなかった (NaN) ときは追従に倒す', () => {
    expect(shouldFollowScroll(Number.NaN)).toBe(true)
  })
})

describe('shouldPollChatDetail', () => {
  test('通常時はポーリングする', () => {
    expect(shouldPollChatDetail(gate())).toBe(true)
  })

  test('送信中はポーリングしない (楽観更新と競合するため)', () => {
    expect(shouldPollChatDetail(gate({ sending: true }))).toBe(false)
  })

  test('タブが非表示ならポーリングしない', () => {
    expect(shouldPollChatDetail(gate({ documentHidden: true }))).toBe(false)
  })

  test('チャットを開いていなければポーリングしない', () => {
    expect(shouldPollChatDetail(gate({ hasSelectedChat: false }))).toBe(false)
  })

  test('前のリクエストが飛んだままなら重ねて投げない', () => {
    expect(shouldPollChatDetail(gate({ requestInFlight: true }))).toBe(false)
  })
})

describe('applyChatListRow', () => {
  function chat(id: string, lastMessageAt: string | null, extra: Record<string, unknown> = {}) {
    return { id, lastMessageAt, lastMessageContent: null, lastMessageDirection: null, lastMessageType: null, ...extra }
  }

  const patch = {
    lastMessageAt: '2026-09-01T12:00:00.000Z',
    lastMessageContent: '追加で質問です',
    lastMessageDirection: 'incoming' as const,
    lastMessageType: 'text',
  }

  test('該当行のプレビューと時刻を書き換える', () => {
    const rows = applyChatListRow([chat('a', '2026-09-01T09:00:00.000Z')], 'a', patch)
    expect(rows[0].lastMessageContent).toBe('追加で質問です')
    expect(rows[0].lastMessageAt).toBe('2026-09-01T12:00:00.000Z')
  })

  test('新着が来た会話を先頭へ並べ替える', () => {
    const rows = applyChatListRow(
      [chat('other', '2026-09-01T11:00:00.000Z'), chat('a', '2026-09-01T09:00:00.000Z')],
      'a',
      patch,
    )
    expect(rows.map((c) => c.id)).toEqual(['a', 'other'])
  })

  test('一覧に居ない会話には行を生やさない (フィルタで除外中の会話を割り込ませない)', () => {
    const prev = [chat('other', '2026-09-01T11:00:00.000Z')]
    expect(applyChatListRow(prev, 'a', patch)).toBe(prev)
  })

  test('他の行はそのまま', () => {
    const rows = applyChatListRow(
      [chat('a', '2026-09-01T09:00:00.000Z'), chat('other', '2026-08-01T09:00:00.000Z', { status: 'unread' })],
      'a',
      patch,
    )
    expect(rows.find((c) => c.id === 'other')).toMatchObject({ status: 'unread' })
  })

  test('lastMessageAt が null の行があっても落ちない', () => {
    const rows = applyChatListRow([chat('a', null), chat('b', null)], 'a', patch)
    expect(rows.map((c) => c.id)).toEqual(['a', 'b'])
  })

  test('一覧が空 / 未取得でも落ちない', () => {
    expect(applyChatListRow([], 'a', patch)).toEqual([])
    expect(applyChatListRow(null, 'a', patch)).toEqual([])
    expect(applyChatListRow(undefined, 'a', patch)).toEqual([])
  })
})


test('recovered media advances the polling cursor without changing conversation order', () => {
  const old = { id:'media',direction:'incoming' as const,messageType:'video',content:'[video: 取得失敗]',createdAt:'2026-09-07T10:00:00Z' };
  const newer = { ...old,id:'text',messageType:'text',content:'続き',createdAt:'2026-09-07T10:01:00Z' };
  const recovered = { ...old,content:'{"type":"video","originalContentUrl":"https://example.test/video"}',contentUpdatedAt:'2026-09-07T10:02:00Z' };
  const merged = mergeMessages([old,newer],[recovered],{isDelta:true});
  expect(merged.map(m=>m.id)).toEqual(['media','text']);
  expect(sinceForPoll(merged)).toBe(recovered.contentUpdatedAt);
});
