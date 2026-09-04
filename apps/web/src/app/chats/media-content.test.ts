import { describe, expect, test } from 'vitest'
import {
  UNKNOWN_FILE_NAME,
  fileExtensionLabel,
  formatDuration,
  formatFileSize,
  isMediaMessageType,
  mediaFallbackLabel,
  resolveMediaContent,
} from './media-content'

describe('isMediaMessageType', () => {
  test('video / audio / file だけが対象', () => {
    expect(isMediaMessageType('video')).toBe(true)
    expect(isMediaMessageType('audio')).toBe(true)
    expect(isMediaMessageType('file')).toBe(true)
    expect(isMediaMessageType('image')).toBe(false)
    expect(isMediaMessageType('text')).toBe(false)
    expect(isMediaMessageType('')).toBe(false)
  })
})

describe('resolveMediaContent — 正常な JSON', () => {
  test('video: originalContentUrl と previewImageUrl を拾う', () => {
    const result = resolveMediaContent(
      'video',
      JSON.stringify({
        type: 'video',
        originalContentUrl: 'https://media.example.com/a.mp4',
        previewImageUrl: 'https://media.example.com/a.jpg',
      }),
    )
    expect(result).toEqual({
      kind: 'video',
      url: 'https://media.example.com/a.mp4',
      posterUrl: 'https://media.example.com/a.jpg',
    })
  })

  test('video: previewImageUrl が無ければ poster なし (本体は再生できる)', () => {
    const result = resolveMediaContent(
      'video',
      JSON.stringify({ type: 'video', originalContentUrl: 'https://media.example.com/a.mp4' }),
    )
    expect(result).toEqual({ kind: 'video', url: 'https://media.example.com/a.mp4', posterUrl: null })
  })

  test('audio: duration を表示形式に変換する', () => {
    const result = resolveMediaContent(
      'audio',
      JSON.stringify({ type: 'audio', originalContentUrl: 'https://media.example.com/a.m4a', duration: 12345 }),
    )
    expect(result).toEqual({
      kind: 'audio',
      url: 'https://media.example.com/a.m4a',
      durationLabel: '0:12',
    })
  })

  test('audio: duration が無くても再生はできる', () => {
    const result = resolveMediaContent(
      'audio',
      JSON.stringify({ type: 'audio', originalContentUrl: 'https://media.example.com/a.m4a' }),
    )
    expect(result).toEqual({ kind: 'audio', url: 'https://media.example.com/a.m4a', durationLabel: null })
  })

  test('file: fileName / fileSize / 拡張子を組み立てる', () => {
    const result = resolveMediaContent(
      'file',
      JSON.stringify({
        type: 'file',
        url: 'https://media.example.com/x.pdf',
        fileName: '見積書.pdf',
        fileSize: 123456,
      }),
    )
    expect(result).toEqual({
      kind: 'file',
      url: 'https://media.example.com/x.pdf',
      fileName: '見積書.pdf',
      sizeLabel: '120.6 KB',
      extension: 'PDF',
    })
  })

  test('file: fileName が無ければ URL 末尾から補う', () => {
    const result = resolveMediaContent(
      'file',
      JSON.stringify({ type: 'file', url: 'https://media.example.com/dir/%E8%A6%8B%E7%A9%8D.pdf' }),
    )
    expect(result).toMatchObject({ kind: 'file', fileName: '見積.pdf', extension: 'PDF', sizeLabel: null })
  })

  test('file: URL 末尾からもファイル名が取れなければ既定文言', () => {
    const result = resolveMediaContent('file', JSON.stringify({ type: 'file', url: 'https://media.example.com/' }))
    expect(result).toMatchObject({ kind: 'file', fileName: UNKNOWN_FILE_NAME, extension: null })
  })
})

describe('resolveMediaContent — 従来のラベル文字列 (JSON ではない古いデータ)', () => {
  // これがこのモジュールの主目的。マイグレーション以前のメッセージは必ず残っている
  test('[動画] を渡しても落ちずにそのまま表示する', () => {
    expect(resolveMediaContent('video', '[動画]')).toEqual({ kind: 'fallback', label: '[動画]' })
  })

  test('[音声] を渡しても落ちずにそのまま表示する', () => {
    expect(resolveMediaContent('audio', '[音声]')).toEqual({ kind: 'fallback', label: '[音声]' })
  })

  test('[ファイル: 見積書.pdf] を渡しても落ちずにそのまま表示する', () => {
    expect(resolveMediaContent('file', '[ファイル: 見積書.pdf]')).toEqual({
      kind: 'fallback',
      label: '[ファイル: 見積書.pdf]',
    })
  })
})

describe('resolveMediaContent — 壊れた入力でも落ちない', () => {
  test('空文字 / 空白のみ / null / undefined は種別ラベル', () => {
    expect(resolveMediaContent('video', '')).toEqual({ kind: 'fallback', label: '🎥 動画' })
    expect(resolveMediaContent('audio', '   ')).toEqual({ kind: 'fallback', label: '🎤 音声' })
    expect(resolveMediaContent('file', null)).toEqual({ kind: 'fallback', label: '📎 ファイル' })
    expect(resolveMediaContent('video', undefined)).toEqual({ kind: 'fallback', label: '🎥 動画' })
  })

  test('途中で切れた JSON でも例外を投げない', () => {
    expect(resolveMediaContent('video', '{"type":"video","originalContentUrl":')).toEqual({
      kind: 'fallback',
      label: '{"type":"video","originalContentUrl":',
    })
  })

  test('JSON だが URL が欠けていれば種別ラベル (生の JSON は見せない)', () => {
    expect(resolveMediaContent('video', '{"type":"video"}')).toEqual({ kind: 'fallback', label: '🎥 動画' })
    expect(resolveMediaContent('audio', '{"duration":1000}')).toEqual({ kind: 'fallback', label: '🎤 音声' })
    expect(resolveMediaContent('file', '{"fileName":"a.pdf"}')).toEqual({ kind: 'fallback', label: '📎 ファイル' })
  })

  test('URL が空文字 / 非文字列でもフォールバックする', () => {
    expect(resolveMediaContent('video', '{"originalContentUrl":""}').kind).toBe('fallback')
    expect(resolveMediaContent('video', '{"originalContentUrl":123}').kind).toBe('fallback')
    expect(resolveMediaContent('file', '{"url":null}').kind).toBe('fallback')
  })

  test('http(s) 以外のスキームは href/src に入れずフォールバックする', () => {
    expect(resolveMediaContent('file', '{"url":"javascript:alert(1)"}').kind).toBe('fallback')
    expect(resolveMediaContent('video', '{"originalContentUrl":"data:video/mp4;base64,AAAA"}').kind).toBe('fallback')
  })

  test('JSON がオブジェクトでない (配列 / 数値 / 文字列) 場合もフォールバック', () => {
    expect(resolveMediaContent('video', '[1,2,3]')).toEqual({ kind: 'fallback', label: '🎥 動画' })
    expect(resolveMediaContent('video', '42')).toEqual({ kind: 'fallback', label: '🎥 動画' })
    expect(resolveMediaContent('video', '"[動画]"')).toEqual({ kind: 'fallback', label: '🎥 動画' })
  })

  test('poster だけ壊れていても本体は再生できる', () => {
    expect(
      resolveMediaContent(
        'video',
        '{"originalContentUrl":"https://media.example.com/a.mp4","previewImageUrl":"javascript:alert(1)"}',
      ),
    ).toEqual({ kind: 'video', url: 'https://media.example.com/a.mp4', posterUrl: null })
  })

  test('対象外の messageType はそのままフォールバック', () => {
    expect(resolveMediaContent('text', 'こんにちは')).toEqual({ kind: 'fallback', label: 'こんにちは' })
    expect(resolveMediaContent('location', '')).toEqual({ kind: 'fallback', label: '[location]' })
  })
})

describe('mediaFallbackLabel', () => {
  test('素のラベル文字列はそのまま', () => {
    expect(mediaFallbackLabel('file', '[ファイル: 見積書.pdf]')).toBe('[ファイル: 見積書.pdf]')
  })

  test('空なら種別ラベル', () => {
    expect(mediaFallbackLabel('video', '')).toBe('🎥 動画')
  })

  test('未知の種別は [type] 形式', () => {
    expect(mediaFallbackLabel('unknown', '')).toBe('[unknown]')
  })
})

describe('formatDuration', () => {
  test('0 ミリ秒は 0:00', () => {
    expect(formatDuration(0)).toBe('0:00')
  })

  test('1 秒未満は切り捨てて 0:00', () => {
    expect(formatDuration(999)).toBe('0:00')
  })

  test('端数は切り捨て (12345ms → 0:12)', () => {
    expect(formatDuration(12345)).toBe('0:12')
  })

  test('分の境界', () => {
    expect(formatDuration(59_999)).toBe('0:59')
    expect(formatDuration(60_000)).toBe('1:00')
    expect(formatDuration(61_000)).toBe('1:01')
    expect(formatDuration(599_000)).toBe('9:59')
  })

  test('1 時間の境界では h:mm:ss になる', () => {
    expect(formatDuration(3_599_000)).toBe('59:59')
    expect(formatDuration(3_600_000)).toBe('1:00:00')
    expect(formatDuration(3_661_000)).toBe('1:01:01')
    expect(formatDuration(36_000_000)).toBe('10:00:00')
  })

  test('数値でない / 負 / NaN / Infinity は null', () => {
    expect(formatDuration(undefined)).toBeNull()
    expect(formatDuration(null)).toBeNull()
    expect(formatDuration('12345')).toBeNull()
    expect(formatDuration(-1)).toBeNull()
    expect(formatDuration(Number.NaN)).toBeNull()
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('formatFileSize', () => {
  test('0 バイト', () => {
    expect(formatFileSize(0)).toBe('0 B')
  })

  test('1KB 未満はバイト表記', () => {
    expect(formatFileSize(1)).toBe('1 B')
    expect(formatFileSize(1023)).toBe('1023 B')
  })

  test('KB / MB / GB の境界', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB')
    expect(formatFileSize(1536)).toBe('1.5 KB')
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB')
    expect(formatFileSize(1_234_567)).toBe('1.2 MB')
    expect(formatFileSize(1024 * 1024 * 1024)).toBe('1.0 GB')
  })

  test('極端に大きい値でも最大単位で頭打ちにする', () => {
    expect(formatFileSize(Number.MAX_SAFE_INTEGER)).toBe('8.0 PB')
  })

  test('数値でない / 負 / NaN は null', () => {
    expect(formatFileSize(undefined)).toBeNull()
    expect(formatFileSize(null)).toBeNull()
    expect(formatFileSize('123456')).toBeNull()
    expect(formatFileSize(-1)).toBeNull()
    expect(formatFileSize(Number.NaN)).toBeNull()
  })
})

describe('fileExtensionLabel', () => {
  test('ファイル名から大文字で取る', () => {
    expect(fileExtensionLabel('見積書.pdf')).toBe('PDF')
    expect(fileExtensionLabel('archive.TAR')).toBe('TAR')
  })

  test('ファイル名に無ければ URL から拾う', () => {
    expect(fileExtensionLabel('見積書', 'https://media.example.com/x.docx')).toBe('DOCX')
  })

  test('URL のクエリ / フラグメントは拡張子にしない', () => {
    expect(fileExtensionLabel(null, 'https://media.example.com/x.pdf?sig=abc#p1')).toBe('PDF')
    expect(fileExtensionLabel(null, 'https://media.example.com/download?name=a')).toBeNull()
  })

  test('拡張子が無ければ null', () => {
    expect(fileExtensionLabel('README')).toBeNull()
    expect(fileExtensionLabel(undefined, undefined)).toBeNull()
    expect(fileExtensionLabel('')).toBeNull()
  })
})
