import { redactFacebookSecrets } from './facebook.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const logsDir = path.resolve('data/logs');

export function jobLogPath(jobId) {
  return path.join(logsDir, `${jobId}.log`);
}

export async function logJob(jobId, event, details = {}) {
  await fs.mkdir(logsDir, { recursive: true });
  const entry = JSON.stringify({ time: new Date().toISOString(), event, ...details });
  await fs.appendFile(jobLogPath(jobId), `${entry}\n`, 'utf8');
}

export function sanitizeError(error) {
  return redactFacebookSecrets((error?.message || String(error))
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/^\s*- cookie:.*$/gmi, '    - cookie: [redacted]'));
}
