import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  REEL_LIMITS,
  buildReelDescription,
  facebookConfig,
  facebookConfigured,
  publishReel,
  redactFacebookSecrets,
  reelRejectionReason
} from '../lib/facebook.js';

const config = { pageId: '123456', accessToken: 'SECRET-TOKEN-abc', graphVersion: 'v25.0', hashtags: '' };

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, text: async () => JSON.stringify(body) };
}

/** Ghi lại mọi request để kiểm tra đúng 3 pha và token không lọt vào URL. */
function fakeFetch(handlers) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', headers: options.headers || {}, body: options.body });
    for (const [pattern, handler] of handlers) {
      if (pattern.test(url)) return handler(calls.length);
    }
    throw new Error(`Không có handler cho ${url}`);
  };
  impl.calls = calls;
  return impl;
}

async function tempVideo(t, bytes = 4096) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fb-reel-'));
  const file = path.join(root, 'output.mp4');
  await fs.writeFile(file, crypto.randomBytes(bytes));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return file;
}

test('đọc cấu hình Facebook từ biến môi trường', () => {
  const parsed = facebookConfig({ FACEBOOK_PAGE_ID: ' 42 ', FACEBOOK_PAGE_ACCESS_TOKEN: ' tok ' });
  assert.equal(parsed.pageId, '42');
  assert.equal(parsed.accessToken, 'tok');
  assert.equal(parsed.graphVersion, 'v25.0');
  assert.equal(facebookConfigured(parsed), true);
  assert.equal(facebookConfigured(facebookConfig({ FACEBOOK_PAGE_ID: '42' })), false);
});

test('token bị che trong mọi chuỗi lỗi và log', () => {
  const leaked = `Failed https://graph.facebook.com/v25.0/me?access_token=${config.accessToken} with OAuth ${config.accessToken}`;
  const safe = redactFacebookSecrets(leaked, config);
  assert.ok(!safe.includes(config.accessToken), `Token vẫn còn trong: ${safe}`);
  assert.match(safe, /access_token=\[redacted\]/);
});

test('từ chối video sai chuẩn Reels trước khi tải lên', () => {
  assert.equal(reelRejectionReason({ duration: 60, width: 1080, height: 1920 }), null);
  assert.match(reelRejectionReason({ duration: 60, width: 1920, height: 1080 }), /chỉ nhận tỷ lệ 9:16/);
  assert.match(reelRejectionReason({ duration: 120, width: 1080, height: 1920 }), /tối đa 90 giây/);
  assert.match(reelRejectionReason({ duration: 2, width: 1080, height: 1920 }), /ít nhất 3 giây/);
  assert.match(reelRejectionReason({ duration: 30, width: 360, height: 640 }), /tối thiểu 540x960/);
  assert.match(reelRejectionReason({ duration: 30 }), /Không đọc được kích thước/);
  assert.equal(REEL_LIMITS.maxSeconds, 90);
});

test('caption ưu tiên chủ đề ChatGPT rồi tới tiêu đề truyện và prompt', () => {
  assert.equal(buildReelDescription({ generatedTopic: 'Chủ đề nóng', prompt: 'bỏ qua' }, config), 'Chủ đề nóng');
  assert.equal(buildReelDescription({ storyTitle: 'Tiêu đề truyện' }, config), 'Tiêu đề truyện');
  assert.equal(buildReelDescription({ prompt: 'Prompt tự nhập' }, config), 'Prompt tự nhập');
  assert.equal(buildReelDescription({}, config), 'Video mới');
  assert.equal(
    buildReelDescription({ generatedTopic: 'Chủ đề' }, { ...config, hashtags: '#viral' }),
    'Chủ đề\n\n#viral'
  );
  assert.ok(buildReelDescription({ prompt: 'x'.repeat(3000) }, config).length <= 2200);
});

test('đăng Reels chạy đủ ba pha và không đưa token vào URL', async (t) => {
  const file = await tempVideo(t, 2048);
  const impl = fakeFetch([
    [/video_reels$/, () => jsonResponse({ video_id: 'v-1', upload_url: 'https://rupload.facebook.com/x' })],
    [/rupload\.facebook\.com/, () => jsonResponse({ success: true })],
    [/\/v-1\?fields=status/, () => jsonResponse({ status: { video_status: 'ready', publishing_phase: { publish_status: 'published' } } })]
  ]);

  const result = await publishReel({ filePath: file, description: 'Xin chào', config, fetchImpl: impl, pollIntervalMs: 1 });

  assert.equal(result.videoId, 'v-1');
  assert.equal(result.permalink, 'https://www.facebook.com/reel/v-1');

  const [start, upload, finish] = impl.calls;
  assert.match(start.url, /\/123456\/video_reels$/);
  assert.equal(JSON.parse(start.body).upload_phase, 'start');
  assert.equal(start.headers.Authorization, `Bearer ${config.accessToken}`);

  assert.match(upload.url, /rupload\.facebook\.com\/video-upload\/v25\.0\/v-1$/);
  assert.equal(upload.headers.Authorization, `OAuth ${config.accessToken}`);
  assert.equal(upload.headers.file_size, '2048');

  const finishBody = JSON.parse(finish.body);
  assert.equal(finishBody.upload_phase, 'finish');
  assert.equal(finishBody.video_state, 'PUBLISHED');
  assert.equal(finishBody.description, 'Xin chào');

  for (const call of impl.calls) {
    assert.ok(!call.url.includes(config.accessToken), `Token lọt vào URL: ${call.url}`);
  }
});

test('thử lại khi tải lên hỏng rồi vẫn đăng được', async (t) => {
  const file = await tempVideo(t);
  let uploadAttempts = 0;
  const impl = fakeFetch([
    [/video_reels$/, () => jsonResponse({ video_id: 'v-2' })],
    [/rupload/, () => {
      uploadAttempts += 1;
      if (uploadAttempts < 2) return jsonResponse({ error: { message: 'tạm thời lỗi mạng' } }, { ok: false, status: 500 });
      return jsonResponse({ success: true });
    }],
    [/fields=status/, () => jsonResponse({ status: { publishing_phase: { publish_status: 'published' } } })]
  ]);

  const result = await publishReel({ filePath: file, description: 'x', config, fetchImpl: impl, pollIntervalMs: 1 });
  assert.equal(uploadAttempts, 2);
  assert.equal(result.videoId, 'v-2');
});

test('lỗi Graph API được nêu lại nguyên văn nhưng đã che token', async (t) => {
  const file = await tempVideo(t);
  const impl = fakeFetch([
    [/video_reels$/, () => jsonResponse(
      { error: { message: `Invalid OAuth ${config.accessToken} for page` } },
      { ok: false, status: 400 }
    )]
  ]);

  await assert.rejects(
    publishReel({ filePath: file, description: 'x', config, fetchImpl: impl, pollIntervalMs: 1 }),
    (error) => {
      assert.ok(!error.message.includes(config.accessToken), `Token lọt vào lỗi: ${error.message}`);
      assert.match(error.message, /Invalid OAuth/);
      return true;
    }
  );
});

test('Facebook báo lỗi xử lý thì dừng và nêu lý do', async (t) => {
  const file = await tempVideo(t);
  const impl = fakeFetch([
    [/video_reels$/, () => jsonResponse({ video_id: 'v-3' })],
    [/rupload/, () => jsonResponse({ success: true })],
    [/fields=status/, () => jsonResponse({
      status: { video_status: 'error', publishing_phase: { status: 'error', error: { message: 'Video quá ngắn' } } }
    })]
  ]);

  await assert.rejects(
    publishReel({ filePath: file, description: 'x', config, fetchImpl: impl, pollIntervalMs: 1 }),
    /Video quá ngắn/
  );
});

test('hết thời gian chờ vẫn báo rõ là video đã tải lên', async (t) => {
  const file = await tempVideo(t);
  const impl = fakeFetch([
    [/video_reels$/, () => jsonResponse({ video_id: 'v-4' })],
    [/rupload/, () => jsonResponse({ success: true })],
    [/fields=status/, () => jsonResponse({ status: { video_status: 'processing' } })]
  ]);

  await assert.rejects(
    publishReel({ filePath: file, description: 'x', config, fetchImpl: impl, pollTimeoutMs: 30, pollIntervalMs: 1 }),
    /Video đã tải lên/
  );
});

test('chưa cấu hình thì từ chối ngay, không gọi mạng', async (t) => {
  const file = await tempVideo(t);
  const impl = fakeFetch([[/./, () => { throw new Error('không được gọi'); }]]);
  await assert.rejects(
    publishReel({ filePath: file, description: 'x', config: { pageId: '', accessToken: '', graphVersion: 'v25.0' }, fetchImpl: impl }),
    /Chưa cấu hình FACEBOOK_PAGE_ID/
  );
  assert.equal(impl.calls.length, 0);
});
