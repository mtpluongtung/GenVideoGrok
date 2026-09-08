import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { waitForGeminiResponse, waitForGeminiSendButton } from '../lib/gemini.js';

async function testPage(t, html) {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const address = server.address();
  await page.goto(`http://127.0.0.1:${address.port}`);
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });
  return page;
}

test('chờ nút gửi Gemini xuất hiện sau khi giao diện cold-start hydrate', async (t) => {
  const page = await testPage(t, `<!doctype html><body><textarea role="textbox"></textarea><script>
    setTimeout(() => {
      const button = document.createElement('button');
      button.setAttribute('aria-label', 'Gửi tin nhắn');
      document.body.append(button);
    }, 200);
  </script></body>`);
  const send = await waitForGeminiSendButton(page, 3000);
  assert.ok(send);
  assert.equal(await send.getAttribute('aria-label'), 'Gửi tin nhắn');
});

test('chờ Gemini qua trạng thái pending trước khi đọc response-container DOM mới', async (t) => {
  const expected = '{"schemaVersion":1,"globalContinuity":"consistent subject and lighting","parts":[]}';
  const page = await testPage(t, `<!doctype html>
    <button class="send-button stop" aria-label="Ngừng tạo câu trả lời">Stop</button>
    <script>
      setTimeout(() => {
        document.body.insertAdjacentHTML('beforeend', '<pending-response><response-container><thinking-dots-animation>...</thinking-dots-animation></response-container></pending-response>');
      }, 80);
      setTimeout(() => {
        const root = document.querySelector('response-container');
        root.innerHTML = '<message-content><div class="markdown-main-panel" aria-busy="false">${expected.replaceAll('"', '&quot;')}</div></message-content>';
        document.querySelector('.send-button').remove();
      }, 260);
    </script>`);
  const events = [];

  const result = await waitForGeminiResponse(page, {
    timeoutMs: 1500,
    pollIntervalMs: 40,
    stablePolls: 2,
    logIntervalMs: 100,
    log: async (event, details) => events.push({ event, details })
  });

  assert.equal(result, expected);
  assert.ok(events.some(({ event }) => event === 'gemini.response.detected'));
  assert.equal(events.at(-1).event, 'gemini.response.ready');
});

test('đọc được model-response cũ khi aria-busy không tồn tại', async (t) => {
  const expected = '{"summary":"A completed Gemini response with enough content."}';
  const page = await testPage(t, `<!doctype html><script>
    setTimeout(() => {
      document.body.insertAdjacentHTML('beforeend', '<model-response><div class="model-response-text"><div class="markdown-main-panel">${expected.replaceAll('"', '&quot;')}</div></div></model-response>');
    }, 80);
  </script>`);

  const result = await waitForGeminiResponse(page, {
    timeoutMs: 1000,
    pollIntervalMs: 30,
    stablePolls: 2,
    logIntervalMs: 1000
  });

  assert.equal(result, expected);
});

test('timeout Gemini ghi rõ vẫn đang tạo thay vì lỗi selector Playwright', async (t) => {
  const page = await testPage(t, `<!doctype html>
    <button class="send-button stop" aria-label="Stop response">Stop</button>
    <response-container><div class="gpi-static-text-loader">Loading</div></response-container>`);

  await assert.rejects(() => waitForGeminiResponse(page, {
    timeoutMs: 180,
    pollIntervalMs: 30,
    stablePolls: 2,
    logIntervalMs: 1000
  }), /đã thấy phản hồi: true, ký tự: 0, vẫn đang tạo: true/);
});
