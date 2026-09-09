import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGeminiRepairPrompt,
  buildGeminiStoryPrompt,
  buildGeminiStoryRepairPrompt,
  buildGeminiStoryboardPrompt,
  buildGrokTextPartJob,
  buildGrokTopicPartJob,
  countWords,
  expectedPartCount,
  formatGeminiStoryText,
  MIN_STORY_WORDS,
  MIN_STORY_WORDS_RETRY,
  parseGeminiStory,
  parseGeminiStoryboard,
  sourceCoverageRanges
} from '../lib/prompt-plan.js';

const longPrompt = 'A cinematic shot follows the same subject through the scene with precise camera motion, lighting, ambient audio, and a clean transition.';
const continuity = 'The same adult subject, facial identity, blue jacket, warm sunset lighting, muted teal palette, and handheld camera language remain unchanged.';

test('lập đúng 4 part cho video nguồn 35,97 giây', () => {
  assert.equal(expectedPartCount(35.97), 4);
  const prompt = buildGeminiStoryboardPrompt({ duration: 35.97, userInstruction: '', aspectRatio: '9:16' });
  assert.match(prompt, /exactly 4 storyboard parts/i);
  assert.match(prompt, /"partNumber":4/);
  assert.match(prompt, /"sourceEndSeconds":35\.97/);
  assert.match(prompt, /target aspect ratio is 9:16/i);
});

test('đọc JSON Gemini trong code fence và không nhầm dấu ngoặc trong chuỗi', () => {
  const raw = `Here is the result:\n\`\`\`json\n${JSON.stringify({
    schemaVersion: 1,
    summary: 'A {short} source video',
    globalContinuity: continuity,
    parts: [
      { partNumber: 1, sourceStartSeconds: 0, sourceEndSeconds: 10, prompt: `${longPrompt} Opening section.` },
      { partNumber: 2, sourceStartSeconds: 10, sourceEndSeconds: 12, prompt: `${longPrompt} Closing section with a literal } symbol in a prop.` }
    ]
  })}\n\`\`\``;
  const plan = parseGeminiStoryboard(raw, { duration: 12 });
  assert.equal(plan.parts.length, 2);
  assert.equal(plan.parts[1].sourceEndSeconds, 12);
  assert.match(plan.parts[1].prompt, /literal } symbol/);
});

test('từ chối plan thiếu part hoặc thiếu mô tả đồng nhất', () => {
  assert.throws(() => parseGeminiStoryboard(JSON.stringify({
    globalContinuity: continuity,
    parts: [{ partNumber: 1, prompt: longPrompt }]
  }), { duration: 12 }), /trả 1 part, cần đúng 2 part/);

  assert.throws(() => parseGeminiStoryboard(JSON.stringify({
    globalContinuity: 'too short',
    parts: [{ partNumber: 1, prompt: longPrompt }]
  }), { duration: 8 }), /globalContinuity/);
});

test('repair prompt ghi rõ lỗi và số part cần trả', () => {
  const prompt = buildGeminiRepairPrompt(new Error('JSON lỗi'), 3);
  assert.match(prompt, /JSON lỗi/);
  assert.match(prompt, /exactly 3 parts/);
});

const twoPartPlan = {
  globalContinuity: continuity,
  parts: [
    { partNumber: 1, sourceStartSeconds: 0, sourceEndSeconds: 10, prompt: longPrompt },
    { partNumber: 2, sourceStartSeconds: 10, sourceEndSeconds: 12, prompt: `${longPrompt} Closing section.` }
  ]
};

test('job Grok theo video nguồn mặc định không gửi ảnh tham chiếu', () => {
  const result = buildGrokTextPartJob({ id: 'job', sourcePath: 'source.mp4', referencePaths: ['cu.jpg'] }, twoPartPlan, 1);
  assert.equal(result.sourcePath, null);
  assert.deepEqual(result.referencePaths, []);
  assert.doesNotMatch(result.prompt, /REFERENCE IMAGES/);
  assert.match(result.prompt, /1080p/);
  assert.match(result.prompt, /storyboard part 2\/2/);
  assert.match(result.prompt, /GLOBAL CONTINUITY/);
});

test('job Grok chuyển tiếp ảnh tham chiếu và mô tả đúng vai trò từng ảnh', () => {
  const result = buildGrokTextPartJob({ id: 'job', sourcePath: 'source.mp4' }, twoPartPlan, 1, {
    references: [
      { path: 'user.jpg', role: 'user' },
      { path: 'source-002.jpg', role: 'source_frame' },
      { path: 'prev-002.jpg', role: 'previous_tail' }
    ]
  });
  assert.equal(result.sourcePath, null);
  assert.deepEqual(result.referencePaths, ['user.jpg', 'source-002.jpg', 'prev-002.jpg']);
  assert.deepEqual(result.referenceRoles, ['user', 'source_frame', 'previous_tail']);
  assert.match(result.prompt, /REFERENCE IMAGES \(attached in this order\)/);
  assert.match(result.prompt, /1\) a reference supplied by the user/);
  assert.match(result.prompt, /2\) a still frame from the source video/);
  assert.match(result.prompt, /3\) the final frame of the previous clip/);
  assert.match(result.prompt, /do not return a frozen frame/i);
});

test('thời lượng tùy chỉnh chia đều toàn bộ video nguồn thành đúng số part', () => {
  assert.deepEqual(sourceCoverageRanges(37.24, 20), [
    { partNumber: 1, sourceStartSeconds: 0, sourceEndSeconds: 18.62 },
    { partNumber: 2, sourceStartSeconds: 18.62, sourceEndSeconds: 37.24 }
  ]);
  const prompt = buildGeminiStoryboardPrompt({
    duration: 37.24,
    targetDuration: 20,
    outputLanguage: 'vi',
    aspectRatio: '9:16'
  });
  assert.match(prompt, /source duration measured locally is 37\.24 seconds/i);
  assert.match(prompt, /requested output duration is 20 seconds/i);
  assert.match(prompt, /exactly 2 storyboard parts/i);
  assert.match(prompt, /Vietnamese/);
});

test('parser chuẩn hóa range theo target duration thay vì tạo mốc vượt video nguồn', () => {
  const raw = JSON.stringify({
    globalContinuity: continuity,
    parts: [
      { partNumber: 1, sourceStartSeconds: 0, sourceEndSeconds: 10, prompt: `${longPrompt} First compressed beat.` },
      { partNumber: 2, sourceStartSeconds: 10, sourceEndSeconds: 20, prompt: `${longPrompt} Second compressed beat.` }
    ]
  });
  const plan = parseGeminiStoryboard(raw, { duration: 37.24, targetDuration: 20 });
  assert.equal(plan.parts.length, 2);
  assert.equal(plan.parts[0].sourceEndSeconds, 18.62);
  assert.equal(plan.parts[1].sourceStartSeconds, 18.62);
  assert.equal(plan.parts[1].sourceEndSeconds, 37.24);
});

test('topic 30 giây tạo prompt riêng cho từng part và áp dụng ngôn ngữ', () => {
  const job = {
    id: 'topic-job',
    prompt: 'Một đầu bếp chuẩn bị món ăn trong căn bếp điện ảnh.',
    language: 'ja',
    targetDuration: 30,
    aspectRatio: '16:9'
  };
  const first = buildGrokTopicPartJob(job, 0, 3);
  const middle = buildGrokTopicPartJob(job, 1, 3);
  const last = buildGrokTopicPartJob(job, 2, 3);
  assert.match(first.prompt, /part 1\/3/);
  assert.match(first.prompt, /Một đầu bếp chuẩn bị món ăn trong căn bếp điện ảnh/);
  assert.match(first.prompt, /Japanese/);
  assert.match(first.prompt, /Establish the recurring subject/);
  assert.match(middle.prompt, /Continue the central action/);
  assert.match(last.prompt, /natural conclusion/);
  assert.equal(first.sourcePath, null);
  assert.deepEqual(first.referencePaths, []);

  const chained = buildGrokTopicPartJob(job, 1, 3, {
    references: [{ path: 'prev-002.jpg', role: 'previous_tail' }]
  });
  assert.deepEqual(chained.referencePaths, ['prev-002.jpg']);
  assert.match(chained.prompt, /1\) the final frame of the previous clip/);
});

test('chế độ Không thoại không xung đột với quy tắc giữ nội dung nguồn', () => {
  const prompt = buildGeminiStoryboardPrompt({ duration: 12, outputLanguage: 'none' });
  assert.match(prompt, /Do not add spoken dialogue, narration, or voice-over/);
  assert.doesNotMatch(prompt, /Preserve[^\n]*dialogue/i);
});

test('prompt câu chuyện yêu cầu Gemini bám sát nhân vật, nội dung video nguồn và tối thiểu trên 2.000 từ', () => {
  const prompt = buildGeminiStoryPrompt({ duration: 37.24, outputLanguage: 'vi' });
  assert.match(prompt, /source video duration measured locally is 37\.24 seconds/i);
  assert.match(prompt, /characters, setting, important actions, event order/i);
  assert.match(prompt, /closely grounded in the source video/i);
  assert.match(prompt, /OVER 2,000 WORDS/i);
  assert.match(prompt, /trên 2\.000 từ/i);
  assert.match(prompt, /Tiếng Việt/);
  assert.match(prompt, /"title"/);
  assert.match(prompt, /"content"/);
});

test('countWords đếm chính xác số từ cho tiếng Việt và tiếng Anh', () => {
  assert.equal(countWords(''), 0);
  assert.equal(countWords('   '), 0);
  assert.equal(countWords(null), 0);
  assert.equal(countWords('Một hai ba bốn'), 4);
  assert.equal(countWords('  Một   hai\n\nba   bốn  năm  '), 5);
  assert.equal(countWords('This is a test sentence with eight words.'), 8);
  assert.equal(MIN_STORY_WORDS, 2000);
  assert.equal(MIN_STORY_WORDS_RETRY, 1500);
});

test('parser và formatter câu chuyện tạo đúng file text có Tiêu đề và Nội dung', () => {
  const raw = `Một ghi chú phụ\n\`\`\`json\n${JSON.stringify({
    title: 'Chiếc ô dưới cơn mưa',
    content: 'Lan bước qua con phố trong cơn mưa lớn. Cô che chiếc ô đỏ cho một chú chó nhỏ, rồi cùng nó tìm được đường về nhà trong ánh đèn ấm áp.'
  })}\n\`\`\``;
  const story = parseGeminiStory(raw);
  assert.equal(story.title, 'Chiếc ô dưới cơn mưa');
  assert.match(story.content, /chú chó nhỏ/);
  assert.equal(story.wordCount, countWords(story.content));
  assert.equal(
    formatGeminiStoryText(story),
    `Tiêu đề: ${story.title}\n\nNội dung:\n${story.content}\n`
  );
});

test('câu chuyện thiếu nội dung hoặc không đủ số từ được từ chối và repair prompt yêu cầu lại đủ hai trường trên 2.000 từ', () => {
  assert.throws(() => parseGeminiStory(JSON.stringify({
    title: 'Một tiêu đề', content: 'Quá ngắn.'
  })), /quá ngắn/);

  // Kiểm tra ngưỡng minWords
  assert.throws(() => parseGeminiStory(JSON.stringify({
    title: 'Một tiêu đề',
    content: 'Đây là một câu chuyện có độ dài trên 80 ký tự nhưng tổng số lượng từ của nó vẫn còn quá ít so với yêu cầu đề ra.'
  }), { minWords: 100 }), /quá ngắn \(\d+ từ\)\. Yêu cầu tối thiểu trên 100 từ/);

  // Khi đủ số từ với minWords
  const sampleWords = Array.from({ length: 120 }, (_, i) => `từ${i + 1}`).join(' ');
  const passed = parseGeminiStory(JSON.stringify({
    title: 'Đủ độ dài', content: sampleWords
  }), { minWords: 100 });
  assert.equal(passed.wordCount, 120);

  const repair = buildGeminiStoryRepairPrompt(new Error('thiếu nội dung'), { outputLanguage: 'none' });
  assert.match(repair, /thiếu nội dung/);
  assert.match(repair, /uploaded source video/i);
  assert.match(repair, /OVER 2,000 WORDS/i);
  assert.match(repair, /trên 2\.000 từ/i);
  assert.match(repair, /"title" and "content"/);
  assert.match(repair, /Vietnamese/i);
});

test('clip 15 giây chia ít part hơn cho cùng thời lượng đích', () => {
  assert.equal(expectedPartCount(60, 10), 6);
  assert.equal(expectedPartCount(60, 15), 4, '60 giây còn 4 lượt Grok thay vì 6');
  assert.equal(expectedPartCount(45, 15), 3);
  assert.equal(expectedPartCount(35.97, 15), 3);
  assert.equal(expectedPartCount(60), 6, 'mặc định vẫn là 10 giây cho tác vụ cũ');
});

test('khoảng phủ nguồn theo clip 15 giây bước đúng 15 giây', () => {
  assert.deepEqual(sourceCoverageRanges(32, null, 15), [
    { partNumber: 1, sourceStartSeconds: 0, sourceEndSeconds: 15 },
    { partNumber: 2, sourceStartSeconds: 15, sourceEndSeconds: 30 },
    { partNumber: 3, sourceStartSeconds: 30, sourceEndSeconds: 32 }
  ]);
});

test('prompt Gemini và Grok công bố đúng độ dài clip 15 giây', () => {
  const storyboard = buildGeminiStoryboardPrompt({ duration: 45, aspectRatio: '16:9', clipSeconds: 15 });
  assert.match(storyboard, /exactly 3 storyboard parts/i);
  assert.match(storyboard, /3 full 15-second clips/i);
  assert.doesNotMatch(storyboard, /10-second/);

  const plan = {
    globalContinuity: continuity,
    parts: [
      { partNumber: 1, sourceStartSeconds: 0, sourceEndSeconds: 15, prompt: longPrompt },
      { partNumber: 2, sourceStartSeconds: 15, sourceEndSeconds: 30, prompt: `${longPrompt} Second beat.` }
    ]
  };
  const part = buildGrokTextPartJob({ id: 'job', clipSeconds: 15 }, plan, 0);
  assert.match(part.prompt, /Create exactly one 15-second video clip/);
  assert.doesNotMatch(part.prompt, /10-second/);

  const topic = buildGrokTopicPartJob({ id: 'job', prompt: 'Một quán cà phê buổi sáng.', clipSeconds: 15 }, 0, 4);
  assert.match(topic.prompt, /Create exactly one 15-second video clip/);
  assert.match(topic.prompt, /of a 60-second sequence/);
});
