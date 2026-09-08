import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { ensureVideoSettings, validateGrokVideoMetadata } from '../lib/grok.js';

test('Grok ưu tiên Video, 10s và 1080p khi 1080p khả dụng', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(async () => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <button role="radio" aria-label="Video" aria-checked="false" data-group="mode">Video</button>
    <button role="radio" aria-label="Image" aria-checked="true" data-group="mode">Image</button>
    <button role="radio" aria-checked="false" data-group="duration">6s</button>
    <button role="radio" aria-checked="true" data-group="duration">10s</button>
    <button role="radio" aria-checked="true" data-group="resolution">720p</button>
    <button role="radio" aria-checked="false" data-group="resolution">1080p</button>
    <button aria-label="Aspect Ratio" id="aspect">9:16</button>
    <button role="menuitem" id="aspect-option">16:9</button>
    <script>
      document.querySelectorAll('[role=radio]').forEach((button) => button.onclick = () => {
        document.querySelectorAll('[data-group="' + button.dataset.group + '"]').forEach((item) => item.setAttribute('aria-checked', 'false'));
        button.setAttribute('aria-checked', 'true');
      });
      document.querySelector('#aspect-option').onclick = () => {
        document.querySelector('#aspect').textContent = '16:9';
        document.querySelectorAll('[data-group="resolution"]').forEach((item) => item.setAttribute('aria-checked', item.textContent === '720p' ? 'true' : 'false'));
      };
    </script>
  `);
  const entries = [];
  await ensureVideoSettings(page, async (event, details) => entries.push({ event, details }), 'test', { timeoutMs: 1000, aspectRatio: '16:9' });
  assert.equal(await page.getByRole('radio', { name: 'Video' }).getAttribute('aria-checked'), 'true');
  assert.equal(await page.getByRole('radio', { name: '10s' }).getAttribute('aria-checked'), 'true');
  assert.equal(await page.getByRole('radio', { name: '1080p' }).getAttribute('aria-checked'), 'true');
  assert.equal((await page.getByRole('button', { name: 'Aspect Ratio' }).innerText()).trim(), '16:9');
  assert.equal(entries.at(-1).details.resolution, '1080p');
  assert.equal(entries.at(-1).details.aspectRatio, '16:9');
});

test('Grok xác nhận radio Video bằng accessible name dù không có aria-label cứng', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(async () => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <button role="radio" aria-checked="false" data-group="mode"><span>Video</span></button>
    <button role="radio" aria-checked="true" data-group="mode"><span>Image</span></button>
    <button role="radio" aria-checked="true" data-group="duration">10s</button>
    <button role="radio" aria-checked="true" data-group="resolution">1080p</button>
    <button aria-label="Aspect Ratio">9:16</button>
    <script>
      document.querySelectorAll('[role=radio]').forEach((button) => button.onclick = () => {
        document.querySelectorAll('[data-group="' + button.dataset.group + '"]').forEach((item) => item.setAttribute('aria-checked', 'false'));
        button.setAttribute('aria-checked', 'true');
      });
    </script>
  `);
  const entries = [];

  await ensureVideoSettings(page, async (event, details) => entries.push({ event, details }), 'accessible-name', {
    timeoutMs: 1000,
    aspectRatio: '9:16'
  });

  const video = page.getByRole('radio', { name: 'Video' });
  assert.equal(await video.getAttribute('aria-label'), null);
  assert.equal(await video.getAttribute('aria-checked'), 'true');
  assert.ok(entries.some(({ event }) => event === 'grok.settings.mode.selected'));
  assert.equal(entries.at(-1).event, 'grok.settings.verified');
});

test('Grok nhận diện nút tỷ lệ chỉ mang tên tỷ lệ thay vì aria-label Aspect Ratio', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(async () => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <button role="radio" aria-checked="true" data-group="mode">Video</button>
    <button role="radio" aria-checked="true" data-group="duration">10s</button>
    <button role="radio" aria-checked="true" data-group="resolution">1080p</button>
    <button id="aspect">9:16</button>
    <button role="menuitem" id="aspect-option">16:9</button>
    <script>
      document.querySelector('#aspect-option').onclick = () => {
        document.querySelector('#aspect').textContent = '16:9';
      };
    </script>
  `);
  const entries = [];

  await ensureVideoSettings(page, async (event, details) => entries.push({ event, details }), 'ratio-name', {
    timeoutMs: 1000,
    aspectRatio: '16:9'
  });

  assert.equal((await page.locator('#aspect').innerText()).trim(), '16:9');
  assert.equal(entries.at(-1).details.aspectRatio, '16:9');
});

test('Grok xác nhận lựa chọn bằng data-state khi radio không dùng aria-checked', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(async () => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <button role="radio" data-state="off" data-group="mode">Video</button>
    <button role="radio" data-state="on" data-group="mode">Image</button>
    <button role="radio" data-state="on" data-group="duration">10s</button>
    <button role="radio" data-state="on" data-group="resolution">1080p</button>
    <button aria-label="Aspect Ratio">9:16</button>
    <script>
      document.querySelectorAll('[role=radio]').forEach((button) => button.onclick = () => {
        document.querySelectorAll('[data-group="' + button.dataset.group + '"]').forEach((item) => item.dataset.state = 'off');
        button.dataset.state = 'on';
      });
    </script>
  `);
  const entries = [];

  await ensureVideoSettings(page, async (event, details) => entries.push({ event, details }), 'data-state', {
    timeoutMs: 1000,
    aspectRatio: '9:16'
  });

  assert.equal(await page.getByRole('radio', { name: 'Video' }).getAttribute('data-state'), 'on');
  assert.equal(entries.at(-1).event, 'grok.settings.verified');
});

test('Grok tự động chuyển sang 720p khi giao diện không có 1080p', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(async () => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <button role="radio" aria-label="Video" aria-checked="false" data-group="mode">Video</button>
    <button role="radio" aria-label="Image" aria-checked="true" data-group="mode">Image</button>
    <button role="radio" aria-checked="true" data-group="duration">10s</button>
    <button role="radio" aria-checked="false" data-group="resolution">720p</button>
    <button aria-label="Aspect Ratio">16:9</button>
    <script>
      document.querySelectorAll('[role=radio]').forEach((button) => button.onclick = () => {
        document.querySelectorAll('[data-group="' + button.dataset.group + '"]').forEach((item) => item.setAttribute('aria-checked', 'false'));
        button.setAttribute('aria-checked', 'true');
      });
    </script>
  `);
  const entries = [];

  await ensureVideoSettings(page, async (event, details) => entries.push({ event, details }), 'missing-1080', {
    timeoutMs: 1500,
    aspectRatio: '16:9'
  });

  assert.equal(await page.getByRole('radio', { name: '720p' }).getAttribute('aria-checked'), 'true');
  assert.ok(entries.some(({ event }) => event === 'grok.settings.resolution_fallback'));
  assert.equal(entries.at(-1).event, 'grok.settings.verified');
  assert.equal(entries.at(-1).details.resolution, '720p');
});

test('Grok dùng 720p khi lựa chọn 1080p hiện diện nhưng bị vô hiệu hóa', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(async () => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <button role="radio" aria-label="Video" aria-checked="true" data-group="mode">Video</button>
    <button role="radio" aria-checked="true" data-group="duration">10s</button>
    <button role="radio" aria-checked="false" data-group="resolution">720p</button>
    <button role="radio" aria-checked="false" data-group="resolution" disabled>1080p</button>
    <button aria-label="Aspect Ratio">16:9</button>
    <script>
      document.querySelectorAll('[role=radio]:not([disabled])').forEach((button) => button.onclick = () => {
        document.querySelectorAll('[data-group="' + button.dataset.group + '"]').forEach((item) => item.setAttribute('aria-checked', 'false'));
        button.setAttribute('aria-checked', 'true');
      });
    </script>
  `);
  const entries = [];

  await ensureVideoSettings(page, async (event, details) => entries.push({ event, details }), 'disabled-1080', {
    timeoutMs: 1500,
    aspectRatio: '16:9'
  });

  assert.equal(await page.getByRole('radio', { name: '720p' }).getAttribute('aria-checked'), 'true');
  const fallback = entries.find(({ event }) => event === 'grok.settings.resolution_fallback');
  assert.equal(fallback?.details.preferredResolution, '1080p');
  assert.equal(fallback?.details.resolution, '720p');
  assert.equal(entries.at(-1).details.resolution, '720p');
});

test('Grok đánh giá lại độ phân giải sau khi đổi tỷ lệ khung hình', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(async () => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <button role="radio" aria-label="Video" aria-checked="true" data-group="mode">Video</button>
    <button role="radio" aria-checked="true" data-group="duration">10s</button>
    <button role="radio" aria-checked="true" data-group="resolution">720p</button>
    <button role="radio" aria-checked="false" data-group="resolution" id="full-hd">1080p</button>
    <button aria-label="Aspect Ratio" id="aspect">9:16</button>
    <button role="menuitem" id="aspect-option">16:9</button>
    <script>
      document.querySelectorAll('[role=radio]').forEach((button) => button.onclick = () => {
        document.querySelectorAll('[data-group="' + button.dataset.group + '"]').forEach((item) => item.setAttribute('aria-checked', 'false'));
        button.setAttribute('aria-checked', 'true');
      });
      document.querySelector('#aspect-option').onclick = () => {
        document.querySelector('#aspect').textContent = '16:9';
        document.querySelector('#full-hd').remove();
        document.querySelector('[data-group=resolution]').setAttribute('aria-checked', 'false');
      };
    </script>
  `);
  const entries = [];

  await ensureVideoSettings(page, async (event, details) => entries.push({ event, details }), 'aspect-change', {
    timeoutMs: 1500,
    aspectRatio: '16:9'
  });

  assert.equal((await page.getByRole('button', { name: 'Aspect Ratio' }).innerText()).trim(), '16:9');
  assert.equal(await page.getByRole('radio', { name: '720p' }).getAttribute('aria-checked'), 'true');
  assert.equal(entries.at(-1).details.resolution, '720p');
});

test('metadata video khóa hành vi 1080p ưu tiên và 720p fallback của generateWithGrok', () => {
  const fullHd = validateGrokVideoMetadata(
    { width: 1904, height: 1072, duration: 10.04 },
    { selectedResolution: '1080p', aspectRatio: '16:9' }
  );
  assert.deepEqual(fullHd, {
    actualResolution: '1080p',
    resolutionFallback: false,
    resolutionAdjusted: false
  });

  const hdFallback = validateGrokVideoMetadata(
    { width: 1280, height: 720, duration: 10.04 },
    { selectedResolution: '720p', aspectRatio: '16:9' }
  );
  assert.deepEqual(hdFallback, {
    actualResolution: '720p',
    resolutionFallback: true,
    resolutionAdjusted: false
  });

  const providerDowngrade = validateGrokVideoMetadata(
    { width: 720, height: 1280, duration: 10 },
    { selectedResolution: '1080p', aspectRatio: '9:16' }
  );
  assert.equal(providerDowngrade.actualResolution, '720p');
  assert.equal(providerDowngrade.resolutionFallback, true);
  assert.equal(providerDowngrade.resolutionAdjusted, true);

  assert.throws(() => validateGrokVideoMetadata(
    { width: 854, height: 480, duration: 10 },
    { selectedResolution: '720p', aspectRatio: '16:9' }
  ), /thấp hơn.*720p/i);
});
