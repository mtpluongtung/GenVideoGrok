import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { logJob, sanitizeError } from './logger.js';
import { trendDateKey } from './job-options.js';
import { throwIfCancelled } from './cancel.js';
import {
  MIN_STORY_WORDS,
  MIN_STORY_WORDS_RETRY,
  buildGeminiAutoTopicPrompt,
  buildGeminiAutoTopicRepairPrompt,
  buildGeminiMasterWriterPrompt,
  buildGeminiMasterWriterRepairPrompt,
  buildGeminiRepairPrompt,
  buildGeminiStoryPrompt,
  buildGeminiStoryRepairPrompt,
  buildGeminiStoryboardPrompt,
  buildGeminiStoryboardFromStoryPrompt,
  buildGeminiStoryboardFromStoryRepairPrompt,
  buildGeminiThumbnailPrompt,
  buildGeminiTopicStoryPrompt,
  buildGeminiTopicStoryRepairPrompt,
  expectedPartCount,
  parseGeminiAutoTopicPlan,
  parseGeminiMasterStory,
  parseGeminiStory,
  parseGeminiStoryboard,
  parseGeminiStoryboardFromStory,
  parseGeminiTopicStoryPlan
} from './prompt-plan.js';

const profileDir = path.resolve('data/gemini-browser-profile');
const geminiUrl = process.env.GEMINI_URL || 'https://gemini.google.com/app';
const responseTimeout = Number(process.env.GEMINI_RESPONSE_TIMEOUT_MS || 600000);
let context;

async function browser() {
  if (context) return context;
  context = await chromium.launchPersistentContext(profileDir, {
    headless: process.env.GEMINI_HEADLESS === 'true',
    viewport: { width: 1440, height: 960 },
    args: ['--disable-blink-features=AutomationControlled']
  });
  context.on('close', () => { context = undefined; });
  return context;
}

async function geminiPage() {
  const ctx = await browser();
  return ctx.pages().find((item) => item.url().includes('gemini.google.com')) || ctx.pages()[0] || await ctx.newPage();
}

async function firstVisible(locators) {
  for (const locator of locators) {
    if (await locator.first().isVisible().catch(() => false)) return locator.first();
  }
  return null;
}

async function firstVisibleEventually(locators, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const visible = await firstVisible(locators);
    if (visible) return visible;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

export async function waitForGeminiSendButton(page, timeoutMs = 30000) {
  return firstVisibleEventually([
    page.getByRole('button', { name: /send message|gửi tin nhắn|submit/i }),
    page.locator('button[aria-label*="send" i], button[aria-label*="gửi" i]'),
    page.locator('.send-button button, button[type="submit"]')
  ], timeoutMs);
}

export async function openGeminiLogin() {
  const page = await geminiPage();
  await page.goto(geminiUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.bringToFront();
  return { ok: true, message: 'Đã mở Gemini. Hãy đăng nhập Google trong cửa sổ trình duyệt.' };
}

export async function inspectGeminiPage() {
  const page = await geminiPage();
  return page.evaluate(() => ({
    url: location.href,
    title: document.title,
    inputs: [...document.querySelectorAll('input[type=file]')].map((item) => ({ accept: item.accept, multiple: item.multiple })),
    textboxes: [...document.querySelectorAll('[role=textbox], textarea')].filter((item) => item.offsetParent !== null)
      .map((item) => ({ ariaLabel: item.getAttribute('aria-label'), placeholder: item.getAttribute('placeholder') })),
    buttons: [...document.querySelectorAll('button, [role=menuitem]')].filter((item) => item.offsetParent !== null)
      .map((item) => ({ text: item.textContent?.trim().slice(0, 100), ariaLabel: item.getAttribute('aria-label'), role: item.getAttribute('role') })).slice(0, 100)
  }));
}

async function assertSignedIn(page) {
  const login = await firstVisible([
    page.getByRole('link', { name: /sign in|đăng nhập/i }),
    page.getByRole('button', { name: /sign in|đăng nhập/i })
  ]);
  if (login) throw new Error('Chưa đăng nhập Gemini. Bấm “Mở Gemini để đăng nhập” rồi thử lại.');
  const promptBox = await firstVisible([
    page.getByRole('textbox', { name: /enter a prompt|nhập câu lệnh|ask gemini|hỏi gemini/i }),
    page.locator('[role=textbox][contenteditable=true]'),
    page.locator('textarea')
  ]);
  if (!promptBox) throw new Error('Không tìm thấy ô nhập prompt của Gemini. Có thể chưa đăng nhập hoặc giao diện đã thay đổi.');
  return promptBox;
}

async function uploadVideo(page, sourcePath, log) {
  let input = page.locator('input[type=file]').last();
  if (!await input.count()) {
    let addFiles = await firstVisible([
      page.getByRole('button', { name: /add files|uploads and tools|nội dung tải lên|thêm tệp/i }),
      page.locator('button[aria-label*="upload" i], button[aria-label*="file" i]')
    ]);
    if (!addFiles) {
      const semanticButton = page.getByRole('button', { name: /add files|uploads and tools|nội dung tải lên|thêm tệp/i }).first();
      await semanticButton.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
      if (await semanticButton.isVisible().catch(() => false)) addFiles = semanticButton;
    }
    if (!addFiles) throw new Error('Không tìm thấy nút tải tệp của Gemini.');
    await addFiles.click();
    input = page.locator('input[type=file]').last();
    await input.waitFor({ state: 'attached', timeout: 15000 });
  }
  const stat = await fs.stat(sourcePath);
  await log('gemini.upload.start', { filename: path.basename(sourcePath), bytes: stat.size });
  await input.setInputFiles(sourcePath);
  await log('gemini.upload.selected', { filename: path.basename(sourcePath) });
  const attachment = page.locator([
    'button[aria-label^="close " i]',
    'button[aria-label^="remove " i]',
    'button[aria-label^="xóa " i]'
  ].join(', ')).last();
  await attachment.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  if (await attachment.isVisible().catch(() => false)) {
    await log('gemini.upload.ready', { attachmentLabel: await attachment.getAttribute('aria-label') });
  } else {
    await log('gemini.upload.attachment_unlabeled', { filename: path.basename(sourcePath) });
  }
}

async function promptBox(page) {
  return firstVisible([
    page.getByRole('textbox', { name: /enter a prompt|nhập câu lệnh|ask gemini|hỏi gemini/i }),
    page.locator('[role=textbox][contenteditable=true]'),
    page.locator('textarea')
  ]);
}

async function anyVisible(locator) {
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) return true;
  }
  return false;
}

async function responseContent(response) {
  const candidates = [
    response.locator('message-content .markdown-main-panel'),
    response.locator('.model-response-text .markdown-main-panel'),
    response.locator('[data-test-id="response-text"]'),
    response.locator('message-content'),
    response.locator('.model-response-text'),
    response.locator('.markdown-main-panel')
  ];
  for (const candidate of candidates) {
    const count = await candidate.count().catch(() => 0);
    if (count) return candidate.last();
  }
  return null;
}

export async function waitForGeminiResponse(page, options = {}) {
  const {
    previousModelResponseCount = 0,
    previousResponseContainerCount = 0,
    timeoutMs = responseTimeout,
    pollIntervalMs = 1500,
    stablePolls = 3,
    logIntervalMs = 30000,
    attempt = 1,
    log = async () => {}
  } = options;
  const startedAt = Date.now();
  let nextLogAt = 0;
  let response;
  let responseKind;
  let detectedLogged = false;
  let previousText = '';
  let lastText = '';
  let stableCount = 0;
  let lastGenerating = false;

  while (Date.now() - startedAt < timeoutMs) {
    const containers = page.locator('response-container');
    const models = page.locator('model-response');
    const containerCount = await containers.count().catch(() => 0);
    const modelCount = await models.count().catch(() => 0);

    if (!response || !await response.count().catch(() => 0)) {
      if (containerCount > previousResponseContainerCount) {
        response = containers.last();
        responseKind = 'response-container';
      } else if (modelCount > previousModelResponseCount) {
        response = models.last();
        responseKind = 'model-response';
      }
    }

    if (response && !detectedLogged) {
      await log('gemini.response.detected', {
        attempt,
        responseKind,
        elapsedMs: Date.now() - startedAt
      });
      detectedLogged = true;
    }

    const content = response ? await responseContent(response) : null;
    const current = content ? (await content.innerText().catch(() => '')).trim() : '';
    const ariaBusy = content
      ? await content.getAttribute('aria-busy').catch(() => null)
      : response ? await response.getAttribute('aria-busy').catch(() => null) : null;
    const stopVisible = await anyVisible(page.locator([
      '.send-button.stop button',
      'button[aria-label*="stop" i]',
      'button[aria-label*="ngừng tạo" i]',
      'button[aria-label*="cancel response" i]'
    ].join(', ')));
    const pendingVisible = response ? await anyVisible(response.locator([
      'thinking-dots-animation',
      '.gpi-static-text-loader',
      '[data-test-id="thinking-overlay-content"]'
    ].join(', '))) : false;
    const generating = stopVisible || pendingVisible || ariaBusy === 'true';
    lastGenerating = generating;
    lastText = current;

    if (current.length >= 20 && current === previousText && !generating) stableCount += 1;
    else stableCount = 0;

    if (stableCount >= stablePolls) {
      await log('gemini.response.ready', {
        attempt,
        responseKind,
        elapsedMs: Date.now() - startedAt,
        responseLength: current.length,
        responseSha256: crypto.createHash('sha256').update(current).digest('hex')
      });
      return current;
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= nextLogAt) {
      await log('gemini.response.waiting', {
        attempt,
        elapsedMs,
        responseDetected: Boolean(response),
        contentDetected: Boolean(content),
        responseLength: current.length,
        generating,
        ariaBusy,
        responseContainerCount: containerCount,
        modelResponseCount: modelCount
      });
      nextLogAt = elapsedMs + logIntervalMs;
    }

    throwIfCancelled(options.isCancelled, 'Đã hủy trong lúc chờ Gemini trả lời.');
    previousText = current;
    await page.waitForTimeout(pollIntervalMs);
  }

  throw new Error(
    `Gemini không hoàn tất phản hồi sau ${Math.round(timeoutMs / 60000)} phút ` +
    `(đã thấy phản hồi: ${Boolean(response)}, ký tự: ${lastText.length}, vẫn đang tạo: ${lastGenerating}).`
  );
}

async function submitAndRead(page, prompt, log, attempt, onStatus, isCancelled) {
  throwIfCancelled(isCancelled, 'Đã hủy trước khi gửi prompt cho Gemini.');
  const box = await promptBox(page);
  if (!box) throw new Error('Không tìm thấy ô nhập prompt của Gemini.');
  const modelResponses = page.locator('model-response');
  const responseContainers = page.locator('response-container');
  const responseCount = await modelResponses.count();
  const responseContainerCount = await responseContainers.count();
  await box.fill(prompt);
  await log('gemini.prompt.filled', { attempt, promptLength: prompt.length });
  const send = await waitForGeminiSendButton(page);
  if (!send) throw new Error('Không tìm thấy nút Gửi của Gemini.');
  await send.waitFor({ state: 'visible', timeout: 30000 });
  const waitStarted = Date.now();
  while (!await send.isEnabled().catch(() => false)) {
    throwIfCancelled(isCancelled, 'Đã hủy trong lúc chờ Gemini sẵn sàng nút Gửi.');
    if (Date.now() - waitStarted > 300000) throw new Error('Gemini chưa xử lý xong video sau 5 phút; nút Gửi vẫn bị khóa.');
    await page.waitForTimeout(1000);
  }
  throwIfCancelled(isCancelled, 'Đã hủy trước khi bấm nút Gửi Gemini.');
  await log('gemini.submit.enabled', { attempt, waitedMs: Date.now() - waitStarted });
  await send.click();
  await log('gemini.submit.clicked', {
    attempt,
    previousResponseCount: responseCount,
    previousResponseContainerCount: responseContainerCount
  });

  const consentDialog = page.locator('[data-test-id="video-upload-consent-dialog-root"]').first();
  await consentDialog.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  if (await consentDialog.isVisible().catch(() => false)) {
    await log('gemini.consent.required', { attempt });
    onStatus('Gemini đang chờ bạn bấm “Đồng ý” trong cửa sổ trình duyệt…');
    const consentWaitStarted = Date.now();
    while (await consentDialog.isVisible().catch(() => false)) {
      throwIfCancelled(isCancelled, 'Đã hủy trong lúc chờ xác nhận quyền video Gemini.');
      if (Date.now() - consentWaitStarted > 300000) {
        throw new Error('Gemini vẫn đang chờ xác nhận quyền sử dụng nội dung. Hãy bấm “Đồng ý” trong cửa sổ Gemini rồi Thử lại.');
      }
      await page.waitForTimeout(1000);
    }
    await log('gemini.consent.dismissed', { attempt });
    onStatus('Gemini đang phân tích video…');
  }

  return waitForGeminiResponse(page, {
    isCancelled,
    previousModelResponseCount: responseCount,
    previousResponseContainerCount: responseContainerCount,
    timeoutMs: responseTimeout,
    attempt,
    log
  });
}

async function saveRawResponse(jobId, raw, attempt, log, purpose = '') {
  const purposeSuffix = purpose ? `-${purpose}` : '';
  const filename = `${jobId}-gemini${purposeSuffix}-raw-${attempt}.txt`;
  await fs.writeFile(path.resolve('data/logs', filename), raw, 'utf8');
  await log('gemini.response.saved', {
    attempt, purpose: purpose || 'storyboard', responseUrl: `/logs/${filename}`, responseLength: raw.length
  });
}

export async function analyzeVideoWithGemini(job, metadata, onStatus = () => {}, { isCancelled } = {}) {
  throwIfCancelled(isCancelled, 'Đã hủy trước khi phân tích video.');
  const page = await geminiPage();
  const log = (event, details = {}) => logJob(job.id, event, details);
  onStatus('Đang mở Gemini…');
  throwIfCancelled(isCancelled, 'Đã hủy trước khi mở Gemini.');
  await page.goto(geminiUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  throwIfCancelled(isCancelled, 'Đã hủy trong lúc mở Gemini.');
  await assertSignedIn(page);
  await log('gemini.auth.ok', { url: page.url() });
  onStatus('Đang tải video nguồn lên Gemini…');
  throwIfCancelled(isCancelled, 'Đã hủy trước khi tải video lên Gemini.');
  await uploadVideo(page, job.sourcePath, log);
  throwIfCancelled(isCancelled, 'Đã hủy sau khi tải video lên Gemini.');
  const targetDuration = job.targetDuration ?? null;
  const clipSeconds = Number(job.clipSeconds) || 10;
  const expectedParts = expectedPartCount(targetDuration ?? metadata.duration, clipSeconds);
  const instruction = buildGeminiStoryboardPrompt({
    duration: metadata.duration,
    targetDuration,
    userInstruction: job.prompt,
    aspectRatio: metadata.aspectRatio,
    outputLanguage: job.language || 'auto',
    clipSeconds
  });
  onStatus(`Gemini đang viết ${expectedParts} prompt…`);
  let raw = await submitAndRead(page, instruction, log, 1, onStatus, isCancelled);
  await saveRawResponse(job.id, raw, 1, log);
  try {
    const plan = parseGeminiStoryboard(raw, { duration: metadata.duration, targetDuration, clipSeconds });
    await log('gemini.plan.validated', { partCount: plan.parts.length, repaired: false });
    return { plan, rawResponse: raw, repaired: false };
  } catch (error) {
    await log('gemini.plan.invalid', { attempt: 1, error: sanitizeError(error) });
    onStatus('Gemini đang sửa lại JSON prompt…');
    raw = await submitAndRead(page, buildGeminiRepairPrompt(error, expectedParts), log, 2, onStatus, isCancelled);
    await saveRawResponse(job.id, raw, 2, log);
    const plan = parseGeminiStoryboard(raw, { duration: metadata.duration, targetDuration, clipSeconds });
    await log('gemini.plan.validated', { partCount: plan.parts.length, repaired: true });
    return { plan, rawResponse: raw, repaired: true };
  }
}

export async function generateStoryFromVideoWithGemini(job, metadata, onStatus = () => {}, { isCancelled } = {}) {
  throwIfCancelled(isCancelled, 'Đã hủy trước khi sáng tác câu chuyện.');
  const page = await geminiPage();
  const log = (event, details = {}) => logJob(job.id, event, { purpose: 'story', ...details });
  onStatus('Đang mở Gemini để sáng tác câu chuyện…');
  throwIfCancelled(isCancelled, 'Đã hủy trước khi mở Gemini.');
  await page.goto(geminiUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  throwIfCancelled(isCancelled, 'Đã hủy trong lúc mở Gemini.');
  await assertSignedIn(page);
  await log('gemini.auth.ok', { url: page.url() });
  onStatus('Đang tải video nguồn lên Gemini để sáng tác câu chuyện…');
  throwIfCancelled(isCancelled, 'Đã hủy trước khi tải video lên Gemini.');
  await uploadVideo(page, job.sourcePath, log);
  throwIfCancelled(isCancelled, 'Đã hủy sau khi tải video lên Gemini.');
  const instruction = buildGeminiStoryPrompt({
    duration: metadata.duration,
    outputLanguage: job.language || 'auto'
  });
  onStatus('Gemini đang sáng tác câu chuyện dài trên 2.000 từ dựa trên video…');
  let raw = await submitAndRead(page, instruction, log, 1, onStatus, isCancelled);
  await saveRawResponse(job.id, raw, 1, log, 'story');
  try {
    const story = parseGeminiStory(raw, { minWords: MIN_STORY_WORDS });
    await log('gemini.story.validated', {
      repaired: false,
      titleLength: story.title.length,
      contentLength: story.content.length,
      wordCount: story.wordCount
    });
    return { story, rawResponse: raw, repaired: false };
  } catch (error) {
    await log('gemini.story.invalid', { attempt: 1, error: sanitizeError(error) });
    onStatus('Gemini đang mở rộng câu chuyện trên 2.000 từ…');
    raw = await submitAndRead(page, buildGeminiStoryRepairPrompt(error, {
      outputLanguage: job.language || 'auto'
    }), log, 2, onStatus, isCancelled);
    await saveRawResponse(job.id, raw, 2, log, 'story');
    const story = parseGeminiStory(raw, { minWords: MIN_STORY_WORDS_RETRY });
    await log('gemini.story.validated', {
      repaired: true,
      titleLength: story.title.length,
      contentLength: story.content.length,
      wordCount: story.wordCount
    });
    return { story, rawResponse: raw, repaired: true };
  }
}

export async function generateAutoTopicWithGemini(job, onStatus = () => {}, { isCancelled } = {}) {
  throwIfCancelled(isCancelled, 'Đã hủy trước khi tìm kiếm xu hướng bằng Gemini.');
  const page = await geminiPage();
  const log = (event, details = {}) => logJob(job.id, event, details);
  const targetDuration = Number(job.targetDuration ?? 10);
  const clipSeconds = Number(job.clipSeconds) || 10;
  const expectedParts = expectedPartCount(targetDuration, clipSeconds);
  const researchDate = trendDateKey();
  onStatus('Đang mở Gemini để tìm xu hướng…');
  throwIfCancelled(isCancelled, 'Đã hủy trước khi mở Gemini.');
  await page.goto(geminiUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  throwIfCancelled(isCancelled, 'Đã hủy trong lúc mở Gemini.');
  await assertSignedIn(page);
  await log('gemini.auth.ok', { url: page.url(), purpose: 'auto_topic' });
  const instruction = buildGeminiAutoTopicPrompt({
    targetDuration,
    outputLanguage: job.language || 'auto',
    aspectRatio: job.aspectRatio || '16:9',
    clipSeconds,
    currentDate: researchDate
  });
  await log('gemini.auto_topic.search.requested', {
    researchDate,
    targetDuration,
    expectedParts,
    language: job.language || 'auto',
    groundingMode: 'gemini_web_search_prompt',
    clipSeconds
  });
  onStatus(`Gemini đang tìm xu hướng và viết ${expectedParts} part cho ${targetDuration} giây…`);
  let raw = await submitAndRead(page, instruction, log, 1, onStatus, isCancelled);
  await saveRawResponse(job.id, raw, 1, log);
  try {
    const plan = parseGeminiAutoTopicPlan(raw, { targetDuration, clipSeconds });
    await log('gemini.auto_topic.plan.validated', {
      partCount: plan.parts.length,
      selectedTopic: plan.selectedTopic || plan.summary,
      sourceCount: plan.sources.length,
      searchEvidence: plan.sources.length ? 'source_urls_returned' : 'not_exposed_by_gemini_web',
      repaired: false
    });
    return { plan, rawResponse: raw, repaired: false, researchDate };
  } catch (error) {
    await log('gemini.auto_topic.plan.invalid', { attempt: 1, error: sanitizeError(error) });
    onStatus('Gemini đang chuẩn hóa lại kịch bản…');
    raw = await submitAndRead(page, buildGeminiAutoTopicRepairPrompt(error, {
      expectedParts,
      targetDuration,
      currentDate: researchDate,
      clipSeconds
    }), log, 2, onStatus, isCancelled);
    await saveRawResponse(job.id, raw, 2, log);
    const plan = parseGeminiAutoTopicPlan(raw, { targetDuration, clipSeconds });
    await log('gemini.auto_topic.plan.validated', {
      partCount: plan.parts.length,
      selectedTopic: plan.selectedTopic || plan.summary,
      sourceCount: plan.sources.length,
      searchEvidence: plan.sources.length ? 'source_urls_returned' : 'not_exposed_by_gemini_web',
      repaired: true
    });
    return { plan, rawResponse: raw, repaired: true, researchDate };
  }
}

export async function generateTopicStoryWithGemini(job, onStatus = () => {}, { isCancelled } = {}) {
  const page = await geminiPage();
  const log = (event, details = {}) => logJob(job.id, event, details);
  const targetDuration = Number(job.targetDuration ?? 10);
  const clipSeconds = Number(job.clipSeconds) || 10;
  const expectedParts = expectedPartCount(targetDuration, clipSeconds);
  onStatus('Đang mở Gemini để viết câu chuyện và kịch bản video…');
  await page.goto(geminiUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await assertSignedIn(page);
  await log('gemini.auth.ok', { url: page.url(), purpose: 'topic_story' });
  const instruction = buildGeminiTopicStoryPrompt({
    userPrompt: job.prompt || '',
    targetDuration,
    outputLanguage: job.language || 'auto',
    aspectRatio: job.aspectRatio || '16:9',
    clipSeconds
  });
  await log('gemini.topic_story.requested', {
    targetDuration,
    expectedParts,
    language: job.language || 'auto',
    clipSeconds
  });
  onStatus(`Gemini đang viết câu chuyện và ${expectedParts} part cho ${targetDuration} giây…`);
  let raw = await submitAndRead(page, instruction, log, 1, onStatus, isCancelled);
  await saveRawResponse(job.id, raw, 1, log, 'story');
  try {
    const plan = parseGeminiTopicStoryPlan(raw, { targetDuration, clipSeconds, minWords: MIN_STORY_WORDS });
    await log('gemini.topic_story.validated', {
      partCount: plan.parts.length,
      title: plan.title,
      contentLength: plan.content.length,
      wordCount: plan.wordCount,
      repaired: false
    });
    return {
      story: { title: plan.title, content: plan.content, wordCount: plan.wordCount },
      plan,
      rawResponse: raw,
      repaired: false
    };
  } catch (error) {
    await log('gemini.topic_story.invalid', { attempt: 1, error: sanitizeError(error) });
    onStatus('Gemini đang mở rộng câu chuyện trên 2.000 từ…');
    raw = await submitAndRead(page, buildGeminiTopicStoryRepairPrompt(error, {
      expectedParts,
      targetDuration,
      outputLanguage: job.language || 'auto',
      clipSeconds
    }), log, 2, onStatus, isCancelled);
    await saveRawResponse(job.id, raw, 2, log, 'story');
    const plan = parseGeminiTopicStoryPlan(raw, { targetDuration, clipSeconds, minWords: MIN_STORY_WORDS_RETRY });
    await log('gemini.topic_story.validated', {
      partCount: plan.parts.length,
      title: plan.title,
      contentLength: plan.content.length,
      wordCount: plan.wordCount,
      repaired: true
    });
    return {
      story: { title: plan.title, content: plan.content, wordCount: plan.wordCount },
      plan,
      rawResponse: raw,
      repaired: true
    };
  }
}

export async function generateMasterStoryWithGemini(job, onStatus = () => {}, { isCancelled } = {}) {
  throwIfCancelled(isCancelled, 'Đã hủy trước khi sáng tác tác phẩm.');
  const page = await geminiPage();
  const log = (event, details = {}) => logJob(job.id, event, { purpose: 'master_story', ...details });
  onStatus('Đang mở Gemini để sáng tác tác phẩm văn học nghệ thuật…');
  throwIfCancelled(isCancelled, 'Đã hủy trước khi mở Gemini.');
  await page.goto(geminiUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  throwIfCancelled(isCancelled, 'Đã hủy trong lúc mở Gemini.');
  await assertSignedIn(page);
  await log('gemini.auth.ok', { url: page.url() });

  if (job.sourcePath) {
    onStatus('Đang tải video nguồn lên Gemini để sáng tác truyện…');
    throwIfCancelled(isCancelled, 'Đã hủy trước khi tải video lên Gemini.');
    await uploadVideo(page, job.sourcePath, log);
    throwIfCancelled(isCancelled, 'Đã hủy sau khi tải video lên Gemini.');
  }

  const instruction = buildGeminiMasterWriterPrompt({
    userPrompt: job.prompt || '',
    outputLanguage: job.language || 'auto',
    duration: job.sourceDuration,
    hasSource: Boolean(job.sourcePath)
  });

  onStatus('Nhà văn kiệt xuất (Gemini) đang sáng tác tác phẩm trường đoạn trên 2.000 từ…');
  let raw = await submitAndRead(page, instruction, log, 1, onStatus, isCancelled);
  await saveRawResponse(job.id, raw, 1, log, 'master_story');

  try {
    const story = parseGeminiMasterStory(raw, { minWords: MIN_STORY_WORDS });
    await log('gemini.master_story.validated', {
      repaired: false,
      title: story.title,
      contentLength: story.content.length,
      wordCount: story.wordCount
    });
    return { story, rawResponse: raw, repaired: false };
  } catch (error) {
    if (isCancellation(error)) throw error;
    await log('gemini.master_story.invalid', { attempt: 1, error: sanitizeError(error) });
    onStatus('Gemini đang trau chuốt và mở rộng tác phẩm trên 2.000 từ…');
    raw = await submitAndRead(page, buildGeminiMasterWriterRepairPrompt(error, {
      outputLanguage: job.language || 'auto'
    }), log, 2, onStatus, isCancelled);
    await saveRawResponse(job.id, raw, 2, log, 'master_story');
    const story = parseGeminiMasterStory(raw, { minWords: MIN_STORY_WORDS_RETRY });
    await log('gemini.master_story.validated', {
      repaired: true,
      title: story.title,
      contentLength: story.content.length,
      wordCount: story.wordCount
    });
    return { story, rawResponse: raw, repaired: true };
  }
}

export async function generateStoryThumbnailWithGemini(job, story, onStatus = () => {}, { isCancelled = null } = {}) {
  throwIfCancelled(isCancelled, 'Đã hủy trước khi tạo ảnh đại diện.');
  const log = (event, details = {}) => logJob(job.id, event, { purpose: 'thumbnail', ...details });
  const thumbnailFilename = `${job.id}-thumbnail.png`;
  const thumbnailPath = path.resolve('data/outputs', thumbnailFilename);
  const thumbnailUrl = `/outputs/${thumbnailFilename}`;

  const exists = await fs.stat(thumbnailPath).then((s) => s.isFile() && s.size > 0).catch(() => false);
  if (exists) {
    await log('gemini.thumbnail.reused', { thumbnailPath, thumbnailUrl });
    return { thumbnailPath, thumbnailUrl };
  }

  onStatus('Đang mở Gemini để tạo ảnh đại diện…');
  throwIfCancelled(isCancelled, 'Đã hủy trước khi mở Gemini tạo ảnh đại diện.');
  const page = await geminiPage();
  await page.goto(geminiUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  throwIfCancelled(isCancelled, 'Đã hủy trong lúc mở Gemini tạo ảnh đại diện.');
  await assertSignedIn(page);
  await log('gemini.auth.ok', { url: page.url(), purpose: 'thumbnail' });

  const prompt = buildGeminiThumbnailPrompt({ title: story.title, content: story.content });
  onStatus('Gemini đang tạo ảnh đại diện 16:9 cho bài viết…');

  let imageCaptured = false;
  try {
    const box = await promptBox(page);
    if (!box) throw new Error('Không tìm thấy ô nhập prompt của Gemini.');
    throwIfCancelled(isCancelled, 'Đã hủy trước khi nhập prompt ảnh đại diện.');
    await box.fill(prompt);
    await log('gemini.thumbnail.prompt.filled', { promptLength: prompt.length });
    const send = await waitForGeminiSendButton(page);
    if (!send) throw new Error('Không tìm thấy nút Gửi của Gemini.');
    await send.waitFor({ state: 'visible', timeout: 30000 });
    throwIfCancelled(isCancelled, 'Đã hủy trước khi gửi tạo ảnh đại diện.');
    await send.click();
    await log('gemini.thumbnail.submitted');

    const startWait = Date.now();
    const maxWaitMs = 45000;
    while (Date.now() - startWait < maxWaitMs) {
      throwIfCancelled(isCancelled, 'Đã hủy trong lúc chờ ảnh đại diện từ Gemini.');
      const imgCandidate = page.locator([
        'model-response img[src*="googleusercontent.com"]',
        'response-container img[src*="googleusercontent.com"]',
        '.image-container img',
        'img[src^="blob:"]',
        'img[alt*="image" i]',
        'model-response img',
        'response-container img'
      ].join(', ')).last();

      const isVis = await imgCandidate.isVisible().catch(() => false);
      if (isVis) {
        await page.waitForTimeout(1000);
        await imgCandidate.screenshot({ path: thumbnailPath });
        const stat = await fs.stat(thumbnailPath).catch(() => null);
        if (stat && stat.size > 1000) {
          imageCaptured = true;
          await log('gemini.thumbnail.captured_from_gemini', { bytes: stat.size });
          break;
        }
      }

      const stopVisible = await anyVisible(page.locator('.send-button.stop button, button[aria-label*="stop" i]'));
      if (!stopVisible && Date.now() - startWait > 12000) {
        break;
      }
      await page.waitForTimeout(1500);
    }
  } catch (err) {
    if (isCancellation(err)) throw err;
    await log('gemini.thumbnail.generation_warning', { error: sanitizeError(err) });
  }

  throwIfCancelled(isCancelled, 'Đã hủy trước khi dựng ảnh đại diện dự phòng.');
  if (!imageCaptured) {
    await log('gemini.thumbnail.fallback_poster_rendering', { title: story.title });
    onStatus('Đang hoàn thiện ảnh bìa nghệ thuật cho bài viết…');
    const posterPage = await page.context().newPage();
    try {
      await posterPage.setViewportSize({ width: 1280, height: 720 });
      const safeTitle = (story.title || 'Câu Chuyện Nghệ Thuật').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const snippet = (story.content || '').replace(/<[^>]+>/g, '').slice(0, 180).replace(/</g, '&lt;').replace(/>/g, '&gt;');
      await posterPage.setContent(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body {
              width: 1280px; height: 720px;
              background: radial-gradient(circle at 75% 25%, #2a1b4e 0%, #0d1117 60%, #05070a 100%);
              color: #f0f6fc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
              display: flex; flex-direction: column; justify-content: flex-end;
              padding: 64px 80px; position: relative; overflow: hidden;
            }
            body::before {
              content: ""; position: absolute; inset: 0;
              background: radial-gradient(circle at 20% 80%, rgba(199, 255, 89, 0.12) 0%, transparent 50%),
                          radial-gradient(circle at 80% 20%, rgba(99, 102, 241, 0.2) 0%, transparent 60%);
              pointer-events: none;
            }
            .badge {
              align-self: flex-start;
              background: rgba(199, 255, 89, 0.15); color: #c7ff59;
              border: 1px solid rgba(199, 255, 89, 0.35);
              padding: 6px 16px; border-radius: 999px;
              font-size: 14px; font-weight: 700; letter-spacing: 1.5px;
              text-transform: uppercase; margin-bottom: 24px;
            }
            h1 {
              font-size: 48px; font-weight: 800; line-height: 1.25;
              color: #ffffff; margin-bottom: 20px; max-width: 960px;
              text-shadow: 0 4px 20px rgba(0,0,0,0.6);
            }
            p {
              font-size: 20px; line-height: 1.5; color: #8b949e;
              max-width: 820px; text-shadow: 0 2px 10px rgba(0,0,0,0.5);
            }
          </style>
        </head>
        <body>
          <div class="badge">Featured Story</div>
          <h1>${safeTitle}</h1>
          <p>${snippet}…</p>
        </body>
        </html>
      `);
      await posterPage.screenshot({ path: thumbnailPath });
      await log('gemini.thumbnail.fallback_created', { thumbnailPath });
    } finally {
      await posterPage.close().catch(() => {});
    }
  }

  return { thumbnailPath, thumbnailUrl };
}

export async function generateStoryboardFromStoryWithGemini(job, story, onStatus = () => {}, { isCancelled } = {}) {
  throwIfCancelled(isCancelled, 'Đã hủy trước khi chuyển thể kịch bản.');
  const page = await geminiPage();
  const log = (event, details = {}) => logJob(job.id, event, { purpose: 'storyboard_from_story', ...details });
  const targetDuration = Number(job.targetDuration ?? job.clipSeconds ?? 10);
  const clipSeconds = Number(job.clipSeconds) || 10;
  const expectedParts = expectedPartCount(targetDuration, clipSeconds);

  onStatus('Đang mở Gemini để chuyển thể câu chuyện thành kịch bản video…');
  throwIfCancelled(isCancelled, 'Đã hủy trước khi mở Gemini.');
  await page.goto(geminiUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  throwIfCancelled(isCancelled, 'Đã hủy trong lúc mở Gemini.');
  await assertSignedIn(page);
  await log('gemini.auth.ok', { url: page.url() });

  const instruction = buildGeminiStoryboardFromStoryPrompt({
    story,
    targetDuration,
    clipSeconds,
    aspectRatio: job.aspectRatio || '16:9',
    outputLanguage: job.language || 'auto'
  });

  onStatus(`Gemini đang chuyển thể câu chuyện thành ${expectedParts} phân cảnh video…`);
  let raw = await submitAndRead(page, instruction, log, 1, onStatus, isCancelled);
  await saveRawResponse(job.id, raw, 1, log, 'storyboard_from_story');

  try {
    const plan = parseGeminiStoryboardFromStory(raw, { targetDuration, clipSeconds });
    plan.title = story.title;
    await log('gemini.storyboard_from_story.validated', {
      partCount: plan.parts.length,
      title: story.title,
      repaired: false
    });
    return { plan, rawResponse: raw, repaired: false };
  } catch (error) {
    await log('gemini.storyboard_from_story.invalid', { attempt: 1, error: sanitizeError(error) });
    onStatus('Gemini đang chuẩn hóa lại kịch bản phân cảnh…');
    raw = await submitAndRead(page, buildGeminiStoryboardFromStoryRepairPrompt(error, {
      expectedParts,
      targetDuration,
      clipSeconds
    }), log, 2, onStatus, isCancelled);
    await saveRawResponse(job.id, raw, 2, log, 'storyboard_from_story');
    const plan = parseGeminiStoryboardFromStory(raw, { targetDuration, clipSeconds });
    plan.title = story.title;
    await log('gemini.storyboard_from_story.validated', {
      partCount: plan.parts.length,
      title: story.title,
      repaired: true
    });
    return { plan, rawResponse: raw, repaired: true };
  }
}

export async function captureGeminiDiagnostics(jobId, error) {
  const page = await geminiPage();
  const screenshotPath = path.resolve('data/logs', `${jobId}-gemini-error.png`);
  const htmlPath = path.resolve('data/logs', `${jobId}-gemini-error.html`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  await fs.writeFile(htmlPath, await page.content().catch(() => '')).catch(() => {});
  await logJob(jobId, 'gemini.error', { error: sanitizeError(error), url: page.url(), screenshotPath, htmlPath });
}

export async function abortGemini() {
  if (!context) return;
  const pages = context.pages().slice();
  await Promise.all(pages.map((page) => page.close().catch(() => {})));
}

export async function closeGeminiBrowser() {
  if (context) await context.close();
}
