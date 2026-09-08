import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { extractFrame } from '../lib/video.js';
import { buildPartReferences, referenceDigest, removeReferenceFrames } from '../lib/references.js';

const outputsDir = path.resolve('data/outputs');

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg test thất bại (${code}): ${stderr.slice(-1000)}`));
    });
  });
}

async function makeMovingClip(output, duration, { size = '160x120', fps = 10 } = {}) {
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=${fps}:duration=${duration}`,
    '-t', String(duration), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', output]);
}

async function makeSolidClip(output, duration, color, { size = '160x120', fps = 10 } = {}) {
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:r=${fps}:d=${duration}`,
    '-t', String(duration), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', output]);
}

async function sandbox(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-references-'));
  const jobId = `test-${crypto.randomUUID()}`;
  await fs.mkdir(outputsDir, { recursive: true });
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    const leftovers = (await fs.readdir(outputsDir).catch(() => []))
      .filter((name) => name.startsWith(`${jobId}-`));
    await Promise.all(leftovers.map((name) => fs.rm(path.join(outputsDir, name), { force: true })));
  });
  return { root, jobId };
}

test('trích được frame khác nhau ở hai mốc thời gian của video nguồn', async (t) => {
  const { root } = await sandbox(t);
  const source = path.join(root, 'source.mp4');
  await makeMovingClip(source, 6);

  const early = path.join(root, 'early.jpg');
  const late = path.join(root, 'late.jpg');
  await extractFrame(source, early, { atSeconds: 0.5 });
  await extractFrame(source, late, { atSeconds: 5 });

  const [earlyBytes, lateBytes] = await Promise.all([fs.readFile(early), fs.readFile(late)]);
  assert.ok(earlyBytes.length > 256, `Frame đầu quá nhỏ: ${earlyBytes.length} byte`);
  assert.notEqual(earlyBytes.toString('base64'), lateBytes.toString('base64'));
});

test('trích được frame cuối clip bằng sseof', async (t) => {
  const { root } = await sandbox(t);
  const clip = path.join(root, 'clip.mp4');
  await makeMovingClip(clip, 4);
  const tail = path.join(root, 'tail.jpg');
  await extractFrame(clip, tail, { fromEnd: true });
  const stat = await fs.stat(tail);
  assert.ok(stat.size > 256, `Frame cuối quá nhỏ: ${stat.size} byte`);
});

test('gom ảnh tham chiếu đúng thứ tự: ảnh người dùng, frame nguồn, rồi frame cuối đoạn trước', async (t) => {
  const { root, jobId } = await sandbox(t);
  const source = path.join(root, 'source.mp4');
  const previous = path.join(root, 'part-001.mp4');
  const userImage = path.join(root, 'user.jpg');
  await makeMovingClip(source, 6);
  await makeSolidClip(previous, 2, 'red');
  await extractFrame(source, userImage, { atSeconds: 1 });

  const references = await buildPartReferences({
    id: jobId, sourcePath: source, useReferenceFrames: true, referenceImages: [userImage]
  }, { partNumber: 2, sourceSeconds: 3, previousPartFile: previous });

  assert.deepEqual(references.map((item) => item.role), ['user', 'source_frame', 'previous_tail']);
  assert.equal(references[0].path, userImage);
  for (const reference of references) {
    assert.ok((await fs.stat(reference.path)).size > 0, `Thiếu tệp ${reference.path}`);
  }
});

test('tắt frame tự động thì chỉ còn ảnh do người dùng tải lên', async (t) => {
  const { root, jobId } = await sandbox(t);
  const source = path.join(root, 'source.mp4');
  const userImage = path.join(root, 'user.jpg');
  await makeMovingClip(source, 4);
  await extractFrame(source, userImage, { atSeconds: 1 });

  const references = await buildPartReferences({
    id: jobId, sourcePath: source, useReferenceFrames: false, referenceImages: [userImage]
  }, { partNumber: 1, sourceSeconds: 2, previousPartFile: null });

  assert.deepEqual(references.map((item) => item.role), ['user']);
});

test('bỏ qua ảnh người dùng đã mất và ghi cảnh báo thay vì làm hỏng job', async (t) => {
  const { root, jobId } = await sandbox(t);
  const source = path.join(root, 'source.mp4');
  await makeMovingClip(source, 4);
  const warnings = [];

  const references = await buildPartReferences({
    id: jobId, sourcePath: source, useReferenceFrames: true, referenceImages: [path.join(root, 'missing.jpg')]
  }, { partNumber: 1, sourceSeconds: 2, onWarning: (event) => warnings.push(event) });

  assert.deepEqual(references.map((item) => item.role), ['source_frame']);
  assert.deepEqual(warnings, ['reference.user_image.missing']);
});

test('giới hạn số ảnh tham chiếu theo MAX_REFERENCE_IMAGES', async (t) => {
  const { root, jobId } = await sandbox(t);
  const previousValue = process.env.MAX_REFERENCE_IMAGES;
  process.env.MAX_REFERENCE_IMAGES = '2';
  t.after(() => {
    if (previousValue === undefined) delete process.env.MAX_REFERENCE_IMAGES;
    else process.env.MAX_REFERENCE_IMAGES = previousValue;
  });

  const source = path.join(root, 'source.mp4');
  const previous = path.join(root, 'part-001.mp4');
  const userImage = path.join(root, 'user.jpg');
  await makeMovingClip(source, 6);
  await makeSolidClip(previous, 2, 'red');
  await extractFrame(source, userImage, { atSeconds: 1 });

  const references = await buildPartReferences({
    id: jobId, sourcePath: source, useReferenceFrames: true, referenceImages: [userImage]
  }, { partNumber: 2, sourceSeconds: 3, previousPartFile: previous });

  assert.deepEqual(references.map((item) => item.role), ['user', 'source_frame']);
});

test('digest đổi khi clip trước đổi nội dung, giữ nguyên khi nội dung không đổi', async (t) => {
  const { root, jobId } = await sandbox(t);
  const redPrevious = path.join(root, 'prev-red.mp4');
  const greenPrevious = path.join(root, 'prev-green.mp4');
  await makeSolidClip(redPrevious, 2, 'red');
  await makeSolidClip(greenPrevious, 2, 'green');
  const job = { id: jobId, sourcePath: null, useReferenceFrames: true, referenceImages: [] };

  const first = await referenceDigest(await buildPartReferences(job, { partNumber: 2, previousPartFile: redPrevious }));
  const repeat = await referenceDigest(await buildPartReferences(job, { partNumber: 2, previousPartFile: redPrevious }));
  const changed = await referenceDigest(await buildPartReferences(job, { partNumber: 2, previousPartFile: greenPrevious }));

  assert.equal(first, repeat, 'Cùng một clip trước phải cho digest giống nhau để part cũ còn tái dùng được');
  assert.notEqual(first, changed, 'Clip trước đổi thì part sau phải được tạo lại');
  assert.equal(await referenceDigest([]), null);
});

test('dọn frame tạm nhưng giữ lại ảnh của người dùng', async (t) => {
  const { root, jobId } = await sandbox(t);
  const source = path.join(root, 'source.mp4');
  const userImage = path.join(root, 'user.jpg');
  await makeMovingClip(source, 4);
  await extractFrame(source, userImage, { atSeconds: 1 });

  const references = await buildPartReferences({
    id: jobId, sourcePath: source, useReferenceFrames: true, referenceImages: [userImage]
  }, { partNumber: 1, sourceSeconds: 2 });
  await removeReferenceFrames(references);

  const derived = references.find((item) => item.role === 'source_frame');
  assert.equal(await fs.stat(derived.path).then(() => true).catch(() => false), false);
  assert.equal(await fs.stat(userImage).then(() => true).catch(() => false), true);
});
