import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

async function appPage(t, { width = 1100, height = 900, jobs = [], config = null } = {}) {
  const publicDirectory = path.resolve('public');
  const server = http.createServer(async (request, response) => {
    const json = (payload) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(payload));
    };
    if (request.url === '/api/jobs') { json(jobs); return; }
    if (request.url === '/api/config') {
      json({ clipSeconds: 10, maxParts: 30, maxReferenceImages: 3, ...(config || {}) });
      return;
    }
    const filename = request.url === '/' ? 'index.html' : request.url.slice(1);
    const file = path.join(publicDirectory, filename);
    const extension = path.extname(file);
    const body = await fs.readFile(file).catch(() => null);
    if (!body) { response.statusCode = 404; response.end('not found'); return; }
    response.setHeader('content-type', extension === '.js' ? 'text/javascript' : extension === '.css' ? 'text/css' : 'text/html');
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width, height } });
  const address = server.address();
  await page.goto(`http://127.0.0.1:${address.port}`);
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });
  return page;
}

test('form nhớ riêng thời lượng và ngôn ngữ khi chuyển chế độ', async (t) => {
  const page = await appPage(t);
  const mode = page.locator('[name=durationMode]');
  const seconds = page.locator('[name=durationSeconds]');
  const language = page.locator('[name=language]');

  assert.equal(await mode.inputValue(), 'custom');
  assert.equal(await seconds.inputValue(), '10');
  assert.equal(await seconds.isEnabled(), true);
  await seconds.fill('30');
  await language.selectOption('vi');
  assert.match(await page.locator('#durationHelp').innerText(), /3 part × 10 giây/);

  await page.getByRole('button', { name: 'Video gốc' }).click();
  assert.equal(await mode.inputValue(), 'auto');
  assert.equal(await seconds.isEnabled(), false);
  assert.equal(await language.locator('option[value=auto]').innerText(), 'Giữ ngôn ngữ video gốc');

  await page.getByRole('button', { name: 'Chủ đề' }).click();
  assert.equal(await mode.inputValue(), 'custom');
  assert.equal(await seconds.inputValue(), '30');
  assert.equal(await language.inputValue(), 'vi');
});

test('chế độ Chủ đề cho phép để trống để ChatGPT tự tìm xu hướng', async (t) => {
  const page = await appPage(t);
  const prompt = page.locator('[name=prompt]');

  assert.equal(await prompt.getAttribute('required'), null);
  assert.equal(await prompt.evaluate((element) => element.checkValidity()), true);
  assert.match(await prompt.getAttribute('placeholder'), /để trống.*ChatGPT.*xu hướng/i);
  assert.match(await page.locator('#workflowNote').innerText(), /để trống.*ChatGPT.*xu hướng/i);

  await page.getByRole('button', { name: 'Video gốc' }).click();
  await page.getByRole('button', { name: 'Chủ đề' }).click();
  assert.equal(await prompt.getAttribute('required'), null);
});

test('nội dung prompt được nhớ riêng, không rò từ Video sang Chủ đề trống', async (t) => {
  const page = await appPage(t);
  const prompt = page.locator('[name=prompt]');

  await page.getByRole('button', { name: 'Video gốc' }).click();
  await prompt.fill('Chỉ dẫn riêng cho video nguồn');
  await page.getByRole('button', { name: 'Chủ đề' }).click();
  assert.equal(await prompt.inputValue(), '');
  assert.match(await page.locator('#workflowNote').innerText(), /ChatGPT.*xu hướng/i);

  await prompt.fill('Chủ đề do người dùng nhập');
  await page.getByRole('button', { name: 'Video gốc' }).click();
  assert.equal(await prompt.inputValue(), 'Chỉ dẫn riêng cho video nguồn');
  await page.getByRole('button', { name: 'Chủ đề' }).click();
  assert.equal(await prompt.inputValue(), 'Chủ đề do người dùng nhập');
});

test('form tùy chọn không gây tràn ngang trên màn hình di động', async (t) => {
  const page = await appPage(t, { width: 375, height: 812 });
  const dimensions = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(dimensions.scrollWidth <= dimensions.width, `Trang rộng ${dimensions.scrollWidth}px trên viewport ${dimensions.width}px`);
  const columns = await page.locator('.options-grid').evaluate((element) => getComputedStyle(element).gridTemplateColumns);
  assert.match(columns, /^\d+(?:\.\d+)?px$/, `Cần đúng một cột, nhận được: ${columns}`);
});

test('giao diện công bố chính sách ưu tiên 1080p và fallback 720p', async (t) => {
  const page = await appPage(t);
  assert.match(await page.locator('#workflowNote').innerText(), /1080p.*720p/i);

  await page.getByRole('button', { name: 'Video gốc' }).click();
  assert.match(await page.locator('#workflowNote').innerText(), /1080p.*720p/i);
});

test('tùy chọn viết câu chuyện chỉ hoạt động ở chế độ Video gốc và được nhớ riêng', async (t) => {
  const page = await appPage(t);
  const storyField = page.locator('#storyField');
  const writeStory = page.locator('[name=writeStory]');

  assert.equal(await storyField.isHidden(), true);
  assert.equal(await writeStory.isDisabled(), true);

  await page.getByRole('button', { name: 'Video gốc' }).click();
  assert.equal(await storyField.isVisible(), true);
  assert.equal(await writeStory.isEnabled(), true);
  await writeStory.check();
  assert.match(await page.locator('#workflowNote').innerText(), /câu chuyện.*\.txt/i);

  await page.getByRole('button', { name: 'YouTube' }).click();
  assert.equal(await storyField.isHidden(), true);
  assert.equal(await writeStory.isDisabled(), true);
  assert.equal(await writeStory.isChecked(), false);

  await page.getByRole('button', { name: 'Video gốc' }).click();
  assert.equal(await writeStory.isChecked(), true);
});

test('ảnh tham chiếu tự động bật sẵn và mô tả khác nhau giữa Chủ đề và Video gốc', async (t) => {
  const page = await appPage(t);
  const useReferenceFrames = page.locator('[name=useReferenceFrames]');

  assert.equal(await useReferenceFrames.isChecked(), true);
  assert.match(await page.locator('#referenceHelp').innerText(), /chỉ gửi frame cuối của đoạn trước/i);
  assert.match(await page.locator('#workflowNote').innerText(), /Nối frame cuối đoạn trước/i);

  await page.getByRole('button', { name: 'Video gốc' }).click();
  assert.match(await page.locator('#referenceHelp').innerText(), /frame cắt từ video nguồn/i);
  assert.match(await page.locator('#workflowNote').innerText(), /Frame nguồn \+ nối đoạn trước/i);

  await useReferenceFrames.uncheck();
  assert.doesNotMatch(await page.locator('#workflowNote').innerText(), /Frame nguồn/i);

  // Nhớ riêng theo từng chế độ, giống thời lượng và tùy chọn câu chuyện.
  await page.getByRole('button', { name: 'Chủ đề' }).click();
  assert.equal(await useReferenceFrames.isChecked(), true);

  await page.getByRole('button', { name: 'Video gốc' }).click();
  assert.equal(await useReferenceFrames.isChecked(), false);
});

test('thẻ tác vụ hiển thị số ảnh tham chiếu người dùng đã gửi', async (t) => {
  const page = await appPage(t, { jobs: [{
    id: 'reference-job',
    type: 'upload',
    prompt: 'Giữ nguyên nhân vật chính',
    durationMode: 'auto',
    sourceDuration: 20,
    languageLabel: 'Theo ngôn ngữ nguồn',
    useReferenceFrames: true,
    referenceImageCount: 2,
    status: 'running',
    message: 'Đoạn 2/2: Grok đang tạo video…'
  }] });

  const meta = await page.locator('.job .meta').innerText();
  assert.match(meta, /Ảnh tham chiếu tự động/);
  assert.match(meta, /2 ảnh của bạn/);
});

test('thẻ tác vụ có liên kết tải file câu chuyện khi backend trả storyUrl', async (t) => {
  const page = await appPage(t, { jobs: [{
    id: 'story-job',
    type: 'upload',
    prompt: '',
    durationMode: 'auto',
    sourceDuration: 12,
    languageLabel: 'Theo ngôn ngữ nguồn',
    writeStory: true,
    storyTitle: 'Chuyến đi trong mưa',
    storyUrl: '/outputs/story-job-story.txt',
    status: 'done',
    message: 'Hoàn tất',
    segmentCount: 2,
    outputDuration: 20,
    outputResolution: '1080p',
    outputUrl: '/outputs/story-job.mp4',
    logUrl: '/logs/story-job.log'
  }] });

  const card = page.locator('article.job').first();
  await card.waitFor();
  assert.match(await card.innerText(), /Viết thêm câu chuyện/i);
  const storyLink = card.getByRole('link', { name: /Tải câu chuyện/i });
  assert.equal(await storyLink.getAttribute('href'), '/outputs/story-job-story.txt');
  assert.notEqual(await storyLink.getAttribute('download'), null);
});

test('thẻ tác vụ hiển thị độ phân giải thực tế của video fallback', async (t) => {
  const page = await appPage(t, { jobs: [{
    id: 'fallback-job',
    type: 'topic',
    prompt: 'Nội dung kiểm thử',
    durationMode: 'custom',
    targetDuration: 10,
    languageLabel: 'Tiếng Việt',
    status: 'done',
    message: 'Hoàn tất',
    segmentCount: 1,
    outputDuration: 10.04,
    outputResolution: '720p',
    outputUrl: '/outputs/fallback-job.mp4',
    logUrl: '/logs/fallback-job.log'
  }] });

  const card = page.locator('article.job').first();
  await card.waitFor();
  assert.match(await card.innerText(), /720p/i);
});

test('ô đăng Reels chỉ hiện khi server đã cấu hình Facebook Page', async (t) => {
  const hidden = await appPage(t, { config: { facebookConfigured: false } });
  assert.equal(await hidden.locator('#reelsField').isHidden(), true);
  assert.equal(await hidden.locator('[name=postToReels]').isChecked(), false);

  const shown = await appPage(t, { config: { facebookConfigured: true } });
  const checkbox = shown.locator('[name=postToReels]');
  assert.equal(await shown.locator('#reelsField').isVisible(), true);
  assert.equal(await checkbox.isChecked(), false, 'mặc định phải tắt vì đăng công khai không hoàn tác được');

  await checkbox.check();
  assert.match(await shown.locator('#workflowNote').innerText(), /Tự đăng Facebook Reels \(9:16, ≤ 90s\)/);
});

test('thẻ tác vụ hiện trạng thái Reels và liên kết bài đã đăng', async (t) => {
  const page = await appPage(t, { jobs: [
    {
      id: 'reel-ok', type: 'topic', prompt: 'Chuyện chú chó', durationMode: 'custom', targetDuration: 60,
      clipSeconds: 15, languageLabel: 'Tiếng Việt', status: 'done', message: 'Hoàn tất · Đã đăng Reels',
      postToReels: true, reelStatus: 'published', reelUrl: 'https://www.facebook.com/reel/123',
      outputUrl: '/outputs/reel-ok.mp4'
    },
    {
      id: 'reel-bad', type: 'topic', prompt: 'Video ngang', durationMode: 'custom', targetDuration: 60,
      clipSeconds: 15, languageLabel: 'Tiếng Việt', status: 'done', message: 'Hoàn tất · Không hợp lệ cho Reels',
      postToReels: true, reelStatus: 'rejected', reelError: 'Facebook Reels chỉ nhận tỷ lệ 9:16; video này là 1920x1080.'
    }
  ] });

  const cards = page.locator('.job');
  assert.match(await cards.nth(0).innerText(), /Đã đăng Reels/);
  assert.equal(await cards.nth(0).getByRole('link', { name: /Xem Reels/ }).getAttribute('href'), 'https://www.facebook.com/reel/123');

  const rejected = await cards.nth(1).innerText();
  assert.match(rejected, /Không hợp lệ cho Reels/);
  assert.match(rejected, /chỉ nhận tỷ lệ 9:16/);
  assert.equal(await cards.nth(1).getByRole('link', { name: /Xem Reels/ }).count(), 0);
});

test('nút Hủy chỉ hiện khi đang chờ hoặc đang chạy', async (t) => {
  const page = await appPage(t, { jobs: [
    { id: 'j-run', type: 'topic', prompt: 'Đang chạy', durationMode: 'custom', targetDuration: 60, clipSeconds: 15,
      languageLabel: 'Tiếng Việt', status: 'running', message: 'Đoạn 2/4: Grok đang tạo video…' },
    { id: 'j-queue', type: 'topic', prompt: 'Đang chờ', durationMode: 'custom', targetDuration: 60, clipSeconds: 15,
      languageLabel: 'Tiếng Việt', status: 'queued', message: 'Đang chờ' },
    { id: 'j-done', type: 'topic', prompt: 'Xong', durationMode: 'custom', targetDuration: 60, clipSeconds: 15,
      languageLabel: 'Tiếng Việt', status: 'done', message: 'Hoàn tất', outputUrl: '/outputs/j-done.mp4' }
  ] });

  const cards = page.locator('.job');
  assert.equal(await cards.nth(0).locator('[data-cancel]').count(), 1);
  assert.equal(await cards.nth(1).locator('[data-cancel]').count(), 1);
  assert.equal(await cards.nth(2).locator('[data-cancel]').count(), 0, 'Tác vụ đã xong thì không còn gì để hủy');
  assert.match(await cards.nth(0).locator('[data-cancel]').innerText(), /Hủy/);
});

test('nút Hủy chuyển sang Đang hủy và bị khóa sau khi bấm', async (t) => {
  const page = await appPage(t, { jobs: [
    { id: 'j-cancelling', type: 'topic', prompt: 'Đang hủy', durationMode: 'custom', targetDuration: 60, clipSeconds: 15,
      languageLabel: 'Tiếng Việt', status: 'running', message: 'Đang hủy…', cancelRequested: true }
  ] });

  const button = page.locator('[data-cancel]');
  assert.match(await button.innerText(), /Đang hủy/);
  assert.equal(await button.isDisabled(), true, 'Không cho bấm hủy hai lần');
});

test('tác vụ đã hủy có nhãn riêng, cho Thử lại và Tạo lại video', async (t) => {
  const page = await appPage(t, { jobs: [
    { id: 'j-cancelled', type: 'topic', prompt: 'Đã hủy giữa chừng', durationMode: 'custom', targetDuration: 60,
      clipSeconds: 15, languageLabel: 'Tiếng Việt', status: 'cancelled', message: 'Đã hủy' }
  ] });

  const card = page.locator('.job').first();
  assert.match(await card.innerText(), /Đã hủy/);
  assert.equal(await card.locator('[data-retry]').count(), 1);
  assert.equal(await card.locator('[data-rerun]').count(), 1);
  assert.equal(await card.locator('[data-cancel]').count(), 0);
});

test('nút Tạo lại video nói rõ là giữ kịch bản và chỉ dựng lại video', async (t) => {
  const page = await appPage(t, { jobs: [
    { id: 'j-done2', type: 'topic', prompt: 'Xong rồi', durationMode: 'custom', targetDuration: 60, clipSeconds: 15,
      languageLabel: 'Tiếng Việt', status: 'done', message: 'Hoàn tất', outputUrl: '/outputs/j-done2.mp4' }
  ] });

  const rerun = page.locator('[data-rerun]');
  assert.match(await rerun.innerText(), /Tạo lại video/);
  assert.match(await rerun.getAttribute('title'), /Giữ kịch bản ChatGPT.*dựng lại video/);
});

test('tùy chọn độ dài clip Grok cập nhật bước nhảy và gợi ý thời lượng', async (t) => {
  const page = await appPage(t);
  const clipSelect = page.locator('[name=clipSeconds]');
  const secondsInput = page.locator('[name=durationSeconds]');
  const help = page.locator('#durationHelp');

  assert.equal(await clipSelect.inputValue(), '10');
  await clipSelect.selectOption('5');
  assert.equal(await secondsInput.getAttribute('step'), '5');
  assert.equal(await secondsInput.getAttribute('min'), '5');
  await secondsInput.fill('15');
  assert.match(await help.innerText(), /3 part × 5 giây/);

  await clipSelect.selectOption('15');
  assert.equal(await secondsInput.getAttribute('step'), '15');
  assert.equal(await secondsInput.getAttribute('min'), '15');
  assert.match(await help.innerText(), /15 giây/);
});

test('nút chọn nhanh thời lượng đặt thời lượng tùy chỉnh 10s', async (t) => {
  const page = await appPage(t);
  await page.getByRole('button', { name: 'Video gốc' }).click();
  const mode = page.locator('[name=durationMode]');
  const seconds = page.locator('[name=durationSeconds]');

  assert.equal(await mode.inputValue(), 'auto');
  assert.equal(await seconds.isEnabled(), false);

  await page.locator('.quick-duration-btn[data-seconds="10"]').click();
  assert.equal(await mode.inputValue(), 'custom');
  assert.equal(await seconds.inputValue(), '10');
  assert.equal(await seconds.isEnabled(), true);
  assert.match(await page.locator('#durationHelp').innerText(), /1 part × 10 giây/);
});


