import { describe, test, expect, afterEach, vi } from 'vitest';
import {
  configureLineApiBase,
  getLineApiBase,
  getLineContentApiBase,
} from '@line-crm/line-sdk';
import { applyLineApiBase } from './line-api-base.js';
import type { Env } from '../index.js';

function env(overrides: Partial<Env['Bindings']> = {}): Env['Bindings'] {
  return overrides as Env['Bindings'];
}

afterEach(() => {
  // module スコープの上書きはファイル内でテストをまたいで残るので必ず戻す。
  configureLineApiBase({});
  vi.restoreAllMocks();
});

describe('LINE API base URL override (local dev only)', () => {
  test('環境変数が未設定なら本番 URL のまま (既存挙動を変えない)', () => {
    applyLineApiBase(env());
    expect(getLineApiBase()).toBe('https://api.line.me');
    expect(getLineContentApiBase()).toBe('https://api-data.line.me');
  });

  test('空文字は未設定と同じ扱い', () => {
    applyLineApiBase(env({ LINE_API_BASE_URL: '', LINE_CONTENT_API_BASE_URL: '   ' }));
    expect(getLineApiBase()).toBe('https://api.line.me');
    expect(getLineContentApiBase()).toBe('https://api-data.line.me');
  });

  test('設定されていればそのホストに向く / 末尾スラッシュは落とす', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    applyLineApiBase(
      env({
        LINE_API_BASE_URL: 'http://127.0.0.1:8790/',
        LINE_CONTENT_API_BASE_URL: 'http://127.0.0.1:8790',
      }),
    );
    expect(getLineApiBase()).toBe('http://127.0.0.1:8790');
    expect(getLineContentApiBase()).toBe('http://127.0.0.1:8790');
  });

  test('上書き後に未設定で呼び直すと本番 URL に戻る (isolate 再利用対策)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    applyLineApiBase(env({ LINE_API_BASE_URL: 'http://127.0.0.1:8790' }));
    expect(getLineApiBase()).toBe('http://127.0.0.1:8790');
    applyLineApiBase(env());
    expect(getLineApiBase()).toBe('https://api.line.me');
  });

  test('上書き時は必ず警告ログを残す (本番での事故に気づけるように)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    applyLineApiBase(env({ LINE_API_BASE_URL: 'http://127.0.0.1:8790' }));
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockClear();
    applyLineApiBase(env());
    expect(warn).not.toHaveBeenCalled();
  });
});
