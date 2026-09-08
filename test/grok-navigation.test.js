import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { openGrokImaginePage } from '../lib/grok.js';

const composer = `<!doctype html><button role="radio" aria-label="Video" aria-checked="true">Video</button>`;

async function testServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}/imagine` };
}

test('tái sử dụng trang Grok đã sẵn sàng thay vì goto lại cho part kế tiếp', async (t) => {
  let requests = 0;
  const { server, url } = await testServer((_req, res) => { requests += 1; res.end(composer); });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  t.after(async () => { await browser.close(); await new Promise((resolve) => server.close(resolve)); });
  await page.goto(url);
  const events = [];

  const result = await openGrokImaginePage(context, page, async (event, details) => events.push({ event, details }), {
    url, reuseTimeoutMs: 500, readyTimeoutMs: 500, navigationTimeoutMs: 1000
  });

  assert.equal(result, page);
  assert.equal(requests, 1, 'Không được tải lại URL khi composer đã sẵn sàng');
  assert.equal(events.at(-1).event, 'grok.page.reused');
});

test('mở tab dự phòng khi trang Grok tải xong nhưng shell bị trắng', async (t) => {
  let requests = 0;
  const { server, url } = await testServer((_req, res) => {
    requests += 1;
    res.end(requests === 1 ? '<!doctype html><body></body>' : composer);
  });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const firstPage = await context.newPage();
  const events = [];
  t.after(async () => { await browser.close(); await new Promise((resolve) => server.close(resolve)); });

  const result = await openGrokImaginePage(context, firstPage, async (event, details) => events.push({ event, details }), {
    url, attempts: 2, reuseTimeoutMs: 50, readyTimeoutMs: 100, navigationTimeoutMs: 1000
  });

  assert.notEqual(result, firstPage);
  assert.equal(requests, 2);
  assert.ok(events.some(({ event }) => event === 'grok.page.fallback_created'));
  assert.equal(events.at(-1).event, 'grok.page.ready');
});
