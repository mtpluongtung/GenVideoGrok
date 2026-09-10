import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { logJob, sanitizeError } from './logger.js';
import { trendDateKey } from './job-options.js';
import { isCancellation, throwIfCancelled } from './cancel.js';
import { extractContactSheets, getVideoMetadata } from './video.js';
import {
  MIN_STORY_WORDS,
  MIN_STORY_WORDS_RETRY,
  buildAutoTopicPrompt,
  buildAutoTopicRepairPrompt,
  buildMasterWriterPrompt,
  buildMasterWriterRepairPrompt,
  buildRepairPrompt,
  buildStoryPrompt,
  buildStoryRepairPrompt,
  buildStoryboardPrompt,
  buildStoryboardFromStoryPrompt,
  buildStoryboardFromStoryRepairPrompt,
  buildThumbnailPrompt,
  buildTopicStoryPrompt,
  buildTopicStoryRepairPrompt,
  buildVideoDescriptionPrompt,
  expectedPartCount,
  jsonRetryInstruction,
  parseAutoTopicPlan,
  parseMasterStory,
  parseStory,
  parseStoryboard,
  parseStoryboardFromStory,
  parseTopicStoryPlan,
  parseVideoDescription,
  runJsonAttempts
} from './prompt-plan.js';

const profileDir = path.resolve('data/chatgpt-browser-profile');
const chatgptUrl = process.env.CHATGPT_URL || 'https://chatgpt.com/';
const responseTimeout = Number(process.env.CHATGPT_RESPONSE_TIMEOUT_MS || 600000);
const imageTimeout = Number(process.env.CHATGPT_IMAGE_TIMEOUT_MS || 240000);
const maxJsonAttempts = () => Math.min(6, Math.max(1, Math.floor(Number(process.env.CHATGPT_JSON_MAX_ATTEMPTS || 3)) || 3));
let context;

// Selectors verified against the live logged-out chatgpt.com composer (Sep 2026): textarea
// aria-label "Chat with ChatGPT", button "Send message", button "Add files and more", visible
// "Log in" / "Sign up for free". The logged-in turn markup could not be inspected without an
// account, so response detection keeps fallbacks — run /api/debug/chatgpt when it breaks.
const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"]';
const TURN_SELECTOR = 'article[data-testid^="conversation-turn"]';
const STOP_SELECTOR = [
  '[data-testid="stop-button"]',
  'button[aria-label*="stop" i]',
  'button[aria-label*="dừng" i]'
].join(', ');
const SIGNED_OUT_NAME = /^(log in|sign up|sign up for free|đăng nhập|đăng ký)$/i;
const ERROR_BANNER = /you['’]ve (hit|reached) (the|your|our) [^.]*limit|something went wrong while generating|network error|đã đạt giới hạn|đã xảy ra lỗi khi tạo/i;

async function browser() {
  if (context) return context;
  context = await chromium.launchPersistentContext(profileDir, {
    headless: process.env.CHATGPT_HEADLESS === 'true',
    viewport: { width: 1440, height: 960 },
    args: ['--disable-blink-features=AutomationControlled']
  });
  context.on('close', () => { context = undefined; });
  return context;
}

async function chatgptPage() {
  const ctx = await browser();
  return ctx.pages().find((item) => item.url().includes('chatgpt.com')) || ctx.pages()[0] || await ctx.newPage();
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

async function anyVisible(locator) {
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) return true;
  }
  return false;
}

function promptBoxLocators(page) {
  return [
    page.locator('#prompt-textarea'),
    page.getByRole('textbox', { name: /chat with chatgpt|message chatgpt|ask chatgpt|ask anything|nhắn tin cho chatgpt|hỏi bất kỳ điều gì/i }),
    page.locator('textarea[placeholder*="ChatGPT" i]'),
    page.locator('div[contenteditable="true"]'),
    page.locator('textarea')
  ];
}

function sendButtonLocators(page) {
  return [
    page.getByRole('button', { name: /^(send message|send prompt|send|gửi tin nhắn|gửi lời nhắc|gửi)$/i }),
    page.locator('[data-testid="send-button"]'),
    page.locator('button[type="submit"][aria-label*="send" i]')
  ];
}

export async function waitForChatGPTSendButton(page, timeoutMs = 30000) {
  return firstVisibleEventually(sendButtonLocators(page), timeoutMs);
}

export async function openChatGPTLogin() {
  const page = await chatgptPage();
  await page.goto(chatgptUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.bringToFront();
  return { ok: true, message: 'Đã mở ChatGPT. Hãy đăng nhập tài khoản OpenAI trong cửa sổ trình duyệt.' };
}

export async function inspectChatGPTPage() {
  const page = await chatgptPage();
  return page.evaluate(({ assistant, turn }) => ({
    url: location.href,
    title: document.title,
    fileInputs: [...document.querySelectorAll('input[type=file]')]
      .map((item) => ({ id: item.id || null, accept: item.accept, multiple: item.multiple })),
    textboxes: [...document.querySelectorAll('#prompt-textarea, [role=textbox], textarea, [contenteditable=true]')]
      .filter((item) => item.offsetParent !== null)
      .map((item) => ({ id: item.id || null, ariaLabel: item.getAttribute('aria-label'), placeholder: item.getAttribute('placeholder') })),
    buttons: [...document.querySelectorAll('button, [role=menuitem]')].filter((item) => item.offsetParent !== null)
      .map((item) => ({
        text: item.textContent?.trim().slice(0, 80),
        ariaLabel: item.getAttribute('aria-label'),
        testId: item.getAttribute('data-testid')
      })).slice(0, 100),
    assistantMessages: document.querySelectorAll(assistant).length,
    conversationTurns: document.querySelectorAll(turn).length
  }), { assistant: ASSISTANT_SELECTOR, turn: TURN_SELECTOR });
}

/**
 * chatgpt.com shows a working composer to signed-out visitors, so a visible prompt box is not
 * proof of a session (unlike Gemini). A visible "Log in" / "Sign up" control is.
 */
export async function assertChatGPTSignedIn(page, { timeoutMs = 30000 } = {}) {
  const challenge = /just a moment|attention required|verify you are human/i;
  if (challenge.test(await page.title().catch(() => ''))) {
    throw new Error('ChatGPT đang yêu cầu xác minh chống bot. Hãy mở cửa sổ ChatGPT, tự hoàn tất bước xác minh rồi bấm Thử lại.');
  }
  const box = await firstVisibleEventually(promptBoxLocators(page), timeoutMs);
  const signedOut = await firstVisible([
    page.getByRole('button', { name: SIGNED_OUT_NAME }),
    page.getByRole('link', { name: SIGNED_OUT_NAME }),
    page.locator('[data-testid="login-button"]')
  ]);
  if (signedOut) {
    throw new Error('Chưa đăng nhập ChatGPT. Bấm “Đăng nhập ChatGPT”, đăng nhập trong cửa sổ trình duyệt rồi Thử lại.');
  }
  if (!box) {
    if (challenge.test(await page.title().catch(() => ''))) {
      throw new Error('ChatGPT đang yêu cầu xác minh chống bot. Hãy mở cửa sổ ChatGPT, tự hoàn tất bước xác minh rồi bấm Thử lại.');
    }
    throw new Error('Không tìm thấy ô nhập của ChatGPT. Có thể giao diện vừa thay đổi hoặc trang chưa tải xong.');
  }
  return box;
}

async function openFreshChat(page, log, purpose, isCancelled) {
  throwIfCancelled(isCancelled, 'Đã hủy trước khi mở ChatGPT.');
  await page.goto(chatgptUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  throwIfCancelled(isCancelled, 'Đã hủy trong lúc mở ChatGPT.');
  await assertChatGPTSignedIn(page);
  await log('chatgpt.auth.ok', { url: page.url(), purpose });
}

async function fileInput(page) {
  const inputs = page.locator('input[type=file]');
  const count = await inputs.count().catch(() => 0);
  const candidates = [];
  for (let index = 0; index < count; index += 1) {
    const input = inputs.nth(index);
    const [id, accept, multiple, capture] = await Promise.all([
      input.getAttribute('id').catch(() => ''),
      input.getAttribute('accept').catch(() => ''),
      input.evaluate((element) => element.multiple).catch(() => false),
      input.getAttribute('capture').catch(() => null)
    ]);
    if (capture || /camera/i.test(id || '')) continue;
    if (accept && !/image/i.test(accept)) continue;
    candidates.push({ input, multiple });
  }
  return (candidates.find((item) => item.multiple) || candidates[0])?.input || null;
}

async function attachFiles(page, files, log, isCancelled) {
  throwIfCancelled(isCancelled, 'Đã hủy trước khi đính kèm khung hình lên ChatGPT.');
  let input = await fileInput(page);
  if (!input) {
    const attach = await firstVisibleEventually([
      page.getByRole('button', { name: /add files and more|add photos|attach files|upload files|thêm tệp|đính kèm|tải tệp/i }),
      page.locator('button[aria-label*="attach" i], button[aria-label*="add files" i]')
    ], 15000);
    if (!attach) throw new Error('Không tìm thấy nút đính kèm tệp của ChatGPT.');
    const chooserFromButton = page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null);
    await attach.click();
    let chooser = await chooserFromButton;
    if (!chooser) {
      const menuItem = await firstVisibleEventually([
        page.getByRole('menuitem', { name: /add photos|photos (&|and) files|upload from computer|upload a file|tải lên từ máy|thêm ảnh/i })
      ], 3000);
      if (menuItem) {
        const chooserFromMenu = page.waitForEvent('filechooser', { timeout: 10000 }).catch(() => null);
        await menuItem.click();
        chooser = await chooserFromMenu;
      }
    }
    if (chooser) {
      await chooser.setFiles(files);
      await log('chatgpt.upload.selected', { method: 'filechooser', count: files.length, filenames: files.map((file) => path.basename(file)) });
      return;
    }
    input = await fileInput(page);
    if (!input) throw new Error('ChatGPT không mở ô chọn tệp để đính kèm ảnh khung hình.');
  }
  await input.setInputFiles(files);
  await log('chatgpt.upload.selected', { method: 'input', count: files.length, filenames: files.map((file) => path.basename(file)) });
}

/**
 * ChatGPT cannot take the source video file the way Gemini did, so the video is sampled into
 * contact-sheet grids with FFmpeg and those images are attached instead. The audio track is lost;
 * this note tells the model so it does not invent dialogue.
 */
export function describeContactSheets(sheets = []) {
  if (!sheets.length) return '';
  return [
    'SOURCE FRAMES: the original video file cannot be uploaded to ChatGPT, so it was replaced by the attached contact-sheet images. Each sheet is a grid of frames sampled evenly across the video, read left-to-right then top-to-bottom in time order. The original audio track is NOT available: do not invent dialogue, narration, or music that the frames do not show.',
    ...sheets.map((sheet, index) => `Sheet ${index + 1}: ${sheet.frames} frames covering ${sheet.startSeconds.toFixed(1)}s–${sheet.endSeconds.toFixed(1)}s of the source video.`)
  ].join('\n');
}

async function withSourceFrames({ job, duration, page, log, onStatus, isCancelled }, run) {
  const seconds = Number(duration) || (await getVideoMetadata(job.sourcePath)).duration;
  const prefix = path.resolve('data/outputs', `${job.id}-ref-sheet`);
  throwIfCancelled(isCancelled, 'Đã hủy trước khi trích khung hình từ video.');
  const sheets = await extractContactSheets(job.sourcePath, prefix, { duration: seconds });
  await log('chatgpt.frames.extracted', {
    sheetCount: sheets.length,
    frameCount: sheets.reduce((sum, sheet) => sum + sheet.frames, 0),
    sourceDuration: seconds
  });
  try {
    onStatus(`Đang tải ${sheets.length} ảnh ghép khung hình lên ChatGPT…`);
    await attachFiles(page, sheets.map((sheet) => sheet.path), log, isCancelled);
    return await run(describeContactSheets(sheets));
  } finally {
    await Promise.all(sheets.map((sheet) => fs.rm(sheet.path, { force: true }).catch(() => {})));
  }
}

async function responseCounts(page) {
  return {
    assistant: await page.locator(ASSISTANT_SELECTOR).count().catch(() => 0),
    turns: await page.locator(TURN_SELECTOR).count().catch(() => 0)
  };
}

async function responseContent(response) {
  const candidates = [
    response.locator('.markdown'),
    response.locator('[class*="markdown"]'),
    response.locator('.whitespace-pre-wrap')
  ];
  for (const candidate of candidates) {
    if (await candidate.count().catch(() => 0)) return candidate.last();
  }
  return response;
}

async function codeBlockText(content) {
  if (!content) return '';
  return content.evaluate((element) => [...element.querySelectorAll('pre')]
    .map((pre) => (pre.querySelector('code') || pre).textContent.trim())
    .filter(Boolean)
    .join('\n\n')).catch(() => '');
}

export async function waitForChatGPTResponse(page, options = {}) {
  const {
    previousAssistantCount = 0,
    previousTurnCount = 0,
    timeoutMs = responseTimeout,
    pollIntervalMs = 1500,
    stablePolls = 3,
    logIntervalMs = 30000,
    attempt = 1,
    log = async () => {},
    isCancelled,
    preferCodeBlock = false
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
    const assistants = page.locator(ASSISTANT_SELECTOR);
    const turns = page.locator(TURN_SELECTOR);
    const assistantCount = await assistants.count().catch(() => 0);
    const turnCount = await turns.count().catch(() => 0);

    if (!response || !await response.count().catch(() => 0)) {
      if (assistantCount > previousAssistantCount) {
        response = assistants.last();
        responseKind = 'assistant-role';
      } else if (turnCount >= previousTurnCount + 2) {
        // Without author-role markers the user's own turn appears first; only the second new
        // turn is the answer. Taking the first would return our prompt as the "response".
        response = turns.last();
        responseKind = 'conversation-turn';
      }
    }

    if (response && !detectedLogged) {
      await log('chatgpt.response.detected', { attempt, responseKind, elapsedMs: Date.now() - startedAt });
      detectedLogged = true;
    }

    const banner = await firstVisible([page.getByText(ERROR_BANNER)]);
    if (banner) {
      const bannerText = (await banner.innerText().catch(() => '')).trim().slice(0, 300);
      throw new Error(`ChatGPT báo lỗi thay vì trả lời: ${bannerText || 'không đọc được nội dung lỗi'}`);
    }

    const content = response ? await responseContent(response) : null;
    const current = content ? (await content.innerText().catch(() => '')).trim() : '';
    const stopVisible = await anyVisible(page.locator(STOP_SELECTOR));
    const streaming = response ? (await response.locator('.result-streaming, [data-is-streaming="true"]').count().catch(() => 0)) > 0 : false;
    const generating = stopVisible || streaming;
    lastGenerating = generating;
    lastText = current;

    if (current.length >= 20 && current === previousText && !generating) stableCount += 1;
    else stableCount = 0;

    if (stableCount >= stablePolls) {
      // Code blocks keep backslashes verbatim; rendered prose has already lost them (\" became ").
      const codeText = preferCodeBlock ? await codeBlockText(content) : '';
      const result = codeText || current;
      await log('chatgpt.response.ready', {
        attempt,
        responseKind,
        source: codeText ? 'code_block' : 'rendered_text',
        elapsedMs: Date.now() - startedAt,
        responseLength: result.length,
        responseSha256: crypto.createHash('sha256').update(result).digest('hex')
      });
      return result;
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= nextLogAt) {
      await log('chatgpt.response.waiting', {
        attempt,
        elapsedMs,
        responseDetected: Boolean(response),
        responseLength: current.length,
        generating,
        assistantCount,
        turnCount
      });
      nextLogAt = elapsedMs + logIntervalMs;
    }

    throwIfCancelled(isCancelled, 'Đã hủy trong lúc chờ ChatGPT trả lời.');
    previousText = current;
    await page.waitForTimeout(pollIntervalMs);
  }

  throw new Error(
    `ChatGPT không hoàn tất phản hồi sau ${Math.round(timeoutMs / 60000)} phút ` +
    `(đã thấy phản hồi: ${Boolean(response)}, ký tự: ${lastText.length}, vẫn đang tạo: ${lastGenerating}).`
  );
}

async function fillAndSend(page, prompt, log, attempt, isCancelled) {
  throwIfCancelled(isCancelled, 'Đã hủy trước khi gửi prompt cho ChatGPT.');
  const box = await firstVisibleEventually(promptBoxLocators(page), 30000);
  if (!box) throw new Error('Không tìm thấy ô nhập của ChatGPT.');
  const counts = await responseCounts(page);
  await box.fill(prompt);
  await log('chatgpt.prompt.filled', { attempt, promptLength: prompt.length });
  const send = await waitForChatGPTSendButton(page);
  if (!send) throw new Error('Không tìm thấy nút Gửi của ChatGPT.');
  const waitStarted = Date.now();
  while (!await send.isEnabled().catch(() => false)) {
    throwIfCancelled(isCancelled, 'Đã hủy trong lúc chờ ChatGPT sẵn sàng nút Gửi.');
    if (Date.now() - waitStarted > 300000) {
      throw new Error('ChatGPT chưa xử lý xong tệp đính kèm sau 5 phút; nút Gửi vẫn bị khóa.');
    }
    await page.waitForTimeout(1000);
  }
  throwIfCancelled(isCancelled, 'Đã hủy trước khi bấm nút Gửi ChatGPT.');
  await log('chatgpt.submit.enabled', { attempt, waitedMs: Date.now() - waitStarted });
  await send.click();
  await log('chatgpt.submit.clicked', { attempt, previousAssistantCount: counts.assistant, previousTurnCount: counts.turns });
  return counts;
}

async function submitAndRead(page, prompt, log, attempt, isCancelled, { preferCodeBlock = false } = {}) {
  const counts = await fillAndSend(page, prompt, log, attempt, isCancelled);
  return waitForChatGPTResponse(page, {
    isCancelled,
    preferCodeBlock,
    previousAssistantCount: counts.assistant,
    previousTurnCount: counts.turns,
    timeoutMs: responseTimeout,
    attempt,
    log
  });
}

async function saveRawResponse(jobId, raw, attempt, log, purpose = '') {
  const purposeSuffix = purpose ? `-${purpose}` : '';
  const filename = `${jobId}-chatgpt${purposeSuffix}-raw-${attempt}.txt`;
  await fs.writeFile(path.resolve('data/logs', filename), raw, 'utf8');
  await log('chatgpt.response.saved', {
    attempt, purpose: purpose || 'storyboard', responseUrl: `/logs/${filename}`, responseLength: raw.length
  });
}

function withFramesNote(instruction, framesNote) {
  return [instruction, framesNote].filter(Boolean).join('\n\n');
}

export async function describeVideoWithChatGPT(job, metadata, onStatus = () => {}, { isCancelled } = {}) {
  throwIfCancelled(isCancelled, 'Đã hủy trước khi phân tích nội dung video.');
  const page = await chatgptPage();
  const log = (event, details = {}) => logJob(job.id, event, { purpose: 'describe_video', ...details });
  onStatus('Đang mở ChatGPT để phân tích nội dung video…');
  await openFreshChat(page, log, 'describe_video', isCancelled);

  return withSourceFrames({ job, duration: metadata?.duration, page, log, onStatus, isCancelled }, async (framesNote) => {
    const instruction = withFramesNote(buildVideoDescriptionPrompt({
      duration: metadata.duration,
      userInstruction: job.prompt || '',
      outputLanguage: job.language || 'auto'
    }), framesNote);
    onStatus('ChatGPT đang xem khung hình và phân tích nội dung video…');
    let raw = await submitAndRead(page, instruction, log, 1, isCancelled);
    await saveRawResponse(job.id, raw, 1, log, 'describe');
    try {
      const videoDescription = parseVideoDescription(raw);
      await log('chatgpt.video_description.validated', { repaired: false, descriptionLength: videoDescription.length });
      return { videoDescription, rawResponse: raw, repaired: false };
    } catch (error) {
      if (isCancellation(error)) throw error;
      await log('chatgpt.video_description.invalid', { attempt: 1, error: sanitizeError(error) });
      onStatus('ChatGPT đang hoàn thiện bản mô tả nội dung video…');
      const repairPrompt = [
        `Phản hồi trước chưa đạt yêu cầu: ${error.message}`,
        'Hãy xem kỹ các ảnh khung hình đã tải lên và mô tả đầy đủ, chi tiết nội dung video theo 5 phần: Chủ thể & Nhân vật, Bối cảnh & Không gian, Diễn biến hành động theo thời gian, Âm thanh & Thoại (chỉ những gì suy ra được từ hình), Thông điệp & Tổng kết.'
      ].join('\n');
      raw = await submitAndRead(page, repairPrompt, log, 2, isCancelled);
      await saveRawResponse(job.id, raw, 2, log, 'describe');
      const videoDescription = parseVideoDescription(raw);
      await log('chatgpt.video_description.validated', { repaired: true, descriptionLength: videoDescription.length });
      return { videoDescription, rawResponse: raw, repaired: true };
    }
  });
}

export async function analyzeVideoWithChatGPT(job, metadata, onStatus = () => {}, { isCancelled, videoDescription = '', story = null } = {}) {
  throwIfCancelled(isCancelled, 'Đã hủy trước khi phân tích video.');
  const page = await chatgptPage();
  const log = (event, details = {}) => logJob(job.id, event, details);
  onStatus('Đang mở ChatGPT…');
  await openFreshChat(page, log, 'storyboard', isCancelled);
  const targetDuration = job.targetDuration ?? null;
  const clipSeconds = Number(job.clipSeconds) || 10;
  const expectedParts = expectedPartCount(targetDuration ?? metadata.duration, clipSeconds);

  return withSourceFrames({ job, duration: metadata?.duration, page, log, onStatus, isCancelled }, async (framesNote) => {
    const instruction = withFramesNote(buildStoryboardPrompt({
      duration: metadata.duration,
      targetDuration,
      userInstruction: job.prompt,
      aspectRatio: metadata.aspectRatio,
      outputLanguage: job.language || 'auto',
      clipSeconds,
      videoDescription,
      story
    }), framesNote);
    onStatus(`ChatGPT đang viết ${expectedParts} prompt cho Grok tạo video tương tự…`);
    const { value: plan, rawResponse, repaired, attempt } = await requestJson({
      job, page, log, onStatus, isCancelled, instruction,
      purpose: '',
      eventPrefix: 'chatgpt.plan',
      retryStatus: 'ChatGPT đang sửa lại JSON prompt',
      repairPrompt: (error) => buildRepairPrompt(error, expectedParts),
      parse: (raw) => parseStoryboard(raw, { duration: metadata.duration, targetDuration, clipSeconds })
    });
    await log('chatgpt.plan.validated', { partCount: plan.parts.length, repaired, attempt });
    return { plan, rawResponse, repaired };
  });
}

/**
 * Sends a prompt that must come back as JSON and retries in the same conversation (so attached frames
 * stay in context) up to CHATGPT_JSON_MAX_ATTEMPTS times. Every retry quotes the exact parse error and
 * restates the code-block rule, because the usual failure is Markdown stripping \" escapes.
 */
async function requestJson({ job, page, log, onStatus, isCancelled, instruction, repairPrompt, parse, purpose, eventPrefix, retryStatus }) {
  const maxAttempts = maxJsonAttempts();
  const outcome = await runJsonAttempts({
    maxAttempts,
    isCancellation,
    ask: async (attempt, lastError) => {
      throwIfCancelled(isCancelled, `Đã hủy trước lần thử ${attempt}.`);
      if (attempt > 1) onStatus(`${retryStatus} (lần thử ${attempt}/${maxAttempts})…`);
      const prompt = attempt === 1
        ? instruction
        : [repairPrompt(lastError, attempt), jsonRetryInstruction(lastError, { attempt, maxAttempts })].filter(Boolean).join('\n\n');
      const raw = await submitAndRead(page, prompt, log, attempt, isCancelled, { preferCodeBlock: true });
      await saveRawResponse(job.id, raw, attempt, log, purpose);
      return raw;
    },
    parse,
    onInvalid: (error, attempt) => log(`${eventPrefix}.invalid`, { attempt, maxAttempts, error: sanitizeError(error) }),
    failureMessage: (error, attempts) => `ChatGPT không trả JSON hợp lệ sau ${attempts} lần thử: ${error?.message || 'không rõ lỗi'}`
  });
  return { value: outcome.value, rawResponse: outcome.raw, repaired: outcome.attempt > 1, attempt: outcome.attempt };
}

async function writeStoryWithRetries({ job, page, log, onStatus, isCancelled, instruction, repairPrompt, parse, purpose, labels }) {
  onStatus(labels.first);
  let outcome;
  try {
    outcome = await requestJson({
      job, page, log, onStatus, isCancelled, instruction, repairPrompt, purpose,
      eventPrefix: `chatgpt.${purpose}`,
      retryStatus: labels.retry,
      parse: (raw, attempt) => parse(raw, { minWords: attempt === 1 ? MIN_STORY_WORDS : MIN_STORY_WORDS_RETRY })
    });
  } catch (error) {
    if (isCancellation(error)) throw error;
    throw new Error(error.message.replace('ChatGPT không trả JSON hợp lệ', `ChatGPT không tạo được ${labels.noun} hợp lệ`), { cause: error });
  }
  const { value: story, rawResponse, repaired, attempt } = outcome;
  await log(`chatgpt.${purpose}.validated`, {
    repaired, attempt, title: story.title, contentLength: story.content.length, wordCount: story.wordCount
  });
  return { story, rawResponse, repaired };
}

export async function generateStoryFromVideoWithChatGPT(job, metadata, onStatus = () => {}, { isCancelled, videoPlan = null, userPrompt = '', videoDescription = '' } = {}) {
  throwIfCancelled(isCancelled, 'Đã hủy trước khi sáng tác câu chuyện.');
  const page = await chatgptPage();
  const log = (event, details = {}) => logJob(job.id, event, { purpose: 'story', ...details });
  onStatus('Đang mở ChatGPT để sáng tác câu chuyện…');
  await openFreshChat(page, log, 'story', isCancelled);

  const videoSummary = videoPlan?.summary || '';
  const globalContinuity = videoPlan?.globalContinuity || '';
  const run = (framesNote) => writeStoryWithRetries({
    job, page, log, onStatus, isCancelled,
    purpose: 'story',
    instruction: withFramesNote(buildStoryPrompt({
      duration: metadata?.duration,
      outputLanguage: job.language || 'auto',
      videoDescription,
      videoSummary,
      globalContinuity,
      planParts: videoPlan?.parts || [],
      userPrompt: userPrompt || job.prompt || ''
    }), framesNote),
    repairPrompt: (error, attempt) => buildStoryRepairPrompt(error, {
      outputLanguage: job.language || 'auto', attempt, videoDescription, videoSummary, globalContinuity
    }),
    parse: parseStory,
    labels: {
      action: 'sáng tác câu chuyện',
      first: 'ChatGPT đang sáng tác câu chuyện dài trên 2.000 từ bám sát video nguồn…',
      retry: 'ChatGPT đang hoàn thiện câu chuyện trên 2.000 từ',
      noun: 'câu chuyện'
    }
  });

  // Đã có bản mô tả video từ bước 1 thì gửi chữ là đủ, không cần đính kèm lại khung hình.
  if (!videoDescription && job.sourcePath) {
    return withSourceFrames({ job, duration: metadata?.duration, page, log, onStatus, isCancelled }, run);
  }
  return run('');
}

export async function generateAutoTopicWithChatGPT(job, onStatus = () => {}, { isCancelled } = {}) {
  throwIfCancelled(isCancelled, 'Đã hủy trước khi tìm kiếm xu hướng bằng ChatGPT.');
  const page = await chatgptPage();
  const log = (event, details = {}) => logJob(job.id, event, details);
  const targetDuration = Number(job.targetDuration ?? 10);
  const clipSeconds = Number(job.clipSeconds) || 10;
  const expectedParts = expectedPartCount(targetDuration, clipSeconds);
  const researchDate = trendDateKey();
  onStatus('Đang mở ChatGPT để tìm xu hướng…');
  await openFreshChat(page, log, 'auto_topic', isCancelled);
  const instruction = buildAutoTopicPrompt({
    targetDuration,
    outputLanguage: job.language || 'auto',
    aspectRatio: job.aspectRatio || '16:9',
    clipSeconds,
    currentDate: researchDate
  });
  await log('chatgpt.auto_topic.search.requested', {
    researchDate, targetDuration, expectedParts, language: job.language || 'auto',
    groundingMode: 'chatgpt_web_search_prompt', clipSeconds
  });
  onStatus(`ChatGPT đang tìm xu hướng và viết ${expectedParts} part cho ${targetDuration} giây…`);
  const { value: plan, rawResponse, repaired, attempt } = await requestJson({
    job, page, log, onStatus, isCancelled, instruction,
    purpose: '',
    eventPrefix: 'chatgpt.auto_topic.plan',
    retryStatus: 'ChatGPT đang chuẩn hóa lại kịch bản',
    repairPrompt: (error) => buildAutoTopicRepairPrompt(error, { expectedParts, targetDuration, currentDate: researchDate, clipSeconds }),
    parse: (raw) => parseAutoTopicPlan(raw, { targetDuration, clipSeconds })
  });
  await log('chatgpt.auto_topic.plan.validated', {
    partCount: plan.parts.length,
    selectedTopic: plan.selectedTopic || plan.summary,
    sourceCount: plan.sources.length,
    searchEvidence: plan.sources.length ? 'source_urls_returned' : 'not_exposed_by_chatgpt_web',
    repaired,
    attempt
  });
  return { plan, rawResponse, repaired, researchDate };
}

export async function generateTopicStoryWithChatGPT(job, onStatus = () => {}, { isCancelled } = {}) {
  throwIfCancelled(isCancelled, 'Đã hủy trước khi viết câu chuyện theo chủ đề.');
  const page = await chatgptPage();
  const log = (event, details = {}) => logJob(job.id, event, details);
  const targetDuration = Number(job.targetDuration ?? 10);
  const clipSeconds = Number(job.clipSeconds) || 10;
  const expectedParts = expectedPartCount(targetDuration, clipSeconds);
  onStatus('Đang mở ChatGPT để viết câu chuyện và kịch bản video…');
  await openFreshChat(page, log, 'topic_story', isCancelled);
  const instruction = buildTopicStoryPrompt({
    userPrompt: job.prompt || '',
    targetDuration,
    outputLanguage: job.language || 'auto',
    aspectRatio: job.aspectRatio || '16:9',
    clipSeconds
  });
  await log('chatgpt.topic_story.requested', { targetDuration, expectedParts, language: job.language || 'auto', clipSeconds });
  onStatus(`ChatGPT đang viết câu chuyện và ${expectedParts} part cho ${targetDuration} giây…`);
  const { value: plan, rawResponse, repaired, attempt } = await requestJson({
    job, page, log, onStatus, isCancelled, instruction,
    purpose: 'story',
    eventPrefix: 'chatgpt.topic_story',
    retryStatus: 'ChatGPT đang sửa lại câu chuyện và kịch bản',
    repairPrompt: (error) => buildTopicStoryRepairPrompt(error, {
      expectedParts, targetDuration, outputLanguage: job.language || 'auto', clipSeconds
    }),
    parse: (raw, attemptNumber) => parseTopicStoryPlan(raw, {
      targetDuration, clipSeconds, minWords: attemptNumber === 1 ? MIN_STORY_WORDS : MIN_STORY_WORDS_RETRY
    })
  });
  await log('chatgpt.topic_story.validated', {
    partCount: plan.parts.length, title: plan.title, contentLength: plan.content.length, wordCount: plan.wordCount, repaired, attempt
  });
  return {
    story: { title: plan.title, content: plan.content, wordCount: plan.wordCount },
    plan,
    rawResponse,
    repaired
  };
}

export async function generateMasterStoryWithChatGPT(job, onStatus = () => {}, { isCancelled, videoPlan = null } = {}) {
  throwIfCancelled(isCancelled, 'Đã hủy trước khi sáng tác tác phẩm.');
  const page = await chatgptPage();
  const log = (event, details = {}) => logJob(job.id, event, { purpose: 'master_story', ...details });
  onStatus('Đang mở ChatGPT để sáng tác tác phẩm văn học nghệ thuật…');
  await openFreshChat(page, log, 'master_story', isCancelled);

  const videoSummary = videoPlan?.summary || '';
  const globalContinuity = videoPlan?.globalContinuity || '';
  const run = (framesNote) => writeStoryWithRetries({
    job, page, log, onStatus, isCancelled,
    purpose: 'master_story',
    instruction: withFramesNote(buildMasterWriterPrompt({
      userPrompt: job.prompt || '',
      outputLanguage: job.language || 'auto',
      duration: job.sourceDuration,
      hasSource: Boolean(job.sourcePath),
      videoSummary,
      globalContinuity,
      planParts: videoPlan?.parts || []
    }), framesNote),
    repairPrompt: (error, attempt) => buildMasterWriterRepairPrompt(error, {
      outputLanguage: job.language || 'auto', attempt, videoSummary, globalContinuity
    }),
    parse: parseMasterStory,
    labels: {
      action: 'sáng tác tác phẩm',
      first: 'Nhà văn kiệt xuất (ChatGPT) đang sáng tác tác phẩm trường đoạn trên 2.000 từ…',
      retry: 'ChatGPT đang trau chuốt và mở rộng tác phẩm trên 2.000 từ',
      noun: 'tác phẩm văn học'
    }
  });

  if (job.sourcePath) {
    return withSourceFrames({ job, duration: job.sourceDuration, page, log, onStatus, isCancelled }, run);
  }
  return run('');
}

async function latestGeneratedImage(page, previousImageCount) {
  const images = page.locator(`${ASSISTANT_SELECTOR} img, ${TURN_SELECTOR} img`);
  const count = await images.count().catch(() => 0);
  for (let index = count - 1; index >= previousImageCount; index -= 1) {
    const image = images.nth(index);
    const ready = await image.evaluate((element) => element.complete && element.naturalWidth >= 256).catch(() => false);
    if (ready && await image.isVisible().catch(() => false)) return image;
  }
  return null;
}

async function renderPosterFallback(page, story, thumbnailPath) {
  const posterPage = await page.context().newPage();
  try {
    await posterPage.setViewportSize({ width: 1280, height: 720 });
    const escape = (value) => String(value).replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeTitle = escape(story.title || 'Câu Chuyện Nghệ Thuật');
    const snippet = escape((story.content || '').replace(/<[^>]+>/g, '').slice(0, 180));
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
  } finally {
    await posterPage.close().catch(() => {});
  }
}

export async function generateStoryThumbnailWithChatGPT(job, story, onStatus = () => {}, { isCancelled = null } = {}) {
  throwIfCancelled(isCancelled, 'Đã hủy trước khi tạo ảnh đại diện.');
  const log = (event, details = {}) => logJob(job.id, event, { purpose: 'thumbnail', ...details });
  const thumbnailFilename = `${job.id}-thumbnail.png`;
  const thumbnailPath = path.resolve('data/outputs', thumbnailFilename);
  const thumbnailUrl = `/outputs/${thumbnailFilename}`;

  const exists = await fs.stat(thumbnailPath).then((stat) => stat.isFile() && stat.size > 0).catch(() => false);
  if (exists) {
    await log('chatgpt.thumbnail.reused', { thumbnailPath, thumbnailUrl });
    return { thumbnailPath, thumbnailUrl };
  }

  onStatus('Đang mở ChatGPT để tạo ảnh đại diện…');
  const page = await chatgptPage();
  await openFreshChat(page, log, 'thumbnail', isCancelled);
  onStatus('ChatGPT đang tạo ảnh đại diện 16:9 cho bài viết…');

  let imageCaptured = false;
  try {
    const previousImageCount = await page.locator(`${ASSISTANT_SELECTOR} img, ${TURN_SELECTOR} img`).count().catch(() => 0);
    await fillAndSend(page, buildThumbnailPrompt({ title: story.title, content: story.content }), log, 1, isCancelled);
    await log('chatgpt.thumbnail.submitted');

    const startWait = Date.now();
    while (Date.now() - startWait < imageTimeout) {
      throwIfCancelled(isCancelled, 'Đã hủy trong lúc chờ ảnh đại diện từ ChatGPT.');
      const stopVisible = await anyVisible(page.locator(STOP_SELECTOR));
      const image = await latestGeneratedImage(page, previousImageCount);
      // ChatGPT streams blurred previews while drawing; capture only once generation has stopped.
      if (image && !stopVisible) {
        await page.waitForTimeout(1500);
        await image.screenshot({ path: thumbnailPath });
        const stat = await fs.stat(thumbnailPath).catch(() => null);
        if (stat && stat.size > 1000) {
          imageCaptured = true;
          await log('chatgpt.thumbnail.captured', { bytes: stat.size });
          break;
        }
      }
      if (!image && !stopVisible && Date.now() - startWait > 20000) break;
      await page.waitForTimeout(2000);
    }
  } catch (error) {
    if (isCancellation(error)) throw error;
    await log('chatgpt.thumbnail.generation_warning', { error: sanitizeError(error) });
  }

  throwIfCancelled(isCancelled, 'Đã hủy trước khi dựng ảnh đại diện dự phòng.');
  if (!imageCaptured) {
    await log('chatgpt.thumbnail.fallback_poster_rendering', { title: story.title });
    onStatus('Đang hoàn thiện ảnh bìa nghệ thuật cho bài viết…');
    await renderPosterFallback(page, story, thumbnailPath);
    await log('chatgpt.thumbnail.fallback_created', { thumbnailPath });
  }
  return { thumbnailPath, thumbnailUrl };
}

export async function generateStoryboardFromStoryWithChatGPT(job, story, onStatus = () => {}, { isCancelled } = {}) {
  throwIfCancelled(isCancelled, 'Đã hủy trước khi chuyển thể kịch bản.');
  const page = await chatgptPage();
  const log = (event, details = {}) => logJob(job.id, event, { purpose: 'storyboard_from_story', ...details });
  const targetDuration = Number(job.targetDuration ?? job.clipSeconds ?? 10);
  const clipSeconds = Number(job.clipSeconds) || 10;
  const expectedParts = expectedPartCount(targetDuration, clipSeconds);

  onStatus('Đang mở ChatGPT để chuyển thể câu chuyện thành kịch bản video…');
  await openFreshChat(page, log, 'storyboard_from_story', isCancelled);
  const instruction = buildStoryboardFromStoryPrompt({
    story, targetDuration, clipSeconds, aspectRatio: job.aspectRatio || '16:9', outputLanguage: job.language || 'auto'
  });

  onStatus(`ChatGPT đang chuyển thể câu chuyện thành ${expectedParts} phân cảnh video…`);
  const { value: plan, rawResponse, repaired, attempt } = await requestJson({
    job, page, log, onStatus, isCancelled, instruction,
    purpose: 'storyboard_from_story',
    eventPrefix: 'chatgpt.storyboard_from_story',
    retryStatus: 'ChatGPT đang chuẩn hóa lại kịch bản phân cảnh',
    repairPrompt: (error) => buildStoryboardFromStoryRepairPrompt(error, { expectedParts, targetDuration, clipSeconds }),
    parse: (raw) => parseStoryboardFromStory(raw, { targetDuration, clipSeconds })
  });
  plan.title = story.title;
  await log('chatgpt.storyboard_from_story.validated', { partCount: plan.parts.length, title: story.title, repaired, attempt });
  return { plan, rawResponse, repaired };
}

export async function captureChatGPTDiagnostics(jobId, error) {
  const page = await chatgptPage();
  const screenshotPath = path.resolve('data/logs', `${jobId}-chatgpt-error.png`);
  const htmlPath = path.resolve('data/logs', `${jobId}-chatgpt-error.html`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  await fs.writeFile(htmlPath, await page.content().catch(() => '')).catch(() => {});
  await logJob(jobId, 'chatgpt.error', { error: sanitizeError(error), url: page.url(), screenshotPath, htmlPath });
}

export async function abortChatGPT() {
  if (!context) return;
  const pages = context.pages().slice();
  await Promise.all(pages.map((page) => page.close().catch(() => {})));
}

export async function closeChatGPTBrowser() {
  if (context) await context.close();
}
