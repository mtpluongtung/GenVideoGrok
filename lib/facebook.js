import fs from 'node:fs/promises';
import { aspectRatioMatches } from './video.js';

// Meta's published Reels specs: 9:16, 3-90s, at least 540x960, H.264/H.265.
export const REEL_LIMITS = Object.freeze({
  aspectRatio: '9:16',
  minSeconds: 3,
  maxSeconds: 90,
  minWidth: 540,
  minHeight: 960
});

export function facebookConfig(env = process.env) {
  return {
    pageId: String(env.FACEBOOK_PAGE_ID || '').trim(),
    accessToken: String(env.FACEBOOK_PAGE_ACCESS_TOKEN || '').trim(),
    graphVersion: String(env.FACEBOOK_GRAPH_VERSION || 'v25.0').trim(),
    hashtags: String(env.FACEBOOK_REEL_HASHTAGS || '').trim()
  };
}

export function facebookConfigured(config = facebookConfig()) {
  return Boolean(config.pageId && config.accessToken);
}

/**
 * The access token is a credential that grants posting rights on the Page, so it is only
 * ever sent in an Authorization header or a POST body — never in a URL, which would put it
 * into error strings and log lines. This scrubs it from anything that still slips through.
 */
export function redactFacebookSecrets(text, config = facebookConfig()) {
  let safe = String(text ?? '');
  if (config.accessToken) safe = safe.split(config.accessToken).join('[redacted-token]');
  return safe
    .replace(/(access_token=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/(OAuth\s+)[A-Za-z0-9._-]+/g, '$1[redacted]');
}

export function reelRejectionReason(metadata, limits = REEL_LIMITS) {
  const { duration, width, height } = metadata || {};
  if (!width || !height) return 'Không đọc được kích thước video nên chưa thể đăng Reels.';
  if (!aspectRatioMatches(width, height, limits.aspectRatio)) {
    return `Facebook Reels chỉ nhận tỷ lệ ${limits.aspectRatio}; video này là ${width}x${height}. `
      + 'Hãy tạo tác vụ ở chế độ dọc, hoặc dùng video nguồn dọc.';
  }
  if (width < limits.minWidth || height < limits.minHeight) {
    return `Reels cần tối thiểu ${limits.minWidth}x${limits.minHeight}; video này là ${width}x${height}.`;
  }
  if (!(duration >= limits.minSeconds)) {
    return `Reels cần dài ít nhất ${limits.minSeconds} giây; video này chỉ ${Number(duration || 0).toFixed(1)} giây.`;
  }
  if (duration > limits.maxSeconds) {
    return `Reels chỉ nhận tối đa ${limits.maxSeconds} giây; video này dài ${duration.toFixed(1)} giây. `
      + `Hãy giảm thời lượng đích xuống ${limits.maxSeconds} giây trở xuống.`;
  }
  return null;
}

export function buildReelDescription(job, config = facebookConfig()) {
  const base = [job?.reelDescription, job?.generatedTopic, job?.storyTitle, job?.prompt]
    .map((value) => String(value ?? '').trim())
    .find(Boolean) || 'Video mới';
  const caption = base.length > 2200 ? `${base.slice(0, 2197)}…` : base;
  return config.hashtags ? `${caption}\n\n${config.hashtags}` : caption;
}

async function graphRequest(url, options, config, fetchImpl) {
  const response = await fetchImpl(url, options);
  const raw = await response.text();
  let payload;
  try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { raw }; }
  if (!response.ok || payload?.error) {
    const detail = payload?.error?.message || payload?.raw || `HTTP ${response.status}`;
    throw new Error(redactFacebookSecrets(detail, config));
  }
  return payload;
}

/**
 * Publishes one Reel through the three-phase Video API: start reserves a video id and an
 * upload URL, the binary goes to rupload, then finish flips it to PUBLISHED.
 */
export async function publishReel({
  filePath,
  description,
  config = facebookConfig(),
  log = async () => {},
  fetchImpl = fetch,
  pollTimeoutMs = 300000,
  pollIntervalMs = 5000,
  uploadAttempts = 3
}) {
  if (!facebookConfigured(config)) {
    throw new Error('Chưa cấu hình FACEBOOK_PAGE_ID và FACEBOOK_PAGE_ACCESS_TOKEN.');
  }
  const graph = `https://graph.facebook.com/${config.graphVersion}`;
  const authHeader = { Authorization: `Bearer ${config.accessToken}` };

  const started = await graphRequest(`${graph}/${config.pageId}/video_reels`, {
    method: 'POST',
    headers: { ...authHeader, 'content-type': 'application/json' },
    body: JSON.stringify({ upload_phase: 'start' })
  }, config, fetchImpl);
  const videoId = started.video_id;
  if (!videoId) throw new Error('Facebook không trả về video_id ở bước khởi tạo Reels.');
  await log('facebook.reel.session.started', { videoId });

  const body = await fs.readFile(filePath);
  let lastError;
  let uploaded = false;
  for (let attempt = 1; attempt <= uploadAttempts && !uploaded; attempt += 1) {
    try {
      await graphRequest(`https://rupload.facebook.com/video-upload/${config.graphVersion}/${videoId}`, {
        method: 'POST',
        headers: {
          Authorization: `OAuth ${config.accessToken}`,
          offset: '0',
          file_size: String(body.length),
          'content-type': 'application/octet-stream'
        },
        body
      }, config, fetchImpl);
      uploaded = true;
      await log('facebook.reel.uploaded', { videoId, attempt, bytes: body.length });
    } catch (error) {
      lastError = error;
      await log('facebook.reel.upload.retry', { videoId, attempt, error: error.message });
      if (attempt < uploadAttempts) await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
  if (!uploaded) throw new Error(`Không tải được video lên Facebook sau ${uploadAttempts} lần: ${lastError?.message}`);

  await graphRequest(`${graph}/${config.pageId}/video_reels`, {
    method: 'POST',
    headers: { ...authHeader, 'content-type': 'application/json' },
    body: JSON.stringify({ upload_phase: 'finish', video_id: videoId, video_state: 'PUBLISHED', description })
  }, config, fetchImpl);
  await log('facebook.reel.finish.requested', { videoId });

  const startedAt = Date.now();
  let lastStatus = null;
  while (Date.now() - startedAt < pollTimeoutMs) {
    const status = await graphRequest(`${graph}/${videoId}?fields=status`, {
      method: 'GET', headers: authHeader
    }, config, fetchImpl).catch((error) => ({ error }));
    const phase = status?.status;
    lastStatus = phase || lastStatus;
    const publishStatus = String(phase?.publishing_phase?.publish_status || '').toLowerCase();
    const videoStatus = String(phase?.video_status || '').toLowerCase();
    if (publishStatus === 'published') {
      await log('facebook.reel.published', { videoId, elapsedMs: Date.now() - startedAt });
      return { videoId, permalink: `https://www.facebook.com/reel/${videoId}`, status: phase };
    }
    if (publishStatus === 'error' || videoStatus === 'error') {
      const reason = phase?.publishing_phase?.error?.message
        || phase?.processing_phase?.error?.message
        || 'Facebook báo lỗi khi xử lý Reels.';
      throw new Error(redactFacebookSecrets(reason, config));
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(
    `Facebook chưa xuất bản Reels sau ${Math.round(pollTimeoutMs / 60000)} phút `
    + `(trạng thái cuối: ${JSON.stringify(lastStatus ?? 'không rõ')}). Video đã tải lên, hãy kiểm tra trong Meta Business Suite.`
  );
}
