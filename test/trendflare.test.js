import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  trendflareConfig,
  trendflareConfigured,
  redactTrendflareSecrets,
  formatStoryToHtml,
  publishStoryToTrendflare
} from '../lib/trendflare.js';
import {
  buildGeminiMasterWriterPrompt,
  buildGeminiMasterWriterRepairPrompt,
  parseGeminiMasterStory,
  buildGeminiThumbnailPrompt,
  buildGeminiStoryboardFromStoryPrompt,
  parseGeminiStoryboardFromStory,
  buildGeminiTopicStoryPrompt,
  parseGeminiTopicStoryPlan,
  buildGeminiTopicStoryRepairPrompt,
  buildGrokTopicStoryPartJob
} from '../lib/prompt-plan.js';

test('đọc cấu hình Trendflare từ biến môi trường', () => {
  const custom = trendflareConfig({
    TRENDFLARE_API_URL: 'https://example.com/api/',
    TRENDFLARE_API_TOKEN: 'test_token_123',
    TRENDFLARE_CATEGORY_ID: '42'
  });
  assert.equal(custom.apiUrl, 'https://example.com/api');
  assert.equal(custom.token, 'test_token_123');
  assert.equal(custom.defaultCategoryId, 42);

  assert.equal(trendflareConfigured(custom), true);
  assert.equal(trendflareConfigured({ apiUrl: 'https://test.com', token: '' }), false);
});

test('token Trendflare bị che trong mọi chuỗi lỗi và log', () => {
  const token = '3|0KiFpdjBugMzOf9xqb8hHp2oa2dKHJnthVnwfUk5aef223c2';
  const config = { apiUrl: 'https://test.com', token };

  const raw = `Error connecting with Bearer ${token} and token=${token}`;
  const redacted = redactTrendflareSecrets(raw, config);

  assert.equal(redacted.includes(token), false);
  assert.match(redacted, /\[redacted/);
});

test('formatStoryToHtml chuyển đổi đoạn văn bản thành thẻ p chuẩn HTML', () => {
  const text = 'Đoạn một của câu chuyện.\n\nĐoạn hai của câu chuyện có dòng 1\nvà dòng 2.\n\nĐoạn ba kết thúc.';
  const html = formatStoryToHtml(text);

  assert.equal(html, '<p>Đoạn một của câu chuyện.</p><p>Đoạn hai của câu chuyện có dòng 1<br>và dòng 2.</p><p>Đoạn ba kết thúc.</p>');
});

test('publishStoryToTrendflare gửi đúng payload đa ngôn ngữ và nhận link bài viết', async (t) => {
  let receivedHeader = null;
  let receivedBody = null;

  const server = http.createServer(async (req, res) => {
    receivedHeader = req.headers.authorization;
    const buffers = [];
    for await (const chunk of req) buffers.push(chunk);
    receivedBody = JSON.parse(Buffer.concat(buffers).toString('utf8'));

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      message: 'Post created successfully.',
      data: {
        id: 9999,
        slug: 'chu-cho-trung-thanh',
        title: receivedBody.title,
        status: 'published'
      }
    }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const port = server.address().port;
  const config = {
    apiUrl: `http://127.0.0.1:${port}`,
    token: 'my-mock-sanctum-token',
    defaultCategoryId: 17
  };

  const result = await publishStoryToTrendflare({
    title: 'Chú chó trung thành',
    content: 'Ngày xưa có một chú chó rất trung thành.\n\nNó luôn bảo vệ chủ nhân.',
    language: 'vi'
  }, config);

  assert.equal(receivedHeader, 'Bearer my-mock-sanctum-token');
  assert.equal(receivedBody.title.vi, 'Chú chó trung thành');
  assert.equal(receivedBody.title.en, 'Chú chó trung thành');
  assert.equal(receivedBody.category_id, 17);
  assert.match(receivedBody.content.vi, /<p>Ngày xưa có một chú chó/);
  assert.equal(result.id, 9999);
  assert.equal(result.slug, 'chu-cho-trung-thanh');
  assert.equal(result.url, 'https://report.trendflare.biz/blog/chu-cho-trung-thanh');
});

test('publishStoryToTrendflare bắt lỗi khi server trả mã lỗi mà không làm lộ token', async (t) => {
  const token = 'secret-secret-token-xyz';
  const server = http.createServer((_req, res) => {
    res.writeHead(422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      message: `Validation failed with ${token}`,
      errors: { title: ['Title is required'] }
    }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const port = server.address().port;
  const config = { apiUrl: `http://127.0.0.1:${port}`, token, defaultCategoryId: 17 };

  await assert.rejects(
    async () => publishStoryToTrendflare({ title: 'Test', content: 'Content' }, config),
    (error) => {
      assert.equal(error.message.includes(token), false);
      assert.match(error.message, /\[redacted-token\]/);
      return true;
    }
  );
});

test('buildGeminiTopicStoryPrompt tạo prompt yêu cầu cả câu chuyện và storyboard', () => {
  const prompt = buildGeminiTopicStoryPrompt({
    userPrompt: 'Chuyện chú mèo đi lạc',
    targetDuration: 30,
    outputLanguage: 'vi',
    clipSeconds: 10
  });

  assert.match(prompt, /Chuyện chú mèo đi lạc/);
  assert.match(prompt, /30-second/);
  assert.match(prompt, /exactly 3 parts/);
  assert.match(prompt, /OVER 2,000 WORDS/i);
  assert.match(prompt, /trên 2\.000 từ/i);
  assert.match(prompt, /Tiếng Việt/);
  assert.match(prompt, /"title"/);
  assert.match(prompt, /"content"/);
  assert.match(prompt, /"parts"/);
});

test('parseGeminiTopicStoryPlan trích xuất đúng câu chuyện và mảng parts hợp lệ', () => {
  const mockJson = JSON.stringify({
    title: 'Hành trình trở về',
    content: 'Ngày xửa ngày xưa, ở một ngôi làng nhỏ ven rừng có một chú chó tên là Lu.\n\nMột ngày nọ bão tuyết ập đến, Lu đã dũng cảm vượt qua giá lạnh để tìm đường về nhà.',
    summary: 'Câu chuyện cảm động về chú chó Lu',
    globalContinuity: 'Chú chó lông vàng, đôi mắt sáng thông minh, bước đi nhanh nhẹn trong bão tuyết trắng xóa',
    parts: [
      {
        partNumber: 1,
        prompt: 'Part 1: Chú chó Lu bắt đầu rời khỏi ngôi làng nhỏ trong buổi sáng tuyết rơi nhẹ nhàng, camera góc rộng.'
      },
      {
        partNumber: 2,
        prompt: 'Part 2: Bão tuyết dữ dội nổi lên, chú chó Lu kiên cường bước đi giữa gió rít, lông bay trong gió tuyết.'
      }
    ]
  });

  const parsed = parseGeminiTopicStoryPlan(mockJson, { targetDuration: 20, clipSeconds: 10 });
  assert.equal(parsed.title, 'Hành trình trở về');
  assert.match(parsed.content, /Ngày xửa ngày xưa/);
  assert.equal(parsed.wordCount > 0, true);
  assert.equal(parsed.parts.length, 2);
  assert.equal(parsed.parts[0].prompt.includes('Part 1'), true);
  assert.equal(parsed.parts[1].prompt.includes('Part 2'), true);

  // Kiểm tra minWords từ chối khi nội dung ngắn
  assert.throws(() => parseGeminiTopicStoryPlan(mockJson, { targetDuration: 20, clipSeconds: 10, minWords: 100 }), /quá ngắn/);
});

test('buildGrokTopicStoryPartJob gắn đúng thông tin câu chuyện và continuity vào Grok prompt', () => {
  const plan = {
    title: 'Hành trình của Lu',
    globalContinuity: 'Chú chó lông vàng, mắt sáng thông minh',
    parts: [
      {
        startSeconds: 0,
        endSeconds: 10,
        prompt: 'Cảnh chú chó chạy trên cánh đồng tuyết bao la'
      }
    ]
  };

  const job = {
    clipSeconds: 10,
    language: 'vi',
    prompt: 'Chuyện chú chó'
  };

  const partJob = buildGrokTopicStoryPartJob(job, plan, 0, { references: [] });
  assert.match(partJob.prompt, /ORIGINAL STORY SCENE: Hành trình của Lu/);
  assert.match(partJob.prompt, /GLOBAL CONTINUITY — reproduce these identities.*Chú chó lông vàng/);
  assert.match(partJob.prompt, /THIS PART: Cảnh chú chó chạy trên cánh đồng tuyết bao la/);
  assert.match(partJob.prompt, /Vietnamese/);
});

test('buildGeminiMasterWriterPrompt đặt vai trò Nhà văn kiệt xuất và parseGeminiMasterStory trích xuất đúng truyện', () => {
  const prompt = buildGeminiMasterWriterPrompt({
    userPrompt: 'Tiếng chuông cổ thành',
    outputLanguage: 'vi'
  });

  assert.match(prompt, /NHÀ VĂN KIỆT XUẤT/);
  assert.match(prompt, /MASTER LITERARY AUTHOR/);
  assert.match(prompt, /Tiếng chuông cổ thành/);
  assert.match(prompt, /KHÔNG tạo video/);
  assert.match(prompt, /TRÊN 2\.000 TỪ/i);
  assert.match(prompt, /2\.000 words/i);

  const mockStoryJson = JSON.stringify({
    title: 'Tiếng chuông cổ thành',
    content: 'Hoàng hôn buông xuống thung lũng cổ kính, nhuộm vàng những bức tường đá rêu phong.\n\nNgười thợ già khẽ kéo dây chuông. Tiếng ngân vang xa, chạm vào những hoài niệm xa xăm của thị trấn nhỏ bên dòng sông lững lờ trôi.'
  });

  const parsed = parseGeminiMasterStory(mockStoryJson);
  assert.equal(parsed.title, 'Tiếng chuông cổ thành');
  assert.match(parsed.content, /Hoàng hôn buông xuống/);
  assert.equal(parsed.wordCount > 0, true);

  // Kiểm tra minWords từ chối khi nội dung ngắn
  assert.throws(() => parseGeminiMasterStory(mockStoryJson, { minWords: 100 }), /quá ngắn/);

  // Kiểm tra repair prompt Nhà văn kiệt xuất
  const repair = buildGeminiMasterWriterRepairPrompt(new Error('truyện quá ngắn'), { outputLanguage: 'vi' });
  assert.match(repair, /TRÊN 2\.000 TỪ/i);
  assert.match(repair, /2\.000 words/i);
  assert.match(repair, /truyện quá ngắn/);
});

test('buildGeminiThumbnailPrompt tạo chỉ dẫn hình ảnh 16:9 điện ảnh không chữ', () => {
  const prompt = buildGeminiThumbnailPrompt({
    title: 'Tiếng chuông cổ thành',
    content: 'Người thợ già kéo dây chuông lúc hoàng hôn.'
  });

  assert.match(prompt, /16:9/);
  assert.match(prompt, /cinematic 16:9 featured artwork/);
  assert.match(prompt, /Tiếng chuông cổ thành/);
  assert.match(prompt, /KHÔNG vẽ bất kỳ chữ viết/);
});

test('buildGeminiStoryboardFromStoryPrompt và parseGeminiStoryboardFromStory chuyển thể câu chuyện thành phân cảnh', () => {
  const story = {
    title: 'Bí ẩn ngôi đền cổ',
    content: 'Đoàn thám hiểm tiến vào khu rừng nhiệt đới âm u. Họ phát hiện một lối đi bí mật dẫn xuống lòng đất, nơi cất giấu ánh sáng huyền bí của nền văn minh cổ xưa.'
  };

  const prompt = buildGeminiStoryboardFromStoryPrompt({
    story,
    targetDuration: 20,
    clipSeconds: 10,
    aspectRatio: '16:9',
    outputLanguage: 'vi'
  });

  assert.match(prompt, /CINEMATIC STORYBOARD ADAPTATION TASK/);
  assert.match(prompt, /Bí ẩn ngôi đền cổ/);
  assert.match(prompt, /exactly 2 parts/);

  const mockStoryboardJson = JSON.stringify({
    globalContinuity: 'Đoàn thám hiểm mặc áo khoác phong trần, đuốc bập bùng trong hang đá cổ kính ẩm ướt',
    parts: [
      {
        partNumber: 1,
        prompt: 'Part 1: Đoàn thám hiểm bước qua cửa hang rêu phong, ngọn đuốc soi sáng bức phù điêu cổ đại kỳ bí.'
      },
      {
        partNumber: 2,
        prompt: 'Part 2: Họ nhìn thấy ánh hào quang lấp lánh phản chiếu từ viên ngọc cổ trên bệ đá thiêng liêng.'
      }
    ]
  });

  const parsed = parseGeminiStoryboardFromStory(mockStoryboardJson, { targetDuration: 20, clipSeconds: 10 });
  assert.equal(parsed.parts.length, 2);
  assert.match(parsed.globalContinuity, /Đoàn thám hiểm/);
  assert.match(parsed.parts[0].prompt, /cửa hang rêu phong/);
});

test('publishStoryToTrendflare gửi file ảnh qua multipart và nhận slug bài viết', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trendflare-test-'));
  const testImagePath = path.join(tmpDir, 'test-thumb.png');
  // 1x1 png
  await fs.writeFile(testImagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));

  t.after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  let receivedContentType = '';
  let receivedMethod = '';
  let receivedAuth = '';

  const server = http.createServer(async (req, res) => {
    receivedMethod = req.method;
    receivedContentType = req.headers['content-type'] || '';
    receivedAuth = req.headers.authorization || '';

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      message: 'Post created successfully.',
      data: {
        id: 12345,
        slug: 'tieng-chuong-co-thanh',
        title: { vi: 'Tiếng chuông cổ thành', en: 'Tiếng chuông cổ thành' },
        status: 'published',
        featured_image: 'https://cdn.trendflare.biz/site_8/test-thumb.png'
      }
    }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const port = server.address().port;
  const config = {
    apiUrl: `http://127.0.0.1:${port}`,
    token: 'test-token-multipart',
    defaultCategoryId: 17
  };

  const result = await publishStoryToTrendflare({
    title: 'Tiếng chuông cổ thành',
    content: 'Câu chuyện hoàng hôn ở cổ thành.',
    language: 'vi',
    featuredImage: testImagePath
  }, config);

  assert.equal(receivedMethod, 'POST');
  assert.equal(receivedAuth, 'Bearer test-token-multipart');
  assert.match(receivedContentType, /^multipart\/form-data/);
  assert.equal(result.id, 12345);
  assert.equal(result.slug, 'tieng-chuong-co-thanh');
  assert.equal(result.url, 'https://report.trendflare.biz/blog/tieng-chuong-co-thanh');
  assert.equal(result.featuredImage, 'https://cdn.trendflare.biz/site_8/test-thumb.png');
});
