import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { assertChatGPTSignedIn, waitForChatGPTResponse, waitForChatGPTSendButton } from '../lib/chatgpt.js';

async function testPage(t, html) {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });
  return page;
}

test('chờ nút Send message xuất hiện sau khi composer ChatGPT hydrate', async (t) => {
  const page = await testPage(t, `<!doctype html><body>
    <textarea aria-label="Chat with ChatGPT" placeholder="Ask ChatGPT"></textarea>
    <script>
      setTimeout(() => {
        const button = document.createElement('button');
        button.type = 'submit';
        button.setAttribute('aria-label', 'Send message');
        document.body.append(button);
      }, 200);
    </script></body>`);
  const send = await waitForChatGPTSendButton(page, 3000);
  assert.ok(send);
  assert.equal(await send.getAttribute('aria-label'), 'Send message');
});

test('chờ ChatGPT stream xong rồi mới đọc câu trả lời trong lượt assistant mới', async (t) => {
  const expected = '{"schemaVersion":1,"globalContinuity":"consistent subject and lighting","parts":[]}';
  const page = await testPage(t, `<!doctype html>
    <div data-message-author-role="user"><div class="whitespace-pre-wrap">prompt cũ</div></div>
    <button aria-label="Stop streaming" data-testid="stop-button">Stop</button>
    <script>
      setTimeout(() => {
        document.body.insertAdjacentHTML('beforeend', '<div data-message-author-role="assistant"><div class="markdown result-streaming">{"schema</div></div>');
      }, 80);
      setTimeout(() => {
        const markdown = document.querySelector('[data-message-author-role="assistant"] .markdown');
        markdown.textContent = '${expected}';
        markdown.classList.remove('result-streaming');
        document.querySelector('[data-testid="stop-button"]').remove();
      }, 300);
    </script>`);
  const events = [];

  const result = await waitForChatGPTResponse(page, {
    timeoutMs: 2000,
    pollIntervalMs: 40,
    stablePolls: 2,
    logIntervalMs: 100,
    log: async (event, details) => events.push({ event, details })
  });

  assert.equal(result, expected);
  assert.equal(events.find(({ event }) => event === 'chatgpt.response.detected').details.responseKind, 'assistant-role');
  assert.equal(events.at(-1).event, 'chatgpt.response.ready');
});

test('không có author-role thì không đọc nhầm lượt của người dùng làm câu trả lời', async (t) => {
  const userPrompt = 'PROMPT CỦA NGƯỜI DÙNG đủ dài để vượt ngưỡng hai mươi ký tự';
  const answer = 'Đây là câu trả lời thật sự của ChatGPT, đủ dài để được chấp nhận.';
  const page = await testPage(t, `<!doctype html><main></main>
    <script>
      setTimeout(() => {
        document.querySelector('main').insertAdjacentHTML('beforeend', '<article data-testid="conversation-turn-1"><div class="whitespace-pre-wrap">${userPrompt}</div></article>');
      }, 50);
      setTimeout(() => {
        document.querySelector('main').insertAdjacentHTML('beforeend', '<article data-testid="conversation-turn-2"><div class="markdown">${answer}</div></article>');
      }, 400);
    </script>`);

  const result = await waitForChatGPTResponse(page, {
    timeoutMs: 3000,
    pollIntervalMs: 40,
    stablePolls: 3,
    logIntervalMs: 1000
  });

  assert.equal(result, answer);
  assert.notEqual(result, userPrompt);
});

test('timeout ghi rõ ChatGPT vẫn đang tạo thay vì lỗi selector', async (t) => {
  const page = await testPage(t, `<!doctype html>
    <button data-testid="stop-button" aria-label="Stop streaming">Stop</button>
    <div data-message-author-role="assistant"><div class="markdown result-streaming"></div></div>`);

  await assert.rejects(() => waitForChatGPTResponse(page, {
    timeoutMs: 200,
    pollIntervalMs: 30,
    stablePolls: 2,
    logIntervalMs: 1000
  }), /đã thấy phản hồi: true, ký tự: 0, vẫn đang tạo: true/);
});

test('báo lỗi ngay khi ChatGPT hiện thông báo chạm giới hạn thay vì coi đó là câu trả lời', async (t) => {
  const page = await testPage(t, `<!doctype html>
    <div data-message-author-role="assistant"><div class="markdown">You've reached our limit of messages per hour. Please try again later.</div></div>`);

  await assert.rejects(() => waitForChatGPTResponse(page, {
    timeoutMs: 2000,
    pollIntervalMs: 30,
    stablePolls: 2,
    logIntervalMs: 1000
  }), /ChatGPT báo lỗi thay vì trả lời: You've reached our limit/);
});

test('coi là chưa đăng nhập khi thấy nút Log in dù composer vẫn hiện (giống chatgpt.com thật)', async (t) => {
  // Dựng lại đúng DOM chatgpt.com khi chưa đăng nhập: có ô chat dùng được và nút Log in / Sign up for free.
  const page = await testPage(t, `<!doctype html>
    <header><button>Log in</button><button>Sign up for free</button></header>
    <textarea aria-label="Chat with ChatGPT" placeholder="Ask ChatGPT"></textarea>
    <button type="submit" aria-label="Send message"></button>`);

  await assert.rejects(() => assertChatGPTSignedIn(page, { timeoutMs: 1000 }), /Chưa đăng nhập ChatGPT/);
});

test('đã đăng nhập thì trả về ô nhập prompt', async (t) => {
  const page = await testPage(t, `<!doctype html>
    <div id="prompt-textarea" contenteditable="true"></div>
    <button data-testid="send-button" aria-label="Send prompt"></button>`);

  const box = await assertChatGPTSignedIn(page, { timeoutMs: 1000 });
  assert.equal(await box.getAttribute('id'), 'prompt-textarea');
});
