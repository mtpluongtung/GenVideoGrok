import express from 'express';
import multer from 'multer';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { ensureDirectories, loadJobs, saveJobs, dataDir } from './lib/store.js';
import { logJob, sanitizeError } from './lib/logger.js';
import { downloadYouTube } from './lib/youtube.js';
import { openLogin, inspectGrokPage, inspectLatestGeneration, configureGrokSettings, generateWithGrok, captureGrokDiagnostics, clipDurationWindow, closeBrowser, abortGrok } from './lib/grok.js';
import {
  analyzeVideoWithGemini,
  captureGeminiDiagnostics,
  closeGeminiBrowser,
  abortGemini,
  generateAutoTopicWithGemini,
  generateMasterStoryWithGemini,
  generateStoryFromVideoWithGemini,
  generateStoryThumbnailWithGemini,
  generateStoryboardFromStoryWithGemini,
  generateTopicStoryWithGemini,
  inspectGeminiPage,
  openGeminiLogin
} from './lib/gemini.js';
import { buildGrokAutoTopicPartJob, buildGrokTextPartJob, buildGrokTopicPartJob, buildGrokTopicStoryPartJob, countWords, expectedPartCount, formatGeminiStoryText } from './lib/prompt-plan.js';
import { normalizeVideoLanguage, parseBooleanOption, parseTargetDuration, preferredClipSeconds, trendDateKey, videoLanguageLabel } from './lib/job-options.js';
import { aspectRatioMatches, getVideoMetadata, inferAspectRatio, inferVideoResolution, joinParts } from './lib/video.js';
import { buildPartReferences, isReferenceArtifact, maxReferenceImages, referenceDigest, removeReferenceFrames } from './lib/references.js';
import { isCancellation, throwIfCancelled } from './lib/cancel.js';
import { REEL_LIMITS, buildReelDescription, facebookConfig, facebookConfigured, publishReel, reelRejectionReason } from './lib/facebook.js';
import { publishStoryToTrendflare, trendflareConfig, trendflareConfigured, redactTrendflareSecrets } from './lib/trendflare.js';

await ensureDirectories();
const app = express();
const maxReferenceImageBytes = 20 * 1024 ** 2;
const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(dataDir, 'uploads'),
    filename: (_req, file, callback) => {
      const fallback = file.fieldname === 'referenceImages' ? '.jpg' : '.mp4';
      const extension = path.extname(file.originalname).toLowerCase() || fallback;
      callback(null, `${crypto.randomUUID()}${extension}`);
    }
  }),
  limits: { fileSize: 1024 ** 3 },
  fileFilter: (_req, file, callback) => {
    if (file.fieldname === 'referenceImages' && !/^image\//i.test(file.mimetype)) {
      callback(new Error('Ảnh tham chiếu phải là tệp ảnh.'));
      return;
    }
    callback(null, true);
  }
});
const uploadFields = upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'referenceImages', maxCount: 8 }
]);

function allUploadedFiles(request) {
  return Object.values(request.files || {}).flat();
}

async function removeUploadedFiles(request) {
  await Promise.all(allUploadedFiles(request).map((file) => fs.rm(file.path, { force: true }).catch(() => {})));
}

function receiveUpload(request, response, next) {
  uploadFields(request, response, async (error) => {
    if (!error) { next(); return; }
    await removeUploadedFiles(request);
    response.status(400).json({ error: error.message || 'Không nhận được tệp tải lên.' });
  });
}
const clipSeconds = preferredClipSeconds();

// Jobs saved before the clip length became configurable were all planned as 10-second parts.
// Pin them so a retry keeps reusing their cached plan and clips instead of re-cutting at 15s.
function clipSecondsOf(job) {
  return Number(job?.clipSeconds) || 10;
}

let jobs = await loadJobs();
for (const job of jobs) {
  job.clipSeconds = clipSecondsOf(job);
  job.cancelRequested = false;
  if (job.error) job.error = sanitizeError(job.error);
}
for (const interrupted of jobs.filter((job) => job.status === 'running')) {
  interrupted.status = 'failed';
  interrupted.message = 'Bị gián đoạn';
  interrupted.error = 'Server đã khởi động lại khi tác vụ đang chạy. Hãy tạo lại tác vụ.';
  interrupted.logUrl ||= `/logs/${interrupted.id}.log`;
  await logJob(interrupted.id, 'job.interrupted', { reason: 'server_restart' });
}
await saveJobs(jobs);
let working = false;
let activeJobCanceller = null;

function publicJob(job) {
  const {
    sourcePath: _sourcePath, geminiPlan: _geminiPlan, geminiStory: _geminiStory,
    referenceImages: _referenceImages, ...safe
  } = job;
  const language = job.language || 'auto';
  return {
    ...safe,
    referenceImageCount: job.referenceImages?.length || 0,
    useReferenceFrames: Boolean(job.useReferenceFrames),
    autoStoryUpload: Boolean(job.autoStoryUpload),
    trendflareStatus: job.trendflareStatus || null,
    trendflarePostSlug: job.trendflarePostSlug || null,
    trendflarePostUrl: job.trendflarePostUrl || null,
    trendflareFeaturedImageUrl: job.trendflareFeaturedImageUrl || null,
    trendflareError: job.trendflareError || null,
    thumbnailUrl: job.thumbnailUrl || null,
    language,
    languageLabel: language === 'auto'
      ? (job.type === 'topic' ? 'Theo chủ đề' : 'Theo ngôn ngữ nguồn')
      : videoLanguageLabel(language),
    clipSeconds: clipSecondsOf(job),
    durationMode: job.targetDuration != null || job.type === 'topic' ? 'custom' : 'auto',
    targetDuration: job.targetDuration ?? (job.type === 'topic' ? clipSecondsOf(job) : null),
    outputResolution: job.outputResolution || inferVideoResolution(job.outputWidth, job.outputHeight)
  };
}

function saveJobsInBackground(job) {
  void saveJobs(jobs).catch((error) => {
    console.error(`Không lưu được trạng thái job ${job.id}:`, error);
    void logJob(job.id, 'job.state.save.failed', { error: sanitizeError(error) }).catch(() => {});
  });
}

app.use(express.json());
app.use(express.static('public'));
app.use('/outputs', express.static(path.join(dataDir, 'outputs')));
app.use('/logs', express.static(path.join(dataDir, 'logs')));

app.get('/api/config', (_req, res) => res.json({
  facebookConfigured: facebookConfigured(),
  trendflareConfigured: trendflareConfigured(),
  reelMaxSeconds: REEL_LIMITS.maxSeconds,
  clipSeconds,
  maxParts: Math.max(1, Number(process.env.MAX_VIDEO_PARTS || 30)),
  maxReferenceImages: maxReferenceImages()
}));
app.get('/api/jobs', (_req, res) => res.json(jobs.map(publicJob)));
const resumableStatuses = ['failed', 'cancelled'];

app.post('/api/jobs/:id/cancel', async (req, res) => {
  const job = jobs.find((item) => item.id === req.params.id);
  if (!job || !['queued', 'running'].includes(job.status)) {
    return res.status(409).json({ error: 'Chỉ có thể hủy tác vụ đang chờ hoặc đang chạy.' });
  }
  if (job.status === 'queued') {
    await patchJob(job, { status: 'cancelled', stage: null, message: 'Đã hủy', cancelRequested: false });
    await logJob(job.id, 'job.cancelled', { from: 'queued' });
    return res.json(publicJob(job));
  }
  await patchJob(job, { cancelRequested: true, message: 'Đang hủy…' });
  await logJob(job.id, 'job.cancel.requested', { stage: job.stage || null });
  if (activeJobCanceller) {
    try {
      activeJobCanceller();
    } catch (err) {
      console.error(`Lỗi khi kích hoạt hủy job ${job.id}:`, err);
    }
  }
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline && job.status === 'running') {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  res.json(publicJob(job));
});

app.post('/api/jobs/:id/retry', async (req, res) => {
  const job = jobs.find((item) => item.id === req.params.id);
  if (!job || !resumableStatuses.includes(job.status)) {
    return res.status(409).json({ error: 'Chỉ có thể thử lại tác vụ đã lỗi hoặc đã hủy.' });
  }
  if (job.type === 'upload' && (!job.sourcePath || !await fs.stat(job.sourcePath).then(() => true).catch(() => false))) {
    return res.status(410).json({ error: 'Video nguồn không còn tồn tại.' });
  }
  const missingRetryReference = await firstMissingReferenceImage(job);
  if (missingRetryReference) {
    return res.status(410).json({ error: `Ảnh tham chiếu ${path.basename(missingRetryReference)} không còn tồn tại.` });
  }
  await patchJob(job, { status: 'queued', message: 'Đang chờ thử lại', error: null, outputUrl: null, cancelRequested: false });
  await logJob(job.id, 'job.retry.queued');
  res.json(publicJob(job)); void runQueue();
});
app.post('/api/jobs/:id/rerun', async (req, res) => {
  const job = jobs.find((item) => item.id === req.params.id);
  if (!job || !['done', ...resumableStatuses].includes(job.status)) {
    return res.status(409).json({ error: 'Chỉ có thể tạo lại tác vụ đã hoàn tất, đã lỗi hoặc đã hủy.' });
  }
  if (job.type === 'upload' && (!job.sourcePath || !await fs.stat(job.sourcePath).then(() => true).catch(() => false))) {
    return res.status(410).json({ error: 'Video nguồn không còn tồn tại.' });
  }
  const missingRerunReference = await firstMissingReferenceImage(job);
  if (missingRerunReference) {
    return res.status(410).json({ error: `Ảnh tham chiếu ${path.basename(missingRerunReference)} không còn tồn tại.` });
  }
  // "Tạo lại" chỉ dựng lại video: giữ nguyên kế hoạch Gemini đã cache, nhưng xóa clip cũ để
  // Grok thực sự tạo lại thay vì tái dùng đúng những đoạn đã có (khác với "Thử lại").
  const discarded = await removeJobArtifacts(job.id);
  await patchJob(job, {
    status: 'queued', stage: null, message: 'Đang chờ tạo lại', error: null, outputUrl: null,
    outputDuration: null, outputWidth: null, outputHeight: null, outputResolution: null, segmentCount: null,
    cancelRequested: false, reelStatus: job.postToReels ? 'pending' : null, reelUrl: null, reelError: null
  });
  await logJob(job.id, 'job.rerun.queued', {
    reuseGeminiPlan: Boolean(job.geminiPlan?.parts?.length), discardedParts: discarded
  });
  res.json(publicJob(job)); void runQueue();
});
app.post('/api/login', async (_req, res) => {
  if (working) return res.status(409).json({ error: 'Hàng đợi đang chạy; không thể điều khiển cửa sổ Grok lúc này.' });
  try { res.json(await openLogin()); } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/login/grok', async (_req, res) => {
  if (working) return res.status(409).json({ error: 'Hàng đợi đang chạy; không thể điều khiển cửa sổ Grok lúc này.' });
  try { res.json(await openLogin()); } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/login/gemini', async (_req, res) => {
  if (working) return res.status(409).json({ error: 'Hàng đợi đang chạy; không thể điều khiển cửa sổ Gemini lúc này.' });
  try { res.json(await openGeminiLogin()); } catch (error) { res.status(500).json({ error: error.message }); }
});
app.get('/api/debug/grok', async (_req, res) => {
  try { res.json(await inspectGrokPage()); } catch (error) { res.status(500).json({ error: error.message }); }
});
app.get('/api/debug/gemini', async (_req, res) => {
  try { res.json(await inspectGeminiPage()); } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/debug/grok/latest', async (_req, res) => {
  if (working) return res.status(409).json({ error: 'Hàng đợi đang chạy.' });
  try { res.json(await inspectLatestGeneration()); } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/debug/grok/settings', async (req, res) => {
  if (working) return res.status(409).json({ error: 'Hàng đợi đang chạy.' });
  try { res.json(await configureGrokSettings(req.body.aspectRatio || null)); }
  catch (error) { res.status(500).json({ error: sanitizeError(error) }); }
});
app.post('/api/jobs', receiveUpload, async (req, res) => {
  const type = req.body.type;
  const videoFile = req.files?.video?.[0] || null;
  const referenceFiles = req.files?.referenceImages || [];
  const reject = async (message) => {
    await removeUploadedFiles(req);
    res.status(400).json({ error: message });
  };
  if (!['topic', 'youtube', 'upload'].includes(type)) { await reject('Loại đầu vào không hợp lệ.'); return; }
  if (type === 'upload' && !videoFile) { await reject('Hãy chọn video nguồn.'); return; }
  if (type === 'youtube' && !req.body.youtubeUrl) { await reject('Hãy nhập link YouTube.'); return; }
  const oversized = referenceFiles.find((file) => file.size > maxReferenceImageBytes);
  if (oversized) {
    await reject(`Ảnh tham chiếu ${oversized.originalname} vượt quá ${maxReferenceImageBytes / 1024 ** 2} MB.`);
    return;
  }
  if (referenceFiles.length > maxReferenceImages()) {
    await reject(`Chỉ nhận tối đa ${maxReferenceImages()} ảnh tham chiếu.`);
    return;
  }
  const prompt = req.body.prompt?.trim() || '';
  const autoStoryUpload = parseBooleanOption(req.body.autoStoryUpload);
  if (autoStoryUpload && !trendflareConfigured()) {
    await reject('Chưa cấu hình TRENDFLARE_API_TOKEN nên không thể tự upload lên Trendflare.');
    return;
  }
  const writeStory = (type === 'upload' && parseBooleanOption(req.body.writeStory)) || autoStoryUpload;
  const useReferenceFrames = parseBooleanOption(req.body.useReferenceFrames);
  const postToReels = parseBooleanOption(req.body.postToReels);
  if (postToReels && !facebookConfigured()) {
    await reject('Chưa cấu hình FACEBOOK_PAGE_ID và FACEBOOK_PAGE_ACCESS_TOKEN nên không thể tự đăng Reels.');
    return;
  }
  const maxParts = Math.max(1, Number(process.env.MAX_VIDEO_PARTS || 30));
  let targetDuration;
  let language;
  try {
    targetDuration = parseTargetDuration({
      type,
      durationMode: req.body.durationMode,
      durationSeconds: req.body.durationSeconds,
      maxParts,
      clipSeconds
    });
    language = normalizeVideoLanguage(req.body.language || 'auto');
  } catch (error) {
    await reject(error.message);
    return;
  }
  // Catch an over-long Reel now, not after paying for every Grok generation.
  if (postToReels && targetDuration != null && targetDuration > REEL_LIMITS.maxSeconds) {
    await reject(`Facebook Reels chỉ nhận tối đa ${REEL_LIMITS.maxSeconds} giây; hãy giảm thời lượng đích.`);
    return;
  }
  if (type !== 'upload' && videoFile?.path) await fs.rm(videoFile.path, { force: true });
  const job = {
    id: crypto.randomUUID(), type, prompt, youtubeUrl: req.body.youtubeUrl || '',
    sourcePath: type === 'upload' && videoFile?.path ? path.resolve(videoFile.path) : null,
    autoTopic: type === 'topic' && !prompt && !autoStoryUpload,
    autoStoryUpload,
    trendflareStatus: autoStoryUpload ? 'pending' : null,
    trendflarePostId: null, trendflarePostSlug: null, trendflarePostUrl: null, trendflareError: null,
    targetDuration, language, writeStory, clipSeconds,
    useReferenceFrames, postToReels,
    reelStatus: postToReels ? 'pending' : null, reelUrl: null, reelError: null,
    referenceImages: referenceFiles.map((file) => path.resolve(file.path)),
    aspectRatio: type === 'topic' ? (postToReels ? '9:16' : '16:9') : null, status: 'queued',
    message: type === 'topic' && !prompt
      ? (autoStoryUpload ? 'Đang chờ Gemini viết truyện' : 'Đang chờ Gemini tìm xu hướng')
      : 'Đang chờ',
    createdAt: new Date().toISOString(), outputUrl: null, storyUrl: null, storyTitle: null, error: null, logUrl: null
  };
  job.logUrl = `/logs/${job.id}.log`;
  jobs.unshift(job); await saveJobs(jobs); await logJob(job.id, 'job.created', {
    type: job.type, hasSource: Boolean(job.sourcePath), autoTopic: job.autoTopic,
    autoStoryUpload: job.autoStoryUpload,
    writeStory: job.writeStory, targetDuration, language, clipSeconds,
    useReferenceFrames: job.useReferenceFrames, referenceImageCount: job.referenceImages.length,
    postToReels: job.postToReels
  }); res.status(201).json(publicJob(job)); void runQueue();
});

async function patchJob(job, values) { Object.assign(job, values); await saveJobs(jobs); }

/**
 * Posts a finished job to Facebook Reels. The job stays `done` no matter what happens here:
 * the video already cost Grok generations, so a posting problem is recorded on `reelStatus`
 * rather than throwing the whole job back to `failed`.
 */
async function publishJobReel(job, outputPath) {
  const config = facebookConfig();
  const metadata = { duration: job.outputDuration, width: job.outputWidth, height: job.outputHeight };

  if (!facebookConfigured(config)) {
    await patchJob(job, { reelStatus: 'skipped', reelError: 'Chưa cấu hình thông tin Facebook Page.' });
    await logJob(job.id, 'facebook.reel.skipped', { reason: 'not_configured' });
    return;
  }
  const rejection = reelRejectionReason(metadata);
  if (rejection) {
    await patchJob(job, { reelStatus: 'rejected', reelError: rejection, message: 'Hoàn tất · Không hợp lệ cho Reels' });
    await logJob(job.id, 'facebook.reel.rejected', { reason: rejection, ...metadata });
    return;
  }

  try {
    await patchJob(job, { reelStatus: 'publishing', message: 'Đang đăng Facebook Reels…' });
    const result = await publishReel({
      filePath: outputPath,
      description: buildReelDescription(job, config),
      config,
      log: (event, details) => logJob(job.id, event, details)
    });
    await patchJob(job, {
      reelStatus: 'published', reelUrl: result.permalink, reelError: null, message: 'Hoàn tất · Đã đăng Reels'
    });
  } catch (error) {
    const safeError = sanitizeError(error);
    await patchJob(job, { reelStatus: 'failed', reelError: safeError, message: 'Hoàn tất · Đăng Reels lỗi' });
    await logJob(job.id, 'facebook.reel.failed', { error: safeError });
  }
}

async function uploadJobStoryToTrendflare(job, story, featuredImage = null, options = {}) {
  const { isCancelled = () => false } = options;
  throwIfCancelled(isCancelled, 'Đã hủy trước khi đăng lên Trendflare.');
  const config = trendflareConfig();
  if (!trendflareConfigured(config)) {
    await patchJob(job, {
      trendflareStatus: 'failed',
      trendflareError: 'Chưa cấu hình TRENDFLARE_API_TOKEN.'
    });
    await logJob(job.id, 'trendflare.post.skipped', { reason: 'not_configured' });
    return;
  }

  try {
    await patchJob(job, { trendflareStatus: 'publishing' });
    throwIfCancelled(isCancelled, 'Đã hủy trước khi xuất bản truyện lên Trendflare.');
    const imageToUpload = featuredImage || job.thumbnailPath || null;
    const result = await publishStoryToTrendflare({
      title: story.title,
      content: story.content,
      language: job.language,
      status: 'published',
      featuredImage: imageToUpload
    }, config);
    throwIfCancelled(isCancelled, 'Đã hủy sau khi gửi Trendflare.');
    await patchJob(job, {
      trendflareStatus: 'published',
      trendflarePostId: result.id,
      trendflarePostSlug: result.slug,
      trendflarePostUrl: result.url,
      trendflareFeaturedImageUrl: result.featuredImage || null,
      trendflareError: null
    });
    await logJob(job.id, 'trendflare.post.published', {
      postId: result.id,
      slug: result.slug,
      postUrl: result.url,
      featuredImage: result.featuredImage || null
    });
  } catch (error) {
    if (isCancellation(error) || job.cancelRequested) throw error;
    const safeError = redactTrendflareSecrets(sanitizeError(error), config);
    await patchJob(job, {
      trendflareStatus: 'failed',
      trendflareError: safeError
    });
    await logJob(job.id, 'trendflare.post.failed', { error: safeError });
  }
}

/** Xóa clip part, manifest và frame tham chiếu tạm của một tác vụ. Trả về số tệp đã xóa. */
async function removeJobArtifacts(jobId) {
  const outputsDirectory = path.join(dataDir, 'outputs');
  const files = (await fs.readdir(outputsDirectory).catch(() => []))
    .filter((name) => name.startsWith(`${jobId}-part-`) || isReferenceArtifact(name, jobId))
    .map((name) => path.join(outputsDirectory, name));
  await Promise.all(files.map((file) => fs.rm(file, { force: true }).catch(() => {})));
  return files.length;
}

async function firstMissingReferenceImage(job) {
  for (const file of job.referenceImages || []) {
    if (!await fs.stat(file).then((stat) => stat.isFile() && stat.size > 0).catch(() => false)) return file;
  }
  return null;
}
function partFingerprint(partJob, references = null) {
  const payload = {
    prompt: partJob.prompt,
    aspectRatio: partJob.aspectRatio,
    targetDuration: partJob.targetDuration ?? null,
    language: partJob.language || 'auto',
    clipSeconds: clipSecondsOf(partJob),
    resolutionPolicy: 'prefer_1080_fallback_720'
  };
  // Only added when references exist, so clips cached before this feature stay reusable.
  if (references) payload.references = references;
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function partManifestPath(file) { return `${file}.manifest.json`; }

function geminiPlanFingerprint(job, metadata) {
  return crypto.createHash('sha256').update(JSON.stringify({
    schemaVersion: 4,
    clipSeconds: clipSecondsOf(job),
    prompt: job.prompt,
    sourceDuration: Number(metadata.duration.toFixed(2)),
    aspectRatio: metadata.aspectRatio,
    targetDuration: job.targetDuration ?? null,
    language: job.language || 'auto',
    writeStory: Boolean(job.writeStory)
  })).digest('hex');
}

function geminiAutoTopicFingerprint(job) {
  return crypto.createHash('sha256').update(JSON.stringify({
    schemaVersion: 2,
    mode: 'auto_viral_topic',
    clipSeconds: clipSecondsOf(job),
    researchDate: trendDateKey(),
    targetDuration: job.targetDuration ?? clipSecondsOf(job),
    aspectRatio: job.aspectRatio || '16:9',
    language: job.language || 'auto'
  })).digest('hex');
}

async function reusableVideoPart(file, aspectRatio, fingerprint, durationWindow = clipDurationWindow(10)) {
  try {
    const stat = await fs.stat(file);
    if (stat.size <= 100000) return false;
    const manifest = JSON.parse(await fs.readFile(partManifestPath(file), 'utf8'));
    if (manifest.fingerprint !== fingerprint) return false;
    const metadata = await getVideoMetadata(file);
    return metadata.duration >= durationWindow.min && metadata.duration <= durationWindow.max && metadata.width && metadata.height
      && ['1080p', '720p'].includes(inferVideoResolution(metadata.width, metadata.height))
      && aspectRatioMatches(metadata.width, metadata.height, aspectRatio);
  } catch { return false; }
}

async function commonPartResolution(files) {
  const resolutions = await Promise.all(files.map(async (file) => {
    const metadata = await getVideoMetadata(file);
    return inferVideoResolution(metadata.width, metadata.height);
  }));
  if (resolutions.some((resolution) => !['1080p', '720p'].includes(resolution))) {
    throw new Error(`Có clip thấp hơn 720p trong danh sách ghép: ${resolutions.join(', ')}.`);
  }
  return resolutions.every((resolution) => resolution === '1080p') ? '1080p' : '720p';
}

async function runQueue() {
  if (working) return; working = true;
  try {
    let job;
    while ((job = jobs.find((item) => item.status === 'queued'))) {
      let activeChildProcess = null;
      activeJobCanceller = () => {
        if (activeChildProcess && !activeChildProcess.killed) {
          try { activeChildProcess.kill(); } catch {}
        }
        abortGrok().catch(() => {});
        abortGemini().catch(() => {});
      };
      try {
        await patchJob(job, { status: 'running', stage: 'prepare', message: 'Đang chuẩn bị…', cancelRequested: false });
        const isCancelled = () => Boolean(job.cancelRequested);
        job.language ||= 'auto';
        job.clipSeconds = clipSecondsOf(job);
        if (job.type === 'topic' && job.targetDuration == null) job.targetDuration = job.clipSeconds;
        await logJob(job.id, 'job.started', {
          type: job.type, targetDuration: job.targetDuration ?? null, language: job.language
        });
        if (job.type === 'youtube' && (!job.sourcePath || !await fs.stat(job.sourcePath).then(() => true).catch(() => false))) {
          throwIfCancelled(isCancelled, 'Đã hủy trước khi tải YouTube.');
          const target = path.resolve('data/uploads', `${job.id}.mp4`);
          await downloadYouTube(job.youtubeUrl, target, (p) => {
            job.message = `Đang tải YouTube ${Math.round(p * 100)}%`;
          }, {
            isCancelled,
            onSpawn: (cp) => { activeChildProcess = cp; }
          });
          activeChildProcess = null;
          throwIfCancelled(isCancelled, 'Đã hủy sau khi tải YouTube.');
          job.sourcePath = target; await saveJobs(jobs);
          await logJob(job.id, 'youtube.downloaded', { sourcePath: target });
        }
        let output;
        if (job.sourcePath) {
          throwIfCancelled(isCancelled, 'Đã hủy trước khi phân tích video.');
          const metadata = await getVideoMetadata(job.sourcePath);
          metadata.aspectRatio = inferAspectRatio(metadata.width, metadata.height);
          await logJob(job.id, 'source.video.probed', metadata);
          const planningDuration = job.targetDuration ?? metadata.duration;
          const requiredParts = expectedPartCount(planningDuration, job.clipSeconds);
          const maxParts = Math.max(1, Number(process.env.MAX_VIDEO_PARTS || 30));
          if (requiredParts > maxParts) {
            throw new Error(`Video cần ${requiredParts} đoạn Grok, vượt giới hạn an toàn ${maxParts} đoạn. Hãy cắt ngắn video hoặc tăng MAX_VIDEO_PARTS.`);
          }
          job.sourceDuration = metadata.duration;
          job.sourceWidth = metadata.width;
          job.sourceHeight = metadata.height;
          job.aspectRatio = metadata.aspectRatio;
          let plan = job.geminiPlan;
          const planFingerprint = geminiPlanFingerprint(job, metadata);
          const legacyPlanIsCompatible = Boolean(plan?.parts?.length)
            && !job.geminiPlanFingerprint
            && !job.writeStory
            && job.targetDuration == null
            && job.language === 'auto'
            && plan.parts.length === requiredParts;
          if (plan?.parts?.length && plan.parts.length !== requiredParts) {
            await logJob(job.id, 'gemini.plan.invalidated', {
              reason: 'part_count_changed', cachedParts: plan.parts.length, requiredParts
            });
            plan = null;
          } else if (plan?.parts?.length && job.geminiPlanFingerprint !== planFingerprint && !legacyPlanIsCompatible) {
            await logJob(job.id, 'gemini.plan.invalidated', { reason: 'options_changed' });
            plan = null;
          }
          if (!plan?.parts?.length) {
            throwIfCancelled(isCancelled, 'Đã hủy trước khi lập kế hoạch Gemini.');
            job.geminiPlan = null;
            job.geminiPlanUrl = null;
            job.stage = 'gemini'; await saveJobs(jobs);
            const analysis = await analyzeVideoWithGemini(job, metadata, (message) => {
              job.message = message; saveJobsInBackground(job);
            }, { isCancelled });
            throwIfCancelled(isCancelled, 'Đã hủy sau khi lập kế hoạch Gemini.');
            plan = analysis.plan;
            const planFilename = `${job.id}-gemini-plan.json`;
            await fs.writeFile(path.resolve('data/logs', planFilename), JSON.stringify({
              createdAt: new Date().toISOString(), sourceDuration: metadata.duration,
              requestedDuration: job.targetDuration ?? null, planningDuration,
              language: job.language, languageLabel: videoLanguageLabel(job.language),
              repaired: analysis.repaired, plan, rawResponse: analysis.rawResponse
            }, null, 2), 'utf8');
            job.geminiPlan = plan;
            job.geminiPlanUrl = `/logs/${planFilename}`;
            job.geminiPlanFingerprint = planFingerprint;
            await saveJobs(jobs);
            await logJob(job.id, 'gemini.plan.saved', {
              planUrl: job.geminiPlanUrl, partCount: plan.parts.length,
              planningDuration, language: job.language
            });
          } else {
            await logJob(job.id, 'gemini.plan.reused', { partCount: plan.parts.length, planUrl: job.geminiPlanUrl || null });
          }
          if (job.type === 'upload' && job.writeStory) {
            const storyFilename = `${job.id}-story.txt`;
            const storyPath = path.resolve('data/outputs', storyFilename);
            const cachedStoryIsValid = Boolean(
              job.geminiStory?.title
              && job.geminiStory?.content
              && job.geminiStoryFingerprint === planFingerprint
            );
            let story = cachedStoryIsValid ? job.geminiStory : null;
            let storySource = 'cache';
            if (!story) {
              throwIfCancelled(isCancelled, 'Đã hủy trước khi viết truyện.');
              job.geminiStory = null;
              job.geminiStoryFingerprint = null;
              job.storyUrl = null;
              job.storyTitle = null;
              job.stage = 'gemini_story';
              await saveJobs(jobs);
              const analysis = await generateStoryFromVideoWithGemini(job, metadata, (message) => {
                job.message = message; saveJobsInBackground(job);
              }, { isCancelled });
              throwIfCancelled(isCancelled, 'Đã hủy sau khi viết truyện.');
              story = analysis.story;
              storySource = 'gemini';
              job.geminiStory = story;
              job.geminiStoryFingerprint = planFingerprint;
              job.storyRepaired = analysis.repaired;
              await saveJobs(jobs);
            }
            const storyFileExists = await fs.stat(storyPath).then((stat) => stat.isFile() && stat.size > 0).catch(() => false);
            if (!storyFileExists || storySource === 'gemini') {
              await fs.writeFile(storyPath, formatGeminiStoryText(story), 'utf8');
              if (storySource === 'cache') storySource = 'cache_file_recreated';
            }
            job.storyTitle = story.title;
            job.storyUrl = `/outputs/${storyFilename}`;
            await saveJobs(jobs);
            await logJob(job.id, 'gemini.story.saved', {
              storyUrl: job.storyUrl,
              title: story.title,
              contentLength: story.content.length,
              wordCount: story.wordCount || countWords(story.content),
              source: storySource,
              repaired: Boolean(job.storyRepaired)
            });
            if (job.autoStoryUpload && story) {
              if (!job.thumbnailUrl) {
                throwIfCancelled(isCancelled, 'Đã hủy trước khi tạo ảnh thu nhỏ.');
                job.stage = 'gemini_thumbnail';
                await saveJobs(jobs);
                const thumb = await generateStoryThumbnailWithGemini(job, story, (message) => {
                  job.message = message; saveJobsInBackground(job);
                }, { isCancelled });
                throwIfCancelled(isCancelled, 'Đã hủy sau khi tạo ảnh thu nhỏ.');
                job.thumbnailPath = thumb.thumbnailPath;
                job.thumbnailUrl = thumb.thumbnailUrl;
                await saveJobs(jobs);
              }
              if (job.trendflareStatus !== 'published') {
                await uploadJobStoryToTrendflare(job, story, job.thumbnailPath, { isCancelled });
              }
            }
          }
          const generated = [];
          for (let index = 0; index < plan.parts.length; index += 1) {
            throwIfCancelled(isCancelled, 'Đã hủy trước khi tạo đoạn tiếp theo.');
            const partNumber = index + 1;
            const expectedPart = path.resolve('data/outputs', `${job.id}-part-${String(partNumber).padStart(3, '0')}.mp4`);
            const storyboardPart = plan.parts[index];
            const references = await buildPartReferences(job, {
              partNumber,
              sourceSeconds: (storyboardPart.sourceStartSeconds + storyboardPart.sourceEndSeconds) / 2,
              previousPartFile: generated[index - 1] || null,
              onWarning: (event, details) => void logJob(job.id, event, details).catch(() => {})
            });
            const partJob = buildGrokTextPartJob(job, plan, index, { references });
            const fingerprint = partFingerprint(partJob, await referenceDigest(references));
            const reusable = await reusableVideoPart(expectedPart, job.aspectRatio, fingerprint, clipDurationWindow(job.clipSeconds));
            if (reusable) {
              generated.push(expectedPart);
              await removeReferenceFrames(references);
              await logJob(job.id, 'job.part.reused', { partNumber, output: expectedPart });
              continue;
            }
            job.stage = 'grok'; await saveJobs(jobs);
            if (references.length) {
              await logJob(job.id, 'job.part.references', { partNumber, roles: references.map((item) => item.role) });
            }
            const partOutput = await generateWithGrok(partJob, (message) => {
              job.message = `Đoạn ${partNumber}/${plan.parts.length}: ${message}`; saveJobsInBackground(job);
            }, { partNumber, isCancelled });
            await removeReferenceFrames(references);
            const partMetadata = await getVideoMetadata(partOutput);
            await fs.writeFile(partManifestPath(partOutput), JSON.stringify({
              fingerprint, partNumber, aspectRatio: job.aspectRatio,
              referenceRoles: references.map((item) => item.role),
              resolution: inferVideoResolution(partMetadata.width, partMetadata.height),
              width: partMetadata.width, height: partMetadata.height
            }, null, 2), 'utf8');
            generated.push(partOutput);
          }
          throwIfCancelled(isCancelled, 'Đã hủy trước khi ghép video.');
          job.stage = 'ffmpeg';
          job.message = `Đang ghép ${generated.length} đoạn bằng FFmpeg…`; await saveJobs(jobs);
          output = path.resolve('data/outputs', `${job.id}.mp4`);
          const joinResolution = await commonPartResolution(generated);
          await joinParts(generated, output, job.id, { aspectRatio: job.aspectRatio, resolution: joinResolution });
          const outputMetadata = await getVideoMetadata(output);
          await logJob(job.id, 'ffmpeg.join.completed', {
            partCount: generated.length, output, sourceDuration: metadata.duration,
            requestedDuration: job.targetDuration ?? null, planningDuration, language: job.language,
            outputDuration: outputMetadata.duration, outputWidth: outputMetadata.width, outputHeight: outputMetadata.height,
            durationPolicy: 'full_grok_clips', promptSource: 'gemini_video_analysis',
            preferredResolution: '1080p', resolution: inferVideoResolution(outputMetadata.width, outputMetadata.height)
          });
          await Promise.all(generated.flatMap((file) => [
            fs.rm(file, { force: true }), fs.rm(partManifestPath(file), { force: true })
          ]));
          job.segmentCount = generated.length;
          job.outputDuration = outputMetadata.duration;
          job.outputWidth = outputMetadata.width;
          job.outputHeight = outputMetadata.height;
          job.outputResolution = inferVideoResolution(outputMetadata.width, outputMetadata.height);
        } else {
          const targetDuration = job.targetDuration ?? job.clipSeconds;
          const totalParts = expectedPartCount(targetDuration, job.clipSeconds);
          const maxParts = Math.max(1, Number(process.env.MAX_VIDEO_PARTS || 30));
          if (totalParts > maxParts) {
            throw new Error(`Video cần ${totalParts} đoạn Grok, vượt giới hạn an toàn ${maxParts} đoạn.`);
          }
          const autoTopic = Boolean(job.autoTopic || (!job.prompt?.trim() && !job.autoStoryUpload));
          let autoTopicPlan = autoTopic ? job.geminiPlan : null;
          let topicStoryPlan = job.autoStoryUpload ? job.geminiPlan : null;
          if (job.autoStoryUpload) {
            let story = job.geminiStory;
            // 1. Sáng tác truyện nghệ thuật với vai trò Nhà văn kiệt xuất
            if (!story?.title || !story?.content) {
              throwIfCancelled(isCancelled, 'Đã hủy trước khi viết truyện.');
              job.geminiPlan = null;
              job.geminiPlanUrl = null;
              job.geminiStory = null;
              job.storyUrl = null;
              job.storyTitle = null;
              job.stage = 'gemini_story';
              await saveJobs(jobs);
              const analysis = await generateMasterStoryWithGemini(job, (message) => {
                job.message = message; saveJobsInBackground(job);
              }, { isCancelled });
              throwIfCancelled(isCancelled, 'Đã hủy sau khi viết truyện.');
              story = analysis.story;
              job.geminiStory = story;
              job.storyTitle = story.title;
              job.generatedTopic = story.title;
              const storyFilename = `${job.id}-story.txt`;
              const storyPath = path.resolve('data/outputs', storyFilename);
              await fs.writeFile(storyPath, formatGeminiStoryText(story), 'utf8');
              job.storyUrl = `/outputs/${storyFilename}`;
              await saveJobs(jobs);
              await logJob(job.id, 'gemini.master_story.saved', {
                title: story.title,
                storyUrl: job.storyUrl,
                contentLength: story.content.length,
                wordCount: story.wordCount || countWords(story.content),
                repaired: analysis.repaired
              });
            } else {
              job.storyTitle ||= story.title;
              job.generatedTopic ||= story.title;
            }

            // 2. Tạo ảnh đại diện từ Gemini (16:9 cinematic illustration)
            if (!job.thumbnailUrl) {
              throwIfCancelled(isCancelled, 'Đã hủy trước khi tạo ảnh thu nhỏ.');
              job.stage = 'gemini_thumbnail';
              await saveJobs(jobs);
              const thumb = await generateStoryThumbnailWithGemini(job, story, (message) => {
                job.message = message; saveJobsInBackground(job);
              }, { isCancelled });
              throwIfCancelled(isCancelled, 'Đã hủy sau khi tạo ảnh thu nhỏ.');
              job.thumbnailPath = thumb.thumbnailPath;
              job.thumbnailUrl = thumb.thumbnailUrl;
              await saveJobs(jobs);
              await logJob(job.id, 'gemini.thumbnail.saved', {
                thumbnailUrl: job.thumbnailUrl
              });
            }

            // 3. Đăng bài viết lên Trendflare CMS kèm ảnh đại diện và lưu Slug
            if (job.trendflareStatus !== 'published') {
              job.stage = 'trendflare';
              await saveJobs(jobs);
              await uploadJobStoryToTrendflare(job, story, job.thumbnailPath, { isCancelled });
            }

            // 4. Sau khi có câu chuyện, dựa trên câu chuyện đó để tạo kịch bản video
            if (!topicStoryPlan?.parts?.length || topicStoryPlan.parts.length !== totalParts) {
              throwIfCancelled(isCancelled, 'Đã hủy trước khi tạo kịch bản phân cảnh.');
              job.geminiPlan = null;
              job.geminiPlanUrl = null;
              job.stage = 'gemini_storyboard';
              await saveJobs(jobs);
              const planAnalysis = await generateStoryboardFromStoryWithGemini(job, story, (message) => {
                job.message = message; saveJobsInBackground(job);
              }, { isCancelled });
              throwIfCancelled(isCancelled, 'Đã hủy sau khi tạo kịch bản phân cảnh.');
              topicStoryPlan = planAnalysis.plan;
              const planFilename = `${job.id}-gemini-plan.json`;
              await fs.writeFile(path.resolve('data/logs', planFilename), JSON.stringify({
                createdAt: new Date().toISOString(),
                mode: 'storyboard_from_master_story',
                requestedDuration: targetDuration,
                partCount: totalParts,
                language: job.language,
                languageLabel: videoLanguageLabel(job.language),
                repaired: planAnalysis.repaired,
                story,
                plan: topicStoryPlan,
                rawResponse: planAnalysis.rawResponse
              }, null, 2), 'utf8');
              job.geminiPlan = topicStoryPlan;
              job.geminiPlanUrl = `/logs/${planFilename}`;
              await saveJobs(jobs);
              await logJob(job.id, 'gemini.storyboard_from_story.saved', {
                title: story.title,
                storyUrl: job.storyUrl,
                planUrl: job.geminiPlanUrl,
                partCount: topicStoryPlan.parts.length,
                repaired: planAnalysis.repaired
              });
            }
          } else if (autoTopic) {
            job.autoTopic = true;
            const planFingerprint = geminiAutoTopicFingerprint(job);
            if (autoTopicPlan?.parts?.length && (
              autoTopicPlan.parts.length !== totalParts || job.geminiPlanFingerprint !== planFingerprint
            )) {
              await logJob(job.id, 'gemini.auto_topic.plan.invalidated', {
                cachedParts: autoTopicPlan.parts.length,
                requiredParts: totalParts,
                reason: autoTopicPlan.parts.length !== totalParts ? 'part_count_changed' : 'options_changed'
              });
              autoTopicPlan = null;
              job.generatedTopic = null;
              job.geminiResearchDate = null;
              job.trendSourceCount = null;
            }
            if (!autoTopicPlan?.parts?.length) {
              throwIfCancelled(isCancelled, 'Đã hủy trước khi nghiên cứu chủ đề.');
              job.geminiPlan = null;
              job.geminiPlanUrl = null;
              job.stage = 'gemini'; await saveJobs(jobs);
              const analysis = await generateAutoTopicWithGemini(job, (message) => {
                job.message = message; saveJobsInBackground(job);
              }, { isCancelled });
              throwIfCancelled(isCancelled, 'Đã hủy sau khi nghiên cứu chủ đề.');
              autoTopicPlan = analysis.plan;
              const planFilename = `${job.id}-gemini-plan.json`;
              const searchEvidence = autoTopicPlan.sources.length ? 'source_urls_returned' : 'not_exposed_by_gemini_web';
              await fs.writeFile(path.resolve('data/logs', planFilename), JSON.stringify({
                createdAt: new Date().toISOString(),
                mode: 'auto_viral_topic',
                groundingMode: 'gemini_web_search_prompt',
                searchEvidence,
                researchDate: analysis.researchDate,
                requestedDuration: targetDuration,
                partCount: totalParts,
                language: job.language,
                languageLabel: videoLanguageLabel(job.language),
                repaired: analysis.repaired,
                plan: autoTopicPlan,
                rawResponse: analysis.rawResponse
              }, null, 2), 'utf8');
              job.geminiPlan = autoTopicPlan;
              job.geminiPlanUrl = `/logs/${planFilename}`;
              job.geminiPlanFingerprint = planFingerprint;
              job.generatedTopic = autoTopicPlan.selectedTopic || autoTopicPlan.summary;
              job.geminiResearchDate = analysis.researchDate;
              job.trendSourceCount = autoTopicPlan.sources.length;
              await saveJobs(jobs);
              await logJob(job.id, 'gemini.auto_topic.plan.saved', {
                planUrl: job.geminiPlanUrl,
                selectedTopic: job.generatedTopic,
                partCount: totalParts,
                targetDuration,
                sourceCount: job.trendSourceCount,
                searchEvidence
              });
            } else {
              job.generatedTopic ||= autoTopicPlan.selectedTopic || autoTopicPlan.summary;
              await logJob(job.id, 'gemini.auto_topic.plan.reused', {
                partCount: autoTopicPlan.parts.length,
                planUrl: job.geminiPlanUrl || null,
                selectedTopic: job.generatedTopic
              });
            }
          }
          await logJob(job.id, 'topic.storyboard.created', {
            partCount: totalParts, targetDuration, language: job.language,
            promptSource: job.autoStoryUpload ? 'gemini_topic_story' : (autoTopic ? 'gemini_current_trend_research' : 'user_topic')
          });
          const makePartJob = (index, references) => {
            if (job.autoStoryUpload && topicStoryPlan) {
              return buildGrokTopicStoryPartJob(job, topicStoryPlan, index, { references });
            }
            return autoTopic
              ? buildGrokAutoTopicPartJob(job, autoTopicPlan, index, { references })
              : buildGrokTopicPartJob(job, index, totalParts, { references });
          };
          const referencesFor = (partNumber, previousPartFile) => buildPartReferences(job, {
            partNumber,
            previousPartFile,
            onWarning: (event, details) => void logJob(job.id, event, details).catch(() => {})
          });
          if (totalParts === 1) {
            throwIfCancelled(isCancelled, 'Đã hủy trước khi tạo video.');
            const references = await referencesFor(1, null);
            const topicJob = makePartJob(0, references);
            job.stage = 'grok'; await saveJobs(jobs);
            if (references.length) {
              await logJob(job.id, 'job.part.references', { partNumber: 1, roles: references.map((item) => item.role) });
            }
            output = await generateWithGrok(topicJob, (message) => {
              job.message = message; saveJobsInBackground(job);
            }, { isCancelled });
            await removeReferenceFrames(references);
            throwIfCancelled(isCancelled, 'Đã hủy sau khi tạo video.');
            job.segmentCount = 1;
          } else {
            const generated = [];
            for (let index = 0; index < totalParts; index += 1) {
              throwIfCancelled(isCancelled, 'Đã hủy trước khi tạo đoạn tiếp theo.');
              const partNumber = index + 1;
              const expectedPart = path.resolve('data/outputs', `${job.id}-part-${String(partNumber).padStart(3, '0')}.mp4`);
              const references = await referencesFor(partNumber, generated[index - 1] || null);
              const partJob = makePartJob(index, references);
              const fingerprint = partFingerprint(partJob, await referenceDigest(references));
              const reusable = await reusableVideoPart(expectedPart, job.aspectRatio, fingerprint, clipDurationWindow(job.clipSeconds));
              if (reusable) {
                generated.push(expectedPart);
                await removeReferenceFrames(references);
                await logJob(job.id, 'job.part.reused', { partNumber, output: expectedPart });
                continue;
              }
              job.stage = 'grok'; await saveJobs(jobs);
              if (references.length) {
                await logJob(job.id, 'job.part.references', { partNumber, roles: references.map((item) => item.role) });
              }
              const partOutput = await generateWithGrok(partJob, (message) => {
                job.message = `Đoạn ${partNumber}/${totalParts}: ${message}`; saveJobsInBackground(job);
              }, { partNumber, isCancelled });
              await removeReferenceFrames(references);
              throwIfCancelled(isCancelled, 'Đã hủy sau khi tạo đoạn video.');
              const partMetadata = await getVideoMetadata(partOutput);
              await fs.writeFile(partManifestPath(partOutput), JSON.stringify({
                fingerprint, partNumber, aspectRatio: job.aspectRatio,
                targetDuration, language: job.language,
                referenceRoles: references.map((item) => item.role),
                resolution: inferVideoResolution(partMetadata.width, partMetadata.height),
                width: partMetadata.width, height: partMetadata.height
              }, null, 2), 'utf8');
              generated.push(partOutput);
            }
            throwIfCancelled(isCancelled, 'Đã hủy trước khi ghép video.');
            job.stage = 'ffmpeg';
            job.message = `Đang ghép ${generated.length} đoạn bằng FFmpeg…`; await saveJobs(jobs);
            output = path.resolve('data/outputs', `${job.id}.mp4`);
            const joinResolution = await commonPartResolution(generated);
            await joinParts(generated, output, job.id, { aspectRatio: job.aspectRatio, resolution: joinResolution });
            throwIfCancelled(isCancelled, 'Đã hủy sau khi ghép video.');
            await Promise.all(generated.flatMap((file) => [
              fs.rm(file, { force: true }), fs.rm(partManifestPath(file), { force: true })
            ]));
            job.segmentCount = generated.length;
          }
          throwIfCancelled(isCancelled, 'Đã hủy trước khi hoàn tất.');
          const outputMetadata = await getVideoMetadata(output);
          job.outputDuration = outputMetadata.duration;
          job.outputWidth = outputMetadata.width;
          job.outputHeight = outputMetadata.height;
          job.outputResolution = inferVideoResolution(outputMetadata.width, outputMetadata.height);
          await logJob(job.id, 'topic.output.completed', {
            partCount: totalParts, targetDuration, language: job.language,
            promptSource: autoTopic ? 'gemini_current_trend_research' : 'user_topic',
            generatedTopic: autoTopic ? job.generatedTopic : null,
            outputDuration: outputMetadata.duration, outputWidth: outputMetadata.width, outputHeight: outputMetadata.height,
            preferredResolution: '1080p', resolution: job.outputResolution
          });
        }
        throwIfCancelled(isCancelled, 'Đã hủy trước khi hoàn tất.');
        await patchJob(job, { status: 'done', stage: null, message: 'Hoàn tất', outputUrl: `/outputs/${path.basename(output)}` });
        await logJob(job.id, 'job.completed', {
          outputUrl: job.outputUrl, storyUrl: job.storyUrl || null, segmentCount: job.segmentCount
        });
        if (job.postToReels && !job.cancelRequested) await publishJobReel(job, output);
      } catch (error) {
        if (job.cancelRequested || isCancellation(error)) {
          await logJob(job.id, 'job.cancelled', { stage: job.stage || null, from: 'running' });
          await patchJob(job, {
            status: 'cancelled', stage: null, message: 'Đã hủy', error: null, cancelRequested: false
          });
          continue;
        }
        if (job.stage === 'gemini' || job.stage === 'gemini_story') {
          await captureGeminiDiagnostics(job.id, error).catch(() => {});
        }
        if (job.stage === 'grok') await captureGrokDiagnostics(job.id, error).catch(() => {});
        const safeError = sanitizeError(error);
        await logJob(job.id, 'job.failed', { stage: job.stage || null, error: safeError });
        await patchJob(job, { status: 'failed', message: 'Thất bại', error: safeError });
      } finally {
        activeJobCanceller = null;
      }
    }
  } finally {
    working = false;
    activeJobCanceller = null;
  }
}

app.delete('/api/jobs/:id', async (req, res) => {
  const job = jobs.find((item) => item.id === req.params.id);
  if (!job || job.status === 'running') return res.status(409).json({ error: 'Không thể xóa tác vụ này.' });
  await removeJobArtifacts(job.id);
  for (const file of [
    job.sourcePath,
    ...(job.referenceImages || []),
    job.outputUrl && path.join(dataDir, job.outputUrl.replace(/^\//, '')),
    job.storyUrl && path.join(dataDir, job.storyUrl.replace(/^\//, '')),
    job.geminiPlanUrl && path.join(dataDir, job.geminiPlanUrl.replace(/^\//, ''))
  ].filter(Boolean)) await fs.rm(file, { force: true }).catch(() => {});
  jobs = jobs.filter((item) => item.id !== job.id); await saveJobs(jobs); res.json({ ok: true });
});

const port = Number(process.env.PORT || 3210);
app.listen(port, '127.0.0.1', () => {
  console.log(`Grok Video Studio: http://localhost:${port}`);
  void runQueue();
});
process.on('SIGINT', async () => { await Promise.all([closeBrowser(), closeGeminiBrowser()]); process.exit(0); });
