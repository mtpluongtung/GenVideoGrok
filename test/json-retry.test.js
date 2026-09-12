import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import {
  JSON_CODE_BLOCK_RULE,
  buildAutoTopicPrompt,
  buildAutoTopicRepairPrompt,
  buildMasterWriterPrompt,
  buildMasterWriterRepairPrompt,
  buildRepairPrompt,
  buildStoryPrompt,
  buildStoryRepairPrompt,
  buildStoryboardFromStoryPrompt,
  buildStoryboardFromStoryRepairPrompt,
  buildStoryboardPrompt,
  buildTopicStoryPrompt,
  buildTopicStoryRepairPrompt,
  escapeStrayQuotes,
  jsonRetryInstruction,
  parseLenientJson,
  parseStoryboard,
  runJsonAttempts
} from '../lib/prompt-plan.js';
import { waitForChatGPTResponse } from '../lib/chatgpt.js';

const longPrompt = 'A cinematic shot follows the same subject through the scene with precise camera motion, lighting, ambient audio, and a clean transition.';
const continuity = 'The same thin boy with dark messy hair, a soaked grey hoodie, cold blue street light and handheld camera language remain unchanged.';

test('vá được ngoặc kép lạc giống hệt phản hồi ChatGPT đã làm hỏng job thật', () => {
  // Mẫu lấy từ data/logs/<job>-chatgpt-raw-1.txt: Markdown đã nuốt dấu \ trước ngoặc kép.
  const broken = '{\n"schemaVersion": 1,\n"summary": "A short film about a rain-soaked boy holding an "I\'m hungry" cardboard sign on a cold street."\n}';
  assert.throws(() => JSON.parse(broken), /Expected ',' or '}' after property value/);
  assert.equal(
    parseLenientJson(broken).summary,
    'A short film about a rain-soaked boy holding an "I\'m hungry" cardboard sign on a cold street.'
  );
});

test('escapeStrayQuotes giữ nguyên JSON vốn hợp lệ và thoát xuống dòng thô trong chuỗi', () => {
  const valid = '{"a":"say \\"hi\\"","b":[1,2],"c":{"d":"x"}}';
  assert.equal(escapeStrayQuotes(valid), valid);
  assert.deepEqual(JSON.parse(escapeStrayQuotes('{"text":"line one\nline two"}')), { text: 'line one\nline two' });
});

test('escapeStrayQuotes xử lý chuẩn xác lời thoại có dấu phẩy sau ngoặc kép', () => {
  const rawWithStray = '{\n"prompt": "The man says "Take this", and hands warm food to the boy."\n}';
  assert.equal(parseLenientJson(rawWithStray).prompt, 'The man says "Take this", and hands warm food to the boy.');
});

test('parseLenientJson vẫn ném lỗi gốc khi không vá được', () => {
  assert.throws(() => parseLenientJson('{"a": }'), SyntaxError);
});

test('parseStoryboard đọc được kế hoạch có lời thoại chứa ngoặc kép chưa escape', () => {
  const raw = [
    '{',
    '"schemaVersion": 1,',
    '"summary": "A boy holds an "I\'m hungry" sign until an old man helps him.",',
    `"globalContinuity": "${continuity}",`,
    '"parts": [',
    `{"partNumber": 1, "prompt": "${longPrompt} The boy lifts a sign reading "I'm hungry" toward passing cars."},`,
    `{"partNumber": 2, "prompt": "${longPrompt} An old man says "Take this" and hands him warm food."}`,
    ']',
    '}'
  ].join('\n');

  const plan = parseStoryboard(raw, { duration: 12 });
  assert.equal(plan.parts.length, 2);
  assert.match(plan.summary, /"I'm hungry"/);
  assert.match(plan.parts[1].prompt, /says "Take this" and hands/);
});

test('runJsonAttempts thử lại tới khi có JSON hợp lệ và ghi nhận từng lần hỏng', async () => {
  const replies = ['{"a": "hỏng "x" y"', 'không phải JSON', '```json\n{"a": 1}\n```'];
  const asked = [];
  const invalid = [];
  const outcome = await runJsonAttempts({
    maxAttempts: 3,
    ask: async (attempt, lastError) => {
      asked.push({ attempt, hadError: Boolean(lastError) });
      return replies[attempt - 1];
    },
    parse: (raw) => {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('không thấy JSON');
      return JSON.parse(match[0]);
    },
    onInvalid: async (_error, attempt) => { invalid.push(attempt); }
  });

  assert.deepEqual(outcome.value, { a: 1 });
  assert.equal(outcome.attempt, 3);
  assert.equal(outcome.raw, replies[2]);
  assert.deepEqual(invalid, [1, 2]);
  assert.deepEqual(asked, [
    { attempt: 1, hadError: false },
    { attempt: 2, hadError: true },
    { attempt: 3, hadError: true }
  ]);
});

test('runJsonAttempts hết lượt thì báo lỗi kèm số lần thử và giữ lỗi cuối làm cause', async () => {
  let calls = 0;
  await assert.rejects(runJsonAttempts({
    maxAttempts: 3,
    ask: async () => { calls += 1; return 'vẫn hỏng'; },
    parse: () => { throw new SyntaxError('Unexpected token v'); },
    failureMessage: (error, attempts) => `ChatGPT không trả JSON hợp lệ sau ${attempts} lần thử: ${error.message}`
  }), (error) => {
    assert.match(error.message, /ChatGPT không trả JSON hợp lệ sau 3 lần thử: Unexpected token v/);
    assert.ok(error.cause instanceof SyntaxError);
    return true;
  });
  assert.equal(calls, 3);
});

test('runJsonAttempts dừng ngay khi bị hủy, không gửi thêm lượt nào', async () => {
  let calls = 0;
  const cancelled = Object.assign(new Error('Đã hủy'), { cancelled: true });
  await assert.rejects(runJsonAttempts({
    maxAttempts: 3,
    ask: async () => { calls += 1; return 'x'; },
    parse: () => { throw cancelled; },
    isCancellation: (error) => Boolean(error?.cancelled)
  }), /Đã hủy/);
  assert.equal(calls, 1);
});

test('runJsonAttempts không nuốt lỗi phát sinh khi gửi prompt (mất mạng, trình duyệt đóng)', async () => {
  let calls = 0;
  await assert.rejects(runJsonAttempts({
    maxAttempts: 3,
    ask: async () => { calls += 1; throw new Error('Không tìm thấy nút Gửi của ChatGPT.'); },
    parse: JSON.parse
  }), /Không tìm thấy nút Gửi/);
  assert.equal(calls, 1);
});

test('lời nhắc retry nêu đúng lỗi, bắt gửi lại toàn bộ JSON trong code block và báo lần cuối', () => {
  const error = new Error("Expected ',' or '}' after property value in JSON at position 136");
  const second = jsonRetryInstruction(error, { attempt: 2, maxAttempts: 3 });
  assert.match(second, /RETRY 2\/3/);
  assert.match(second, /position 136/);
  assert.match(second, /COMPLETE corrected JSON/);
  assert.match(second, /```json/);
  assert.doesNotMatch(second, /final attempt/);
  assert.match(jsonRetryInstruction(error, { attempt: 3, maxAttempts: 3 }), /final attempt/);
});

test('mọi prompt yêu cầu JSON đều bắt đặt trong code block ```json thay vì cấm Markdown fences', () => {
  const error = new Error('JSON lỗi');
  const story = { title: 'Cậu bé', content: 'Một câu chuyện ngắn về cậu bé và người lạ tốt bụng.' };
  const prompts = {
    storyboard: buildStoryboardPrompt({ duration: 30, aspectRatio: '9:16' }),
    storyboardRepair: buildRepairPrompt(error, 3),
    autoTopic: buildAutoTopicPrompt({ targetDuration: 30, currentDate: '2026-09-10' }),
    autoTopicRepair: buildAutoTopicRepairPrompt(error, { expectedParts: 3, targetDuration: 30, currentDate: '2026-09-10' }),
    storyboardFromStory: buildStoryboardFromStoryPrompt({ story, targetDuration: 30 }),
    storyboardFromStoryRepair: buildStoryboardFromStoryRepairPrompt(error, { expectedParts: 3, targetDuration: 30 }),
    topicStory: buildTopicStoryPrompt({ userPrompt: 'Cậu bé và người lạ', targetDuration: 30 }),
    topicStoryRepair: buildTopicStoryRepairPrompt(error, { expectedParts: 3, targetDuration: 30 }),
    story: buildStoryPrompt({ duration: 37, outputLanguage: 'vi' }),
    storyRepair: buildStoryRepairPrompt(error, { outputLanguage: 'vi' }),
    masterWriter: buildMasterWriterPrompt({ userPrompt: 'Cậu bé và người lạ', outputLanguage: 'vi' }),
    masterWriterRepair: buildMasterWriterRepairPrompt(error, { outputLanguage: 'vi' })
  };
  for (const [name, prompt] of Object.entries(prompts)) {
    assert.ok(prompt.includes(JSON_CODE_BLOCK_RULE), `Prompt ${name} thiếu quy tắc code block`);
    assert.doesNotMatch(prompt, /Do not use Markdown fences|Markdown fences or commentary|without Markdown|không dùng Markdown code fences|Không bọc trong Markdown/i, `Prompt ${name} vẫn cấm code block`);
  }
  assert.match(JSON_CODE_BLOCK_RULE, /```json/);
  assert.match(JSON_CODE_BLOCK_RULE, /strips the backslash/);
});

test('đọc JSON từ code block để giữ nguyên dấu gạch chéo ngược thay vì văn bản đã hiển thị', async (t) => {
  const expected = '{"summary":"a sign reading \\"I am hungry\\""}';
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html>
      <div data-message-author-role="assistant"><div class="markdown">
        <p>Here is the plan:</p>
        <pre><div>json</div><button>Copy code</button><code>${expected}</code></pre>
      </div></div>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const options = { timeoutMs: 2000, pollIntervalMs: 30, stablePolls: 2, logIntervalMs: 1000 };

  const fromCode = await waitForChatGPTResponse(page, { ...options, preferCodeBlock: true });
  assert.equal(fromCode, expected);
  assert.deepEqual(JSON.parse(fromCode), { summary: 'a sign reading "I am hungry"' });

  // Bước trả văn xuôi (mô tả video) không được thay câu trả lời bằng riêng phần code.
  const prose = await waitForChatGPTResponse(page, { ...options, preferCodeBlock: false });
  assert.match(prose, /Here is the plan/);
});
