#!/usr/bin/env node
/**
 * scripts/dev/make-fixtures.mjs
 *
 * ローカル開発用のテストメディアを scripts/dev/fixtures/ に生成する。
 * ここで作ったファイルは LINE モックサーバー (scripts/dev/line-mock-server.mjs)
 * が Content API のレスポンスとして配る。
 *
 *   node scripts/dev/make-fixtures.mjs
 *
 * 生成物 (すべてブラウザで再生 / 表示できる実ファイル):
 *   sample-video.mp4          H.264 baseline + AAC。<video> で再生できる
 *   sample-video-preview.jpg  上のサムネイル (Content API の /content/preview 用)
 *   sample-audio.m4a          AAC (audio/mp4)。<audio> で再生できる
 *   sample-image.jpg          既存の受信画像フローの回帰確認用
 *   見積書.pdf                 日本語ファイル名でのダウンロード確認用の最小 PDF
 *
 * 動画・音声の生成には ffmpeg を使う。探索順は
 *   1. PATH 上の ffmpeg
 *   2. `uvx --from imageio-ffmpeg ...` が持つ同梱バイナリ (要ネットワーク)
 *   3. どちらも無ければ scripts/dev/fallback-media.mjs の埋め込みバイナリ
 * で、3 のときも「小さいが有効な」mp4 / m4a が出るので確認自体は成立する。
 *
 * fixtures/ は .gitignore 済み。生成物 (バイナリ) はコミットしない。
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FALLBACK_VIDEO_MP4_B64,
  FALLBACK_VIDEO_PREVIEW_JPEG_B64,
  FALLBACK_AUDIO_M4A_B64,
  FALLBACK_IMAGE_JPEG_B64,
} from './fallback-media.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(HERE, 'fixtures');

export const FIXTURE_FILES = {
  video: 'sample-video.mp4',
  videoPreview: 'sample-video-preview.jpg',
  audio: 'sample-audio.m4a',
  image: 'sample-image.jpg',
  // 日本語ファイル名のまま置く。R2 の customMetadata では percent-encode されるが、
  // ここは「日本語名のファイルをダウンロードできるか」を通しで見るためのもの。
  pdf: '見積書.pdf',
};

// ─── PDF ────────────────────────────────────────────────────────────────────
// 依存なしで「実際に開ける」最小の PDF を組み立てる。xref のオフセットは
// バイト位置で決まるので、オブジェクトを順に連結しながら実測して書く。
// 本文が ASCII なのは意図的 — 日本語をページ内に描画するには CID フォントの
// 埋め込みが要り、「日本語ファイル名でダウンロードできるか」という確認目的に
// 対して割に合わないため。ファイル名だけは日本語 (見積書.pdf)。
export function buildMinimalPdf(lines) {
  const escape = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const text = lines
    .map((line, i) => `${i === 0 ? '' : 'T*\n'}(${escape(line)}) Tj\n`)
    .join('');
  const stream = `BT\n/F1 16 Tf\n20 TL\n72 720 Td\n${text}ET\n`;

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] '
      + '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

// ─── ffmpeg 探索 ────────────────────────────────────────────────────────────
function tryRun(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function findFfmpeg() {
  if (tryRun('ffmpeg', ['-hide_banner', '-version'])) {
    return { run: (args) => execFileSync('ffmpeg', args, { stdio: 'ignore' }), how: 'PATH の ffmpeg' };
  }
  // imageio-ffmpeg は静的ビルドの ffmpeg を同梱している。uv があれば
  // インストール不要で借りられる (初回のみダウンロード)。
  try {
    const path = execFileSync(
      'uvx',
      ['--quiet', '--from', 'imageio-ffmpeg', 'python', '-c',
       'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (path && existsSync(path) && tryRun(path, ['-hide_banner', '-version'])) {
      return { run: (args) => execFileSync(path, args, { stdio: 'ignore' }), how: `uvx imageio-ffmpeg (${path})` };
    }
  } catch {
    // uv が無い / オフライン。埋め込みフォールバックへ。
  }
  return null;
}

function generateWithFfmpeg(ffmpeg, out) {
  const base = ['-y', '-hide_banner', '-loglevel', 'error'];

  // 動くタイマー付きのテストパターン + 440Hz のトーン。
  // 「本当に再生されているか」が目で見て耳で聞いて分かる素材にしてある。
  ffmpeg.run([
    ...base,
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=4',
    '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.0',
    '-pix_fmt', 'yuv420p', '-crf', '32',
    '-c:a', 'aac', '-b:a', '48k', '-shortest',
    // faststart: moov を先頭に置く。ブラウザが全体をダウンロードし切る前に
    // 再生を始められるようにする (ローカルでは体感しないが実運用に近い形にする)。
    '-movflags', '+faststart',
    join(out, FIXTURE_FILES.video),
  ]);

  ffmpeg.run([
    ...base,
    '-i', join(out, FIXTURE_FILES.video),
    '-frames:v', '1', '-q:v', '8', '-vf', 'scale=200:-1',
    join(out, FIXTURE_FILES.videoPreview),
  ]);

  ffmpeg.run([
    ...base,
    '-f', 'lavfi', '-i', 'sine=frequency=523.25:sample_rate=44100:duration=4',
    '-c:a', 'aac', '-b:a', '64k',
    join(out, FIXTURE_FILES.audio),
  ]);

  ffmpeg.run([
    ...base,
    '-f', 'lavfi', '-i', 'testsrc=size=400x300:rate=1:duration=1',
    '-frames:v', '1', '-q:v', '7',
    join(out, FIXTURE_FILES.image),
  ]);
}

function generateFromFallback(out) {
  const write = (name, b64) => writeFileSync(join(out, name), Buffer.from(b64, 'base64'));
  write(FIXTURE_FILES.video, FALLBACK_VIDEO_MP4_B64);
  write(FIXTURE_FILES.videoPreview, FALLBACK_VIDEO_PREVIEW_JPEG_B64);
  write(FIXTURE_FILES.audio, FALLBACK_AUDIO_M4A_B64);
  write(FIXTURE_FILES.image, FALLBACK_IMAGE_JPEG_B64);
}

export function makeFixtures({ dir = FIXTURES_DIR } = {}) {
  mkdirSync(dir, { recursive: true });

  writeFileSync(
    join(dir, FIXTURE_FILES.pdf),
    buildMinimalPdf([
      'L Harness - local dev fixture',
      '',
      'This PDF is generated by scripts/dev/make-fixtures.mjs',
      'and served by the local LINE Messaging API mock.',
      '',
      'It exists to verify that an incoming LINE file message',
      'is stored in R2 and can be downloaded from the admin',
      'chat screen under its original (Japanese) file name.',
    ]),
  );

  const ffmpeg = findFfmpeg();
  if (ffmpeg) {
    generateWithFfmpeg(ffmpeg, dir);
    return { how: ffmpeg.how, dir };
  }
  generateFromFallback(dir);
  return { how: '埋め込みフォールバック (ffmpeg 無し)', dir };
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const result = makeFixtures();
  console.log(`fixtures: ${result.dir}`);
  console.log(`source  : ${result.how}`);
  for (const name of Object.values(FIXTURE_FILES)) {
    console.log(`  - ${name}`);
  }
}
