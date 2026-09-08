import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { JobCancelledError, cancelRequested, isCancellation, throwIfCancelled } from '../lib/cancel.js';
import { waitForGeminiResponse, abortGemini, generateStoryThumbnailWithGemini } from '../lib/gemini.js';
import { abortGrok } from '../lib/grok.js';
import { downloadYouTube } from '../lib/youtube.js';

test('phân biệt được lỗi hủy với lỗi thật', () => {
  assert.equal(isCancellation(new JobCancelledError()), true);
  assert.equal(isCancellation(new Error('Grok timeout')), false);
  assert.equal(isCancellation(null), false);
  assert.match(new JobCancelledError().message, /Đã hủy/);
  assert.equal(new JobCancelledError('Lý do riêng').message, 'Lý do riêng');
});

test('cancelRequested chỉ đúng khi callback trả về true', () => {
  assert.equal(cancelRequested(undefined), false);
  assert.equal(cancelRequested(null), false);
  assert.equal(cancelRequested(() => false), false);
  assert.equal(cancelRequested(() => true), true);
});

test('throwIfCancelled không ném khi chưa yêu cầu hủy', () => {
  assert.doesNotThrow(() => throwIfCancelled(() => false));
  assert.doesNotThrow(() => throwIfCancelled(undefined));
  assert.throws(() => throwIfCancelled(() => true, 'Đã hủy ở bước ghép.'), (error) => {
    assert.equal(isCancellation(error), true);
    assert.equal(error.message, 'Đã hủy ở bước ghép.');
    return true;
  });
});

test('abortGemini và abortGrok an toàn khi browser chưa chạy hoặc không có trang', async () => {
  await assert.doesNotReject(async () => {
    await abortGemini();
    await abortGrok();
  });
});

test('downloadYouTube ném JobCancelledError ngay nếu isCancelled là true', async () => {
  await assert.rejects(
    downloadYouTube('https://youtube.com/watch?v=mock', 'data/uploads/mock-cancel.mp4', () => {}, {
      isCancelled: () => true
    }),
    (error) => {
      assert.equal(isCancellation(error), true);
      assert.match(error.message, /Đã hủy/);
      return true;
    }
  );
});

test('generateStoryThumbnailWithGemini dừng ngay nếu isCancelled là true', async () => {
  await assert.rejects(
    generateStoryThumbnailWithGemini({ id: 'mock-job' }, { title: 'Test', content: 'Story' }, () => {}, {
      isCancelled: () => true
    }),
    (error) => {
      assert.equal(isCancellation(error), true);
      return true;
    }
  );
});

test('vòng chờ Gemini thoát ngay khi có yêu cầu hủy thay vì chờ hết timeout', async (t) => {
  // Trang luôn ở trạng thái đang tạo, nên nếu không có cờ hủy thì sẽ chờ tới hết timeoutMs.
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`
      <response-container aria-busy="true">
        <message-content><div class="markdown-main-panel">Đang soạn…</div></message-content>
      </response-container>
      <button aria-label="Stop generating">Dừng</button>
    `);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);

  let cancelled = false;
  setTimeout(() => { cancelled = true; }, 300);
  const startedAt = Date.now();

  await assert.rejects(
    waitForGeminiResponse(page, {
      timeoutMs: 60000,
      pollIntervalMs: 100,
      isCancelled: () => cancelled
    }),
    (error) => {
      assert.equal(isCancellation(error), true);
      assert.match(error.message, /Đã hủy trong lúc chờ Gemini/);
      return true;
    }
  );

  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 10000, `Phải thoát ngay sau khi hủy, nhưng mất ${elapsed}ms`);
});
