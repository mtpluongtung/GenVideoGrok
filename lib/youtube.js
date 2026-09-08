import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { JobCancelledError, cancelRequested, throwIfCancelled } from './cancel.js';

const version = '2026.08.19';
const expectedWindowsSha256 = '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a';
const binaryPath = path.resolve('data/tools/yt-dlp.exe');

async function ensureYtDlp() {
  if (process.platform !== 'win32') throw new Error('Downloader yt-dlp tự động hiện được cấu hình cho Windows.');
  const exists = await fs.stat(binaryPath).then((stat) => stat.size > 10_000_000).catch(() => false);
  if (exists) return binaryPath;

  await fs.mkdir(path.dirname(binaryPath), { recursive: true });
  const url = `https://github.com/yt-dlp/yt-dlp/releases/download/${version}/yt-dlp.exe`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Không tải được yt-dlp: HTTP ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  const actualHash = crypto.createHash('sha256').update(body).digest('hex');
  if (actualHash !== expectedWindowsSha256) throw new Error('Checksum yt-dlp không khớp; đã hủy cài đặt để bảo vệ an toàn.');
  await fs.writeFile(binaryPath, body);
  return binaryPath;
}

export async function downloadYouTube(url, destination, onProgress = () => {}, { isCancelled = null, onSpawn = null } = {}) {
  throwIfCancelled(isCancelled, 'Đã hủy trước khi tải YouTube.');
  if (!/^https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\//i.test(url)) throw new Error('Liên kết YouTube không hợp lệ.');
  const executable = await ensureYtDlp();
  throwIfCancelled(isCancelled, 'Đã hủy trước khi bắt đầu tải YouTube.');
  await fs.mkdir(path.dirname(destination), { recursive: true });

  return new Promise((resolve, reject) => {
    let killedByCancel = false;
    const args = [
      '--no-playlist', '--newline', '--js-runtimes', 'node',
      '--ffmpeg-location', path.dirname(ffmpegPath),
      '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b', '--merge-output-format', 'mp4',
      '--progress-template', 'download:%(progress._percent_str)s', '-o', destination, url
    ];
    const child = spawn(executable, args, { windowsHide: true });
    if (typeof onSpawn === 'function') onSpawn(child);

    let stderr = '';
    const consume = (chunk) => {
      if (cancelRequested(isCancelled) && !killedByCancel) {
        killedByCancel = true;
        try { child.kill(); } catch {}
        reject(new JobCancelledError('Đã hủy trong lúc tải YouTube.'));
        return;
      }
      const match = chunk.toString().match(/download:\s*([\d.]+)%/);
      if (match) onProgress(Number(match[1]) / 100);
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', (chunk) => { stderr += chunk; consume(chunk); });
    child.on('error', (error) => {
      if (killedByCancel || cancelRequested(isCancelled)) {
        reject(new JobCancelledError('Đã hủy trong lúc tải YouTube.'));
      } else {
        reject(error);
      }
    });
    child.on('close', async (code) => {
      if (killedByCancel || cancelRequested(isCancelled)) {
        await fs.rm(destination, { force: true }).catch(() => {});
        reject(new JobCancelledError('Đã hủy trong lúc tải YouTube.'));
        return;
      }
      const valid = await fs.stat(destination).then((stat) => stat.size > 0).catch(() => false);
      if (code === 0 && valid) resolve(destination);
      else reject(new Error(`yt-dlp thất bại (${code}): ${stderr.slice(-1500)}`));
    });
  });
}
