import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { ensureVideoSettings } from '../lib/grok.js';

// Dựng lại giao diện Grok mới lấy từ data/logs/<job>-error.html: thời lượng và độ phân giải
// không còn là radio mà là nút mở menu, và option tỷ lệ có hậu tố mô tả ("16:9 Widescreen").
function composer({ duration = '15s', resolution = '1080p', aspect = '2:3', durations = ['6s', '10s', '15s'], resolutions = ['480p', '720p', '1080p'] } = {}) {
  const items = (values) => values.map((value) => `<div role="menuitemradio" aria-checked="false">${value}</div>`).join('');
  return `
    <div role="radiogroup" aria-label="Generation mode">
      <button role="radio" aria-label="Image" aria-checked="false">Image</button>
      <button role="radio" aria-label="Video" aria-checked="true">Video</button>
      <button role="radio" aria-label="Agent" aria-checked="false">Agent</button>
    </div>
    <button type="button" aria-label="Video duration" data-menu="durationMenu">${duration}</button>
    <button type="button" aria-label="Video resolution" data-menu="resolutionMenu">${resolution}</button>
    <button type="button" aria-label="Aspect Ratio" data-menu="aspectMenu">${aspect}</button>
    <div id="durationMenu" role="menu" hidden>${items(durations)}</div>
    <div id="resolutionMenu" role="menu" hidden>${items(resolutions)}</div>
    <div id="aspectMenu" role="menu" hidden>${items(['Auto', '2:3 Tall', '3:2 Wide', '1:1 Square', '9:16 Vertical', '16:9 Widescreen'])}</div>
    <script>
      const closeAll = () => document.querySelectorAll('[role=menu]').forEach((menu) => { menu.hidden = true; });
      document.querySelectorAll('button[data-menu]').forEach((trigger) => {
        trigger.onclick = () => {
          const menu = document.getElementById(trigger.dataset.menu);
          const wasOpen = !menu.hidden;
          closeAll();
          menu.hidden = wasOpen;
          if (menu.hidden) return;
          menu.querySelectorAll('[role=menuitemradio]').forEach((option) => {
            option.onclick = () => {
              menu.querySelectorAll('[role=menuitemradio]').forEach((item) => item.setAttribute('aria-checked', 'false'));
              option.setAttribute('aria-checked', 'true');
              // Nút chỉ hiển thị token đầu, giống Grok thật ("16:9 Widescreen" -> "16:9").
              trigger.textContent = option.textContent.trim().split(' ')[0];
              closeAll();
            };
          });
        };
      });
      document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeAll(); });
    </script>
  `;
}

async function openComposer(t, html) {
  const browser = await chromium.launch({ headless: true });
  t.after(async () => browser.close());
  const page = await browser.newPage();
  await page.setContent(html);
  return page;
}

test('giao diện menu mới: chọn được 10s dù Grok đang mặc định 15s', async (t) => {
  const page = await openComposer(t, composer({ duration: '15s' }));
  const entries = [];
  const settings = await ensureVideoSettings(page, async (event, details) => entries.push({ event, details }), 'test', { timeoutMs: 3000 });

  assert.equal((await page.getByRole('button', { name: 'Video duration' }).innerText()).trim(), '10s');
  assert.equal(settings.seconds, 10);
  const durationEvent = entries.find((entry) => entry.event === 'grok.settings.duration.selected');
  assert.equal(durationEvent.details.control, 'menu');
  assert.equal(durationEvent.details.previous, '15s');
});

test('giao diện menu mới: khớp option tỷ lệ có hậu tố mô tả', async (t) => {
  const page = await openComposer(t, composer({ aspect: '2:3' }));
  const settings = await ensureVideoSettings(page, async () => {}, 'test', { timeoutMs: 3000, aspectRatio: '16:9' });

  assert.equal((await page.getByRole('button', { name: 'Aspect Ratio' }).innerText()).trim(), '16:9');
  assert.equal(settings.aspectRatio, '16:9');
  // Đổi tỷ lệ xong vẫn phải giữ 10s và 1080p.
  assert.equal((await page.getByRole('button', { name: 'Video duration' }).innerText()).trim(), '10s');
  assert.equal(settings.resolution, '1080p');
});

test('giao diện menu mới: fallback 720p khi menu không có 1080p', async (t) => {
  const page = await openComposer(t, composer({ resolution: '480p', resolutions: ['480p', '720p'] }));
  const entries = [];
  const settings = await ensureVideoSettings(page, async (event, details) => entries.push({ event, details }), 'test', { timeoutMs: 3000 });

  assert.equal(settings.resolution, '720p');
  assert.equal(settings.resolutionFallback, true);
  const fallback = entries.find((entry) => entry.event === 'grok.settings.resolution_fallback');
  assert.equal(fallback.details.reason, '1080_unavailable');
  assert.deepEqual(fallback.details.available, ['480p', '720p']);
});

test('giao diện menu mới: báo lỗi rõ ràng khi Grok bỏ hẳn tùy chọn 10 giây', async (t) => {
  const page = await openComposer(t, composer({ duration: '15s', durations: ['15s', '25s'] }));
  await assert.rejects(
    ensureVideoSettings(page, async () => {}, 'test', { timeoutMs: 2000 }),
    (error) => {
      assert.match(error.message, /không có tùy chọn video 10 giây/i);
      assert.match(error.message, /đang là 15s/);
      assert.match(error.message, /15s, 25s/);
      return true;
    }
  );
});

test('giao diện menu mới: không click lại khi thời lượng đã đúng 10s', async (t) => {
  const page = await openComposer(t, composer({ duration: '10s' }));
  const entries = [];
  await ensureVideoSettings(page, async (event, details) => entries.push({ event, details }), 'test', { timeoutMs: 3000 });

  const durationEvents = entries.filter((entry) => entry.event === 'grok.settings.duration.selected');
  assert.ok(durationEvents.length >= 1);
  assert.equal(durationEvents.every((entry) => entry.details.changed === false), true);
});

test('chọn đúng 15s khi kế hoạch được chia theo clip 15 giây', async (t) => {
  const page = await openComposer(t, composer({ duration: '5s', durations: ['5s', '10s', '15s'] }));
  const entries = [];
  const settings = await ensureVideoSettings(page, async (event, details) => entries.push({ event, details }), 'test', {
    timeoutMs: 3000, clipSeconds: 15
  });

  assert.equal((await page.getByRole('button', { name: 'Video duration' }).innerText()).trim(), '15s');
  assert.equal(settings.seconds, 15);
  const durationEvent = entries.find((entry) => entry.event === 'grok.settings.duration.selected');
  assert.equal(durationEvent.details.previous, '5s');
});

test('đổi tỷ lệ khung hình xong vẫn giữ lại 15s và 1080p', async (t) => {
  const page = await openComposer(t, composer({ duration: '5s', aspect: '2:3' }));
  const settings = await ensureVideoSettings(page, async () => {}, 'test', {
    timeoutMs: 3000, aspectRatio: '16:9', clipSeconds: 15
  });

  assert.equal((await page.getByRole('button', { name: 'Video duration' }).innerText()).trim(), '15s');
  assert.equal((await page.getByRole('button', { name: 'Aspect Ratio' }).innerText()).trim(), '16:9');
  assert.equal(settings.seconds, 15);
  assert.equal(settings.resolution, '1080p');
});

test('kế hoạch 15 giây báo lỗi khi Grok chỉ còn 5s và 10s', async (t) => {
  const page = await openComposer(t, composer({ duration: '10s', durations: ['5s', '10s'] }));
  await assert.rejects(
    ensureVideoSettings(page, async () => {}, 'test', { timeoutMs: 2000, clipSeconds: 15 }),
    (error) => {
      assert.match(error.message, /không có tùy chọn video 15 giây/i);
      assert.match(error.message, /5s, 10s/);
      assert.match(error.message, /GROK_CLIP_SECONDS/);
      return true;
    }
  );
});
