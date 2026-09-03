import { describe, expect, test } from 'vitest'
import {
  MISSING_QUOTE_LABEL,
  canQuoteMessage,
  findQuotedMessage,
  quoteExcerpt,
  quotedMessageIdForSend,
  resolveQuoteExcerpt,
  type QuotableMessage,
} from './quote-reply'

function msg(overrides: Partial<QuotableMessage> & { id: string }): QuotableMessage {
  return {
    direction: 'incoming',
    messageType: 'text',
    content: '',
    createdAt: '2026-09-01T10:00:00.000Z',
    quotable: false,
    quotedMessageId: null,
    ...overrides,
  }
}

describe('canQuoteMessage', () => {
  test('quotable が true なら引用できる', () => {
    expect(canQuoteMessage(msg({ id: 'a', quotable: true }))).toBe(true)
  })

  test('quotable が false なら引用できない', () => {
    expect(canQuoteMessage(msg({ id: 'a', quotable: false }))).toBe(false)
  })

  test('quotable が未定義なら引用できない (サーバーが古くフィールドを返さない場合)', () => {
    expect(canQuoteMessage(msg({ id: 'a', quotable: undefined }))).toBe(false)
  })

  test('outgoing (自分の送信) でも quotable なら引用できる', () => {
    expect(canQuoteMessage(msg({ id: 'a', direction: 'outgoing', quotable: true }))).toBe(true)
  })

  test('メッセージ自体が無くても落ちない', () => {
    expect(canQuoteMessage(null)).toBe(false)
    expect(canQuoteMessage(undefined)).toBe(false)
  })
})

describe('findQuotedMessage', () => {
  const messages = [
    msg({ id: 'm1', content: 'おはようございます' }),
    msg({ id: 'm2', content: '確認しました' }),
  ]

  test('配列内に居れば見つかる', () => {
    expect(findQuotedMessage(messages, 'm2')?.content).toBe('確認しました')
  })

  test('配列内に居なければ null (履歴 1000 件の打ち切りで落ちるケース)', () => {
    expect(findQuotedMessage(messages, 'gone')).toBeNull()
  })

  test('id 未指定 / 配列未取得でも落ちない', () => {
    expect(findQuotedMessage(messages, null)).toBeNull()
    expect(findQuotedMessage(messages, undefined)).toBeNull()
    expect(findQuotedMessage(undefined, 'm1')).toBeNull()
    expect(findQuotedMessage(null, 'm1')).toBeNull()
  })
})

describe('quoteExcerpt', () => {
  test('短いテキストはそのまま', () => {
    expect(quoteExcerpt(msg({ id: 'm', content: '在庫はありますか？' }))).toBe('在庫はありますか？')
  })

  test('長文は省略記号で切る', () => {
    const long = 'あ'.repeat(200)
    const excerpt = quoteExcerpt(msg({ id: 'm', content: long }), 10)
    expect(excerpt).toBe(`${'あ'.repeat(10)}…`)
  })

  test('ちょうど上限のときは省略しない', () => {
    expect(quoteExcerpt(msg({ id: 'm', content: 'あいうえお' }), 5)).toBe('あいうえお')
  })

  test('改行と連続空白は 1 スペースに潰す', () => {
    expect(quoteExcerpt(msg({ id: 'm', content: '一行目\n\n二行目   三行目' }))).toBe('一行目 二行目 三行目')
  })

  test('前後の空白は落とす', () => {
    expect(quoteExcerpt(msg({ id: 'm', content: '  こんにちは  ' }))).toBe('こんにちは')
  })

  test('空文字 / 空白だけなら本文なし表示', () => {
    expect(quoteExcerpt(msg({ id: 'm', content: '' }))).toBe('(本文なし)')
    expect(quoteExcerpt(msg({ id: 'm', content: '   \n ' }))).toBe('(本文なし)')
  })

  test('テキスト以外は種別ラベルにする', () => {
    expect(quoteExcerpt(msg({ id: 'm', messageType: 'image', content: '{"originalContentUrl":"https://x/y.png"}' })))
      .toBe('📷 画像')
    expect(quoteExcerpt(msg({ id: 'm', messageType: 'sticker', content: '{"packageId":"1"}' }))).toBe('🎨 スタンプ')
    expect(quoteExcerpt(msg({ id: 'm', messageType: 'flex', content: '{}' }))).toBe('📋 Flexメッセージ')
  })

  test('未知の種別はテキストとして扱う', () => {
    expect(quoteExcerpt(msg({ id: 'm', messageType: 'unknown-type', content: 'なにか' }))).toBe('なにか')
  })

  test('メッセージが無ければフォールバック文言', () => {
    expect(quoteExcerpt(null)).toBe(MISSING_QUOTE_LABEL)
    expect(quoteExcerpt(undefined)).toBe(MISSING_QUOTE_LABEL)
  })
})

describe('resolveQuoteExcerpt', () => {
  const messages = [
    msg({ id: 'm1', content: '見積もりをお願いします' }),
    msg({ id: 'm2', content: '承知しました', direction: 'outgoing', quotedMessageId: 'm1' }),
  ]

  test('配列内に引用元が居れば抜粋を返す', () => {
    expect(resolveQuoteExcerpt(messages, 'm1')).toBe('見積もりをお願いします')
  })

  test('引用元が配列に居なければフォールバック文言 (クラッシュさせない)', () => {
    expect(resolveQuoteExcerpt(messages, 'dropped-by-history-limit')).toBe(MISSING_QUOTE_LABEL)
  })

  test('引用していないメッセージでもフォールバック文言', () => {
    expect(resolveQuoteExcerpt(messages, null)).toBe(MISSING_QUOTE_LABEL)
  })

  test('長さ上限を渡せる', () => {
    expect(resolveQuoteExcerpt(messages, 'm1', 3)).toBe('見積も…')
  })
})

describe('quotedMessageIdForSend', () => {
  test('引用中なら id を返す', () => {
    expect(quotedMessageIdForSend('m1', false)).toBe('m1')
  })

  test('画像添付中は引用を付けない (サーバーが 400 を返すため)', () => {
    expect(quotedMessageIdForSend('m1', true)).toBeUndefined()
  })

  test('引用していなければ undefined', () => {
    expect(quotedMessageIdForSend(null, false)).toBeUndefined()
    expect(quotedMessageIdForSend(undefined, false)).toBeUndefined()
  })
})
