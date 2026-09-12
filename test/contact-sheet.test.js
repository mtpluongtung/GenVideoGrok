import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { extractContactSheets } from '../lib/video.js';
import { describeContactSheets } from '../lib/chatgpt.js';

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`FFmpeg test thất bại (${code}): ${stderr.slice(-800)}`))));
  });
}

async function sandbox(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'contact-sheet-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return root;
}

async function makeClip(file, seconds) {
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', `testsrc=size=320x180:rate=15:duration=${seconds}`,
    '-t', String(seconds), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
}

test('video 37 giây được trích thành 19 khung hình trên 3 ảnh ghép, kể cả ảnh cuối chưa đầy', async (t) => {
  const root = await sandbox(t);
  const source = path.join(root, 'source.mp4');
  await makeClip(source, 37);

  const sheets = await extractContactSheets(source, path.join(root, 'job-ref-sheet'), { duration: 37 });

  assert.equal(sheets.length, 3);
  assert.deepEqual(sheets.map((sheet) => sheet.frames), [9, 9, 1]);
  assert.equal(sheets[0].startSeconds, 0);
  assert.ok(sheets.at(-1).endSeconds <= 37, `Ảnh cuối vượt thời lượng nguồn: ${sheets.at(-1).endSeconds}`);
  for (const sheet of sheets) {
    assert.ok((await fs.stat(sheet.path)).size > 1000, `Ảnh ghép rỗng: ${sheet.path}`);
  }
});

test('video ngắn vẫn có đủ số khung hình tối thiểu trong một ảnh ghép', async (t) => {
  const root = await sandbox(t);
  const source = path.join(root, 'short.mp4');
  await makeClip(source, 4);

  const sheets = await extractContactSheets(source, path.join(root, 'short-ref-sheet'), { duration: 4 });
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].frames, 6);
});

test('video dài bị giới hạn số khung hình để không gửi quá nhiều ảnh cho ChatGPT', async (t) => {
  const root = await sandbox(t);
  const source = path.join(root, 'long.mp4');
  await makeClip(source, 120);

  const sheets = await extractContactSheets(source, path.join(root, 'long-ref-sheet'), { duration: 120 });
  assert.equal(sheets.reduce((sum, sheet) => sum + sheet.frames, 0), 36);
  assert.equal(sheets.length, 4);
});

test('từ chối khi không biết thời lượng video', async () => {
  await assert.rejects(extractContactSheets('missing.mp4', 'x', { duration: 0 }), /thời lượng video/);
});

test('ghi chú khung hình nói rõ thứ tự đọc, khoảng thời gian và yêu cầu tái tạo lời thoại', () => {
  const note = describeContactSheets([
    { path: 'a.jpg', frames: 9, startSeconds: 0, endSeconds: 17.5 },
    { path: 'b.jpg', frames: 3, startSeconds: 17.5, endSeconds: 23 }
  ]);
  assert.match(note, /left-to-right then top-to-bottom/);
  assert.match(note, /spoken dialogue/i);
  assert.match(note, /Sheet 1: 9 frames covering 0\.0s–17\.5s/);
  assert.match(note, /Sheet 2: 3 frames covering 17\.5s–23\.0s/);
  assert.equal(describeContactSheets([]), '');
});
