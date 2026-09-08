import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { aspectRatioMatches, getDuration, getVideoMetadata, inferAspectRatio, inferVideoResolution, joinParts } from '../lib/video.js';

test('nhận diện và kiểm tra đúng tỷ lệ khung hình nguồn', () => {
  assert.equal(inferAspectRatio(1920, 1080), '16:9');
  assert.equal(inferAspectRatio(1080, 1920), '9:16');
  assert.equal(inferAspectRatio(1000, 1000), '1:1');
  assert.equal(inferAspectRatio(1440, 1080), '3:2');
  assert.equal(inferAspectRatio(1080, 1440), '2:3');
  assert.equal(aspectRatioMatches(1904, 1072, '16:9'), true);
  assert.equal(aspectRatioMatches(1072, 1904, '16:9'), false);
});

test('nhận diện chất lượng thực tế 1080p, 720p và 480p', () => {
  assert.equal(inferVideoResolution(1904, 1072), '1080p');
  assert.equal(inferVideoResolution(1280, 720), '720p');
  assert.equal(inferVideoResolution(720, 1280), '720p');
  assert.equal(inferVideoResolution(854, 480), '480p');
});

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

async function makeClip(output, duration, color = 'blue', { size = '160x90', fps = 10, audioDuration = 0 } = {}) {
  const args = ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:r=${fps}:d=${duration}`];
  if (audioDuration) args.push('-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${audioDuration}`);
  args.push('-t', String(duration), '-c:v', 'libx264', '-pix_fmt', 'yuv420p');
  if (audioDuration) args.push('-c:a', 'aac');
  args.push(output);
  await runFfmpeg(args);
}

test('FFmpeg giữ nguyên hai clip Grok 10 giây khi ghép', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-video-join-'));
  const first = path.join(root, 'part-001.mp4');
  const second = path.join(root, 'part-002.mp4');
  const output = path.join(root, 'output.mp4');
  const jobId = `test-${crypto.randomUUID()}`;
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  await makeClip(first, 10, 'red');
  await makeClip(second, 10, 'green');
  await joinParts([first, second], output, jobId, { targetWidth: 160, targetHeight: 90, fps: 10 });

  const duration = await getDuration(output);
  assert.ok(duration >= 19.5 && duration <= 20.5, `Thời lượng nhận được: ${duration}s`);
});

test('FFmpeg chuẩn hóa clip khác kích thước, FPS và audio trước khi ghép', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-video-normalize-'));
  const first = path.join(root, 'part-001.mp4');
  const second = path.join(root, 'part-002.mp4');
  const output = path.join(root, 'output.mp4');
  const jobId = `test-${crypto.randomUUID()}`;
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  await makeClip(first, 1, 'red', { size: '320x180', fps: 12, audioDuration: 0.7 });
  await makeClip(second, 0.8, 'green', { size: '240x180', fps: 25 });
  await joinParts([first, second], output, jobId, { targetWidth: 320, targetHeight: 180, fps: 30 });

  const metadata = await getVideoMetadata(output);
  assert.equal(metadata.width, 320);
  assert.equal(metadata.height, 180);
  assert.equal(metadata.frameRate, 30);
  assert.equal(metadata.hasAudio, true);
  assert.ok(metadata.duration >= 1.7 && metadata.duration <= 1.95, `Thời lượng nhận được: ${metadata.duration}s`);
});

test('FFmpeg dùng canvas 720p khi Grok phải fallback', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-video-720p-'));
  const first = path.join(root, 'part-001.mp4');
  const second = path.join(root, 'part-002.mp4');
  const output = path.join(root, 'output.mp4');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  await makeClip(first, 0.5, 'blue', { size: '320x180', fps: 10 });
  await makeClip(second, 0.5, 'green', { size: '320x180', fps: 10 });
  await joinParts([first, second], output, 'test-720p', { aspectRatio: '16:9', resolution: '720p', fps: 10 });

  const metadata = await getVideoMetadata(output);
  assert.equal(metadata.width, 1280);
  assert.equal(metadata.height, 720);
});
