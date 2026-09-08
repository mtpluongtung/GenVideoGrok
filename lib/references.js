import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractFrame } from './video.js';

const outputsDir = path.resolve('data/outputs');

export function maxReferenceImages() {
  return Math.max(1, Number(process.env.MAX_REFERENCE_IMAGES || 3));
}

export function referenceFramePath(jobId, partNumber, kind) {
  return path.join(outputsDir, `${jobId}-ref-${String(partNumber).padStart(3, '0')}-${kind}.jpg`);
}

export function isReferenceArtifact(name, jobId) {
  return name.startsWith(`${jobId}-ref-`);
}

async function fileExists(file) {
  return fs.stat(file).then((stat) => stat.isFile() && stat.size > 0).catch(() => false);
}

/**
 * Collects the reference images for one Grok part, in the order Grok receives them.
 * User images come first because they are explicit intent, then the source frame for
 * this part's range, then the previous clip's last frame for seamless continuation.
 * A frame that cannot be extracted is skipped with a warning rather than failing the job.
 */
export async function buildPartReferences(job, {
  partNumber, sourceSeconds = null, previousPartFile = null, onWarning = () => {}
} = {}) {
  const references = [];
  for (const file of job.referenceImages || []) {
    if (await fileExists(file)) references.push({ path: file, role: 'user' });
    else onWarning('reference.user_image.missing', { file: path.basename(file) });
  }

  if (job.useReferenceFrames) {
    if (job.sourcePath && sourceSeconds != null && await fileExists(job.sourcePath)) {
      const output = referenceFramePath(job.id, partNumber, 'source');
      try {
        await extractFrame(job.sourcePath, output, { atSeconds: sourceSeconds });
        references.push({ path: output, role: 'source_frame' });
      } catch (error) {
        onWarning('reference.source_frame.failed', { partNumber, sourceSeconds, error: error.message });
      }
    }
    if (previousPartFile && await fileExists(previousPartFile)) {
      const output = referenceFramePath(job.id, partNumber, 'prev');
      try {
        await extractFrame(previousPartFile, output, { fromEnd: true });
        references.push({ path: output, role: 'previous_tail' });
      } catch (error) {
        onWarning('reference.previous_tail.failed', { partNumber, error: error.message });
      }
    }
  }

  return references.slice(0, maxReferenceImages());
}

/**
 * Hashes reference content so partFingerprint invalidates a cached clip whenever its
 * references changed. Chained references hash the previous clip's real pixels, so a
 * regenerated part correctly forces every downstream part to regenerate too.
 */
export async function referenceDigest(references = []) {
  if (!references.length) return null;
  const hash = crypto.createHash('sha256');
  for (const reference of references) {
    hash.update(reference.role);
    hash.update(await fs.readFile(reference.path));
  }
  return hash.digest('hex');
}

export async function removeReferenceFrames(references = []) {
  await Promise.all(references
    .filter((reference) => reference.role !== 'user')
    .map((reference) => fs.rm(reference.path, { force: true }).catch(() => {})));
}
