import path from 'node:path';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { logJob, sanitizeError } from './logger.js';
import { aspectRatioMatches, getVideoMetadata, inferVideoResolution } from './video.js';
import { isCancellation, throwIfCancelled } from './cancel.js';

const profileDir = path.resolve('data/browser-profile');
const grokUrl = process.env.GROK_URL || 'https://grok.com/imagine';
const timeout = Number(process.env.GENERATION_TIMEOUT_MS || 900000);
let context;

async function browser() {
  if (context) return context;
  context = await chromium.launchPersistentContext(profileDir, {
    headless: process.env.GROK_HEADLESS === 'true',
    viewport: { width: 1440, height: 960 },
    acceptDownloads: true,
    args: ['--disable-blink-features=AutomationControlled']
  });
  context.on('close', () => { context = undefined; });
  return context;
}

export async function openLogin() {
  const ctx = await browser();
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(grokUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  return { ok: true, message: 'Đã mở Grok. Hãy đăng nhập trong cửa sổ trình duyệt.' };
}

export async function inspectGrokPage() {
  const ctx = await browser();
  const page = ctx.pages().find((item) => item.url().includes('grok.com')) || ctx.pages()[0];
  if (!page) return { error: 'Không có trang Grok đang mở.' };
  return page.evaluate(() => ({
    url: location.href,
    title: document.title,
    inputs: [...document.querySelectorAll('input')].map((el) => ({ type: el.type, accept: el.accept, ariaLabel: el.getAttribute('aria-label') })),
    buttons: [...document.querySelectorAll('button')].filter((el) => el.offsetParent !== null).map((el) => ({
      text: el.innerText?.trim().slice(0, 120), ariaLabel: el.getAttribute('aria-label'), title: el.getAttribute('title'), testId: el.getAttribute('data-testid'),
      html: el.outerHTML.slice(0, 1200)
    })).slice(0, 100),
    links: [...document.querySelectorAll('a')].filter((el) => el.offsetParent !== null).map((el) => ({ text: el.innerText?.trim().slice(0, 120), href: el.href })).slice(0, 50)
    ,videos: [...document.querySelectorAll('video')].map((el, index) => ({
      index, src: el.currentSrc || el.src, duration: Number.isFinite(el.duration) ? el.duration : null,
      width: el.videoWidth || null, height: el.videoHeight || null, readyState: el.readyState
    }))
  }));
}

export async function inspectLatestGeneration() {
  const ctx = await browser();
  const page = ctx.pages().find((item) => item.url().includes('grok.com'));
  if (!page) throw new Error('Không tìm thấy trang Grok đang mở.');
  const candidates = page.locator('button[aria-label]').filter({ visible: true });
  const count = await candidates.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    const label = await candidate.getAttribute('aria-label');
    if (label && !/^(imagine|collapse|new project|open saved image|dictation|submit|upload|image|video|agent|aspect ratio|dismiss)/i.test(label)) {
      await candidate.click();
      await page.waitForTimeout(2500);
      return inspectGrokPage();
    }
  }
  throw new Error('Không tìm thấy kết quả gần đây trong lịch sử Grok.');
}

export async function configureGrokSettings(aspectRatio = null) {
  const ctx = await browser();
  const page = ctx.pages().find((item) => item.url().includes('grok.com')) || ctx.pages()[0] || await ctx.newPage();
  if (!page.url().includes('grok.com')) await page.goto(grokUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  let verified;
  await ensureVideoSettings(page, async (event, details) => { if (event === 'grok.settings.verified') verified = details; }, 'debug', { aspectRatio });
  return { ok: true, ...verified };
}

async function firstVisible(locators) {
  for (const locator of locators) {
    if (await locator.first().isVisible().catch(() => false)) return locator.first();
  }
  return null;
}

function exactTextPattern(value) {
  return new RegExp(`^${String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
}

function optionPattern(value) {
  return new RegExp(`^\\s*${String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
}

const controlLabels = {
  duration: /^(?:video duration|thời lượng video)$/i,
  resolution: /^(?:video resolution|độ phân giải video)$/i
};
const valuePatterns = {
  duration: /\d+\s*s\b/i,
  resolution: /\d{3,4}p\b/i,
  aspectRatio: /(?:16:9|9:16|1:1|3:2|2:3)/
};

async function menuButton(page, labelPattern) {
  const button = page.getByRole('button', { name: labelPattern }).filter({ visible: true }).first();
  return await button.isVisible().catch(() => false) ? button : null;
}

async function controlValue(button, valuePattern) {
  const values = await Promise.all([
    button.innerText().catch(() => ''),
    button.getAttribute('aria-label').catch(() => ''),
    button.getAttribute('title').catch(() => '')
  ]);
  return values
    .map((value) => String(value || '').match(valuePattern)?.[0]?.replace(/\s+/g, ''))
    .find(Boolean) || null;
}

async function waitForControlValue(page, button, expected, valuePattern, label, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await controlValue(button, valuePattern) === expected) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`Grok chưa xác nhận ${label} sau ${Math.round(timeoutMs / 1000)} giây.`);
}

async function openMenuOptions(page, button, timeoutMs) {
  await button.click();
  const options = page.getByRole('menuitemradio').filter({ visible: true });
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await options.count().catch(() => 0)) break;
    await page.waitForTimeout(100);
  }
  const texts = (await options.allTextContents().catch(() => []))
    .map((text) => text.trim()).filter(Boolean);
  return { options, texts };
}

async function closeOpenMenu(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(100);
}

/**
 * Robust picker for Grok's dropdown-button menus (duration and resolution).
 * Handles the menu not opening on the first click, stale options from a previous render,
 * and falls back through a list of acceptable values (e.g. 1080p then 720p).
 */
async function selectPreferredFromMenu(page, button, preferredValues, label, timeoutMs) {
  const startedAt = Date.now();
  let lastTexts = [];
  while (Date.now() - startedAt < timeoutMs) {
    const { options, texts } = await openMenuOptions(page, button, 5000);
    lastTexts = texts;
    for (const value of preferredValues) {
      const pattern = optionPattern(value);
      const target = options.filter({ hasText: pattern }).first();
      if (await target.isVisible().catch(() => false)) {
        await target.click();
        await page.waitForTimeout(300);
        return { value, texts };
      }
    }
    await closeOpenMenu(page);
    await page.waitForTimeout(300);
  }
  return { value: null, texts: lastTexts };
}

async function selectRadio(page, radio, label, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!await radio.isVisible().catch(() => false)) {
      await page.waitForTimeout(250);
      continue;
    }
    const isChecked = await isRadioChecked(radio);
    if (isChecked) return;
    await radio.click();
    await page.waitForTimeout(300);
    if (await isRadioChecked(radio)) return;
  }
  throw new Error(`Grok chưa chọn được chế độ ${label} sau ${Math.round(timeoutMs / 1000)} giây.`);
}

async function isRadioChecked(radio) {
  return await radio.evaluate((element) => (
    element.getAttribute('aria-checked') === 'true'
    || element.getAttribute('data-state') === 'checked'
    || element.getAttribute('data-state') === 'on'
    || element.checked === true
  )).catch(() => false);
}

async function aspectRatioFromButton(button) {
  const text = (await button.innerText().catch(() => '')) || (await button.getAttribute('aria-label').catch(() => '')) || '';
  const match = text.match(/(?:16:9|9:16|1:1|3:2|2:3)/);
  return match ? match[0] : null;
}

async function waitForAspectRatio(page, button, expected, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await aspectRatioFromButton(button) === expected) return;
    await page.waitForTimeout(150);
  }
  throw new Error(`Grok chưa cập nhật tỷ lệ khung hình ${expected} sau ${Math.round(timeoutMs / 1000)} giây.`);
}

async function waitForGrokShell(page, timeoutMs = 30000) {
  const startedAt = Date.now();
  const composerSelector = [
    'role=radio[name=/^(?:image|video|agent)$/i]',
    'role=button[name=/upload|tải lên/i]',
    'role=textbox'
  ].join(', ');
  const loginSelector = [
    'role=button[name=/sign in|log in|đăng nhập/i]',
    'role=link[name=/sign in|log in|đăng nhập/i]'
  ].join(', ');

  while (Date.now() - startedAt < timeoutMs) {
    const [hasComposer, hasLogin] = await Promise.all([
      firstVisible([
        page.getByRole('radio', { name: /^(?:image|video|agent)$/i }),
        page.getByRole('button', { name: /upload|tải lên/i }),
        page.getByRole('textbox')
      ]),
      firstVisible([
        page.getByRole('button', { name: /sign in|log in|đăng nhập/i }),
        page.getByRole('link', { name: /sign in|log in|đăng nhập/i })
      ])
    ]);
    if (hasComposer) return 'composer';
    if (hasLogin) return 'login';
    await page.waitForTimeout(250);
  }
  return null;
}

export async function openGrokImaginePage(ctx, initialPage, log, { attempts = 3, readyTimeoutMs = 30000, navigationTimeoutMs = 60000, url = grokUrl, reuseTimeoutMs = 3000, isCancelled = null } = {}) {
  throwIfCancelled(isCancelled, 'Đã hủy trước khi mở Grok Imagine.');
  if (initialPage?.url() && initialPage.url() !== 'about:blank') {
    const shell = await waitForGrokShell(initialPage, reuseTimeoutMs);
    if (shell) {
      await log('grok.page.reused', { shell, url: initialPage.url() });
      return initialPage;
    }
  }

  let page = initialPage;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    throwIfCancelled(isCancelled, 'Đã hủy trong lúc mở Grok Imagine.');
    if (attempt > 1) {
      page = await ctx.newPage();
      await log('grok.page.fallback_created', { attempt });
    }
    try {
      // Grok sometimes never emits DOMContentLoaded even though the response has committed.
      // Wait for the actual composer/login UI below instead of coupling readiness to that event.
      await page.goto(url, { waitUntil: 'commit', timeout: navigationTimeoutMs });
    } catch (error) {
      if (isCancellation(error)) throw error;
      lastError = error;
      await log('grok.navigation.retry', { attempt, error: sanitizeError(error), url: page.url() });
      continue;
    }
    throwIfCancelled(isCancelled, 'Đã hủy trong lúc chờ giao diện Grok.');
    const shell = await waitForGrokShell(page, readyTimeoutMs);
    if (shell) {
      await log('grok.page.ready', { attempt, shell, url: page.url() });
      return page;
    }
    lastError = new Error(`Giao diện Grok chưa sẵn sàng sau ${Math.round(readyTimeoutMs / 1000)} giây.`);
    await log('grok.navigation.retry', { attempt, error: lastError.message, url: page.url() });
  }
  throw new Error(`Không mở được Grok Imagine sau ${attempts} lần thử: ${sanitizeError(lastError)}`);
}

function canonicalVideoUrl(url) {
  try { const parsed = new URL(url); parsed.search = ''; parsed.hash = ''; return parsed.href; }
  catch { return url; }
}

async function allGrokVideoUrls(page) {
  const urls = await page.locator('video[src*="generated_video.mp4"]').evaluateAll((items) =>
    items.map((item) => item.currentSrc || item.src)).catch(() => []);
  return [...new Map(urls.map((url) => [canonicalVideoUrl(url), url])).values()];
}

async function stabilizeKnownVideos(page, log, isCancelled = null) {
  const known = new Set();
  const startedAt = Date.now();
  let lastNewAt = startedAt;
  while (Date.now() - startedAt < 12000) {
    throwIfCancelled(isCancelled, 'Đã hủy trong lúc ổn định video Grok.');
    for (const url of await allGrokVideoUrls(page)) {
      const key = canonicalVideoUrl(url);
      if (!known.has(key)) { known.add(key); lastNewAt = Date.now(); }
    }
    if (Date.now() - lastNewAt >= 3000 && Date.now() - startedAt >= 3000) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await log('grok.video.baseline.stable', { knownVideoCount: known.size, waitedMs: Date.now() - startedAt });
  return known;
}

async function waitForNewVideo(page, knownUrls, waitMs, log, isCancelled) {
  const startedAt = Date.now();
  const known = new Set(knownUrls);
  const graceMs = Number(process.env.GROK_RESULT_GRACE_MS || 8000);
  let lastProgressLog = 0;
  while (Date.now() - startedAt < waitMs) {
    for (const found of await allGrokVideoUrls(page)) {
      const key = canonicalVideoUrl(found);
      if (known.has(key)) continue;
      if (Date.now() - startedAt < graceMs) {
        known.add(key);
        await log('grok.video.ignored_late_existing', { videoUrl: found, elapsedMs: Date.now() - startedAt });
      } else {
        return found;
      }
    }
    if (Date.now() - lastProgressLog >= 30000) {
      lastProgressLog = Date.now();
      await log('grok.video.waiting', { elapsedSeconds: Math.round((Date.now() - startedAt) / 1000) });
    }
    throwIfCancelled(isCancelled, 'Đã hủy trong lúc chờ Grok tạo video.');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Grok không xuất hiện video mới sau ${Math.round(waitMs / 60000)} phút.`);
}

/**
 * Selects the clip length the job's plan was built against. This is not a free choice at
 * generation time: the storyboard, the part count and the FFmpeg join all assume it, so a
 * mismatch has to fail loudly instead of silently producing clips of another length.
 */
async function ensureDuration(page, log, phase, { seconds = 10, timeoutMs = 30000 } = {}) {
  const wanted = `${seconds}s`;
  const button = await menuButton(page, controlLabels.duration);
  if (button) {
    const current = await controlValue(button, valuePatterns.duration);
    if (current === wanted) {
      await log('grok.settings.duration.selected', { phase, seconds, control: 'menu', changed: false });
      return seconds;
    }
    const { value, texts } = await selectPreferredFromMenu(page, button, [wanted], 'duration', timeoutMs);
    if (!value) {
      throw new Error(
        `Grok không có tùy chọn video ${seconds} giây (đang là ${current || 'không rõ'}). ` +
        `Các lựa chọn hiện có: ${texts.join(', ') || 'không đọc được'}. ` +
        `Kế hoạch của tác vụ này được chia theo clip ${seconds} giây; đặt GROK_CLIP_SECONDS theo một giá trị Grok đang có rồi tạo tác vụ mới.`
      );
    }
    await log('grok.settings.duration.selected', { phase, seconds, control: 'menu', changed: true, previous: current });
    return seconds;
  }

  const radio = page.getByRole('radio', { name: exactTextPattern(wanted) }).filter({ visible: true }).first();
  await selectRadio(page, radio, wanted, timeoutMs);
  await log('grok.settings.duration.selected', { phase, seconds, control: 'radio' });
  return seconds;
}

async function selectBestResolution(page, log, phase, { timeoutMs = 30000, settleMs = 2000 } = {}) {
  const button = await menuButton(page, controlLabels.resolution);
  if (button) {
    const current = await controlValue(button, valuePatterns.resolution);
    if (current === '1080p') {
      await log('grok.settings.resolution.selected', { phase, resolution: '1080p', control: 'menu', changed: false });
      return '1080p';
    }
    const { value, texts } = await selectPreferredFromMenu(page, button, ['1080p', '720p'], 'resolution', timeoutMs);
    const resolution = value || (current === '720p' ? '720p' : null);
    if (!resolution) {
      throw new Error(`Grok không cung cấp chế độ 1080p hoặc 720p. Các lựa chọn đang có: ${texts.join(', ') || 'không xác định'}.`);
    }
    if (resolution === '720p') {
      await log('grok.settings.resolution_fallback', {
        phase, preferredResolution: '1080p', resolution, control: 'menu',
        reason: texts.some((text) => /1080p/i.test(text)) ? '1080_disabled' : '1080_unavailable',
        available: texts, url: page.url()
      });
    }
    return resolution;
  }

  const resolution1080 = page.getByRole('radio', { name: /^1080p$/i }).filter({ visible: true }).first();
  const resolution720 = page.getByRole('radio', { name: /^720p$/i }).filter({ visible: true }).first();
  const startedAt = Date.now();
  const fallbackDelayMs = Math.min(settleMs, Math.max(100, Math.floor(timeoutMs / 2)));
  let first720At = null;
  let selected;
  let fallbackReason = null;
  while (Date.now() - startedAt < timeoutMs) {
    const visible1080 = await resolution1080.isVisible().catch(() => false);
    const enabled1080 = visible1080 && await resolution1080.isEnabled().catch(() => false);
    const visible720 = await resolution720.isVisible().catch(() => false);
    const enabled720 = visible720 && await resolution720.isEnabled().catch(() => false);
    if (enabled1080) {
      selected = resolution1080;
      break;
    }
    if (enabled720) {
      first720At ||= Date.now();
      if ((visible1080 && !enabled1080) || Date.now() - first720At >= fallbackDelayMs) {
        selected = resolution720;
        fallbackReason = visible1080 ? '1080_disabled' : '1080_unavailable';
        break;
      }
    }
    await page.waitForTimeout(100);
  }
  if (!selected) {
    const available = (await page.getByRole('radio').filter({ visible: true }).allTextContents().catch(() => []))
      .map((value) => value.trim()).filter(Boolean);
    throw new Error(`Grok không cung cấp chế độ 1080p hoặc 720p. Các lựa chọn đang có: ${available.join(', ') || 'không xác định'}.`);
  }
  const resolution = selected === resolution1080 ? '1080p' : '720p';
  await selectRadio(page, selected, resolution, timeoutMs);
  if (fallbackReason) {
    await log('grok.settings.resolution_fallback', {
      phase, preferredResolution: '1080p', resolution, reason: fallbackReason, url: page.url()
    });
  }
  return resolution;
}

export async function ensureVideoSettings(page, log, phase, { timeoutMs = 30000, aspectRatio = null, clipSeconds = 10 } = {}) {
  await log('grok.settings.start', { phase, requestedAspectRatio: aspectRatio || null, clipSeconds, url: page.url() });
  const videoMode = page.getByRole('radio', { name: /^video$/i }).filter({ visible: true }).first();
  await selectRadio(page, videoMode, 'Video', timeoutMs);
  await log('grok.settings.mode.selected', { phase, mode: 'video' });

  await ensureDuration(page, log, phase, { seconds: clipSeconds, timeoutMs });
  await selectBestResolution(page, log, phase, { timeoutMs });

  const aspectButton = await firstVisible([
    page.getByRole('button', { name: /aspect ratio|tỷ lệ khung hình/i }).filter({ visible: true }),
    page.locator('button[aria-label*="aspect" i], button[aria-label*="ratio" i]').filter({ visible: true }),
    page.getByRole('button', { name: /^(?:16:9|9:16|1:1|3:2|2:3)$/i }).filter({ visible: true })
  ]);
  let actualAspectRatio = aspectButton ? await aspectRatioFromButton(aspectButton) : null;
  if (aspectRatio && actualAspectRatio !== aspectRatio) {
    if (!aspectButton) throw new Error('Không tìm thấy nút tỷ lệ khung hình của Grok. Có thể giao diện Grok vừa thay đổi.');
    await aspectButton.waitFor({ state: 'visible', timeout: timeoutMs });
    await aspectButton.click();
    // Options read "16:9 Widescreen", so match the ratio as a leading token, not the whole label.
    const pattern = optionPattern(aspectRatio);
    let option = await firstVisible([
      page.getByRole('menuitemradio', { name: pattern }),
      page.getByRole('menuitem', { name: pattern }),
      page.getByRole('radio', { name: pattern }).filter({ visible: true }),
      page.getByText(exactTextPattern(aspectRatio)).filter({ visible: true })
    ]);
    if (!option) {
      const textOption = page.getByText(pattern).filter({ visible: true }).last();
      await textOption.waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => {});
      if (await textOption.isVisible().catch(() => false)) option = textOption;
    }
    if (!option) {
      const available = (await page.getByRole('menuitemradio').filter({ visible: true }).allTextContents().catch(() => []))
        .map((value) => value.trim()).filter(Boolean);
      throw new Error(
        `Grok không có lựa chọn tỷ lệ khung hình ${aspectRatio}. ` +
        `Các lựa chọn đang có: ${available.join(', ') || 'không đọc được'}.`
      );
    }
    await option.click();
    await waitForAspectRatio(page, aspectButton, aspectRatio, timeoutMs);
    actualAspectRatio = aspectRatio;
  }
  await log('grok.settings.aspect_ratio.selected', { phase, aspectRatio: actualAspectRatio || null });

  // Changing the aspect ratio can reset the other two, so re-assert them last.
  await ensureDuration(page, log, `${phase}_final`, { seconds: clipSeconds, timeoutMs });
  const finalResolution = await selectBestResolution(page, log, `${phase}_final`, { timeoutMs });
  const settings = {
    phase, mode: 'video', seconds: clipSeconds, resolution: finalResolution, preferredResolution: '1080p',
    resolutionFallback: finalResolution === '720p', aspectRatio: actualAspectRatio, url: page.url()
  };
  await log('grok.settings.verified', settings);
  return settings;
}

async function downloadVideoFile(ctx, page, videoUrl, outputPath, log, isCancelled = null) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    throwIfCancelled(isCancelled, 'Đã hủy trong lúc tải tệp video Grok.');
    try {
      const response = await ctx.request.get(videoUrl, { timeout: 300000 });
      if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
      const body = await response.body();
      if (!body.length) throw new Error('Tệp tải về rỗng.');
      await fs.writeFile(outputPath, body);
      await log('grok.video.downloaded', { method: 'playwright-request', attempt, bytes: body.length });
      return;
    } catch (error) {
      if (isCancellation(error)) throw error;
      lastError = error;
      await log('grok.video.download.retry', { method: 'playwright-request', attempt, error: sanitizeError(error) });
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }

  const cookies = await ctx.cookies(videoUrl);
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  const userAgent = await page.evaluate(() => navigator.userAgent);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    throwIfCancelled(isCancelled, 'Đã hủy trong lúc tải tệp video Grok.');
    try {
      const response = await fetch(videoUrl, { headers: {
        Cookie: cookieHeader, 'User-Agent': userAgent, Referer: 'https://grok.com/', Accept: 'video/mp4,*/*'
      } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = Buffer.from(await response.arrayBuffer());
      if (!body.length) throw new Error('Tệp tải về rỗng.');
      await fs.writeFile(outputPath, body);
      await log('grok.video.downloaded', { method: 'fetch-with-session', attempt, bytes: body.length });
      return;
    } catch (error) {
      if (isCancellation(error)) throw error;
      lastError = error;
      await log('grok.video.download.retry', { method: 'fetch-with-session', attempt, error: sanitizeError(error) });
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
  throw new Error(`Không tải được video Grok sau 6 lần thử: ${sanitizeError(lastError)}`);
}

export const CLIP_DURATION_TOLERANCE_SECONDS = 1.5;

export function clipDurationWindow(clipSeconds = 10) {
  const seconds = Number(clipSeconds) || 10;
  return { min: seconds - CLIP_DURATION_TOLERANCE_SECONDS, max: seconds + CLIP_DURATION_TOLERANCE_SECONDS };
}

export function validateGrokVideoMetadata(metadata, { selectedResolution = '1080p', aspectRatio = null, clipSeconds = 10 } = {}) {
  if (!metadata.width || !metadata.height) throw new Error('Không xác nhận được kích thước video Grok đã tải.');
  const actualResolution = inferVideoResolution(metadata.width, metadata.height);
  if (!['1080p', '720p'].includes(actualResolution)) {
    throw new Error(`Grok trả video ${metadata.width}x${metadata.height} (${actualResolution || 'không rõ'}), thấp hơn mức fallback 720p.`);
  }
  const window = clipDurationWindow(clipSeconds);
  if (metadata.duration < window.min || metadata.duration > window.max) {
    throw new Error(`Grok trả clip dài ${metadata.duration.toFixed(2)} giây thay vì chế độ ${clipSeconds} giây; có thể trang vừa nạp nhầm kết quả cũ.`);
  }
  if (aspectRatio && !aspectRatioMatches(metadata.width, metadata.height, aspectRatio)) {
    throw new Error(`Grok trả video ${metadata.width}x${metadata.height}, không đúng tỷ lệ ${aspectRatio} đã yêu cầu.`);
  }
  return {
    actualResolution,
    resolutionFallback: actualResolution === '720p',
    resolutionAdjusted: actualResolution !== selectedResolution
  };
}

export async function generateWithGrok(job, onStatus = () => {}, options = {}) {
  throwIfCancelled(options.isCancelled, 'Đã hủy trước khi mở Grok.');
  const ctx = await browser();
  let page = [...ctx.pages()].reverse().find((item) => item.url().includes('grok.com')) || ctx.pages()[0] || await ctx.newPage();
  const referencePaths = job.referencePaths?.length ? job.referencePaths : (job.sourcePath ? [job.sourcePath] : []);
  const log = (event, details = {}) => logJob(job.id, event, { partNumber: options.partNumber || null, ...details });
  await log('grok.open.start', { url: grokUrl, referenceCount: referencePaths.length, clipSeconds: Number(job.clipSeconds) || 10 });
  onStatus('Đang mở Grok Imagine…');
  page = await openGrokImaginePage(ctx, page, log, { isCancelled: options.isCancelled });
  throwIfCancelled(options.isCancelled, 'Đã hủy sau khi mở Grok.');

  const uploadButton = page.getByRole('button', { name: /upload|tải lên/i }).first();
  await uploadButton.waitFor({ state: 'visible', timeout: 60000 }).catch(() => {});

  const login = await firstVisible([
    page.getByRole('button', { name: /sign in|log in|đăng nhập/i }),
    page.getByRole('link', { name: /sign in|log in|đăng nhập/i })
  ]);
  if (login) throw new Error('Chưa đăng nhập Grok. Bấm “Mở Grok để đăng nhập” rồi thử lại.');
  await log('grok.auth.ok', { url: page.url() });

  const clipSeconds = Number(job.clipSeconds) || 10;
  throwIfCancelled(options.isCancelled, 'Đã hủy trước khi cài đặt cấu hình Grok.');
  let selectedSettings = await ensureVideoSettings(page, log, 'before_upload', { aspectRatio: job.aspectRatio || null, clipSeconds });

  if (referencePaths.length) {
    throwIfCancelled(options.isCancelled, 'Đã hủy trước khi tải ảnh tham chiếu.');
    onStatus(`Đang tải ${referencePaths.length} frame tham chiếu lên Grok…`);
    let input = page.locator('input[type=file][accept*="image"]').first();
    if (!await input.count()) {
      const attach = await firstVisible([
        page.getByRole('button', { name: /attach|upload|tải lên|add media/i }),
        page.locator('[aria-label*="attach" i], [aria-label*="upload" i]')
      ]);
      if (!attach) throw new Error('Không tìm thấy nút tải tệp của Grok. Có thể giao diện Grok vừa thay đổi.');
      await attach.click();
      input = page.locator('input[type=file][accept*="image"]').first();
      await input.waitFor({ state: 'attached', timeout: 15000 });
    }
    await input.setInputFiles(referencePaths);
    await log('grok.references.uploaded', { count: referencePaths.length, filenames: referencePaths.map((file) => path.basename(file)) });
    await page.waitForTimeout(Math.min(5000, 500 + referencePaths.length * 150));
    throwIfCancelled(options.isCancelled, 'Đã hủy sau khi tải ảnh tham chiếu.');
    selectedSettings = await ensureVideoSettings(page, log, 'after_upload', { aspectRatio: job.aspectRatio || null, clipSeconds });
  }

  throwIfCancelled(options.isCancelled, 'Đã hủy trước khi nhập prompt vào Grok.');
  const promptBox = await firstVisible([
    page.getByRole('textbox').filter({ visible: true }),
    page.locator('textarea'),
    page.locator('[contenteditable=true]')
  ]);
  if (!promptBox) throw new Error('Không tìm thấy ô nhập prompt trên Grok Imagine.');
  await promptBox.fill(job.prompt);
  await log('grok.prompt.filled', { promptLength: job.prompt.length });

  const submit = page.locator('button[type="submit"][aria-label="Submit"]').first();
  await submit.waitFor({ state: 'visible', timeout: 30000 });
  const submitWaitStarted = Date.now();
  while (Date.now() - submitWaitStarted < 60000) {
    throwIfCancelled(options.isCancelled, 'Đã hủy trong lúc chờ Grok sẵn sàng gửi.');
    const enabled = await page.evaluate(() => {
      const button = document.querySelector('button[type="submit"][aria-label="Submit"]');
      return button && !button.disabled;
    }).catch(() => false);
    if (enabled) break;
    await page.waitForTimeout(500);
  }
  await log('grok.submit.enabled', { waitedMs: Date.now() - submitWaitStarted });
  throwIfCancelled(options.isCancelled, 'Đã hủy trước khi gửi lệnh tạo video cho Grok.');
  onStatus('Grok đang tạo video…');
  const existingVideos = await stabilizeKnownVideos(page, log, options.isCancelled);
  await submit.click();
  await log('grok.submit.clicked', { existingVideoCount: existingVideos.size, selector: 'button[type=submit][aria-label=Submit]', urlAfterClick: page.url() });
  const videoUrl = await waitForNewVideo(page, existingVideos, timeout, log, options.isCancelled);
  await log('grok.video.ready', { videoUrl });
  throwIfCancelled(options.isCancelled, 'Đã hủy trước khi tải video Grok.');
  onStatus('Đang tải video kết quả…');
  const suffix = options.partNumber ? `-part-${String(options.partNumber).padStart(3, '0')}` : '';
  const outputPath = path.resolve('data/outputs', `${job.id}${suffix}.mp4`);
  await downloadVideoFile(ctx, page, videoUrl, outputPath, log, options.isCancelled);
  throwIfCancelled(options.isCancelled, 'Đã hủy sau khi tải video Grok.');
  const stat = await fs.stat(outputPath);
  if (!stat.size) throw new Error('Tệp tải về rỗng.');
  const metadata = await getVideoMetadata(outputPath);
  const validation = validateGrokVideoMetadata(metadata, {
    selectedResolution: selectedSettings.resolution,
    aspectRatio: job.aspectRatio || null,
    clipSeconds
  });
  if (validation.resolutionAdjusted) {
    await log('grok.video.resolution_adjusted', {
      selectedResolution: selectedSettings.resolution,
      actualResolution: validation.actualResolution,
      width: metadata.width,
      height: metadata.height
    });
  }
  await log('grok.video.saved', {
    outputPath, bytes: stat.size, ...metadata,
    preferredResolution: '1080p', selectedResolution: selectedSettings.resolution,
    resolution: validation.actualResolution, resolutionFallback: validation.resolutionFallback
  });
  return outputPath;
}

export async function captureGrokDiagnostics(jobId, error) {
  const ctx = await browser();
  const page = ctx.pages().find((item) => item.url().includes('grok.com')) || ctx.pages()[0];
  if (!page) return;
  const screenshotPath = path.resolve('data/logs', `${jobId}-error.png`);
  const htmlPath = path.resolve('data/logs', `${jobId}-error.html`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  await fs.writeFile(htmlPath, await page.content().catch(() => '')).catch(() => {});
  await logJob(jobId, 'grok.error', { error: sanitizeError(error), url: page.url(), screenshotPath, htmlPath });
}

export async function abortGrok() {
  if (!context) return;
  const pages = context.pages().slice();
  await Promise.all(pages.map((page) => page.close().catch(() => {})));
}

export async function closeBrowser() {
  if (context) await context.close();
}
