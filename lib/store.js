import fs from 'node:fs/promises';
import path from 'node:path';

const dataDir = path.resolve('data');
const file = path.join(dataDir, 'jobs.json');
const temporaryFile = path.join(dataDir, 'jobs.json.tmp');
let saveChain = Promise.resolve();

export async function ensureDirectories() {
  await Promise.all(['uploads', 'outputs', 'logs', 'browser-profile', 'chatgpt-browser-profile'].map((name) =>
    fs.mkdir(path.join(dataDir, name), { recursive: true })));
}

export async function loadJobs() {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`Không đọc được data/jobs.json: ${error.message}`);
  }
}

export function saveJobs(jobs) {
  const payload = JSON.stringify(jobs, null, 2);
  const operation = saveChain.then(async () => {
    await fs.writeFile(temporaryFile, payload, 'utf8');
    await fs.rename(temporaryFile, file);
  });
  saveChain = operation.catch(() => {});
  return operation;
}

export { dataDir };
