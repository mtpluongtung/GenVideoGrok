import { videoLanguageInstruction, videoLanguageLabel } from './job-options.js';

function formatTimestamp(seconds) {
  const safe = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(safe / 60);
  const remainder = safe % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

export const DEFAULT_CLIP_SECONDS = 10;

function clipLength(clipSeconds) {
  const seconds = Number(clipSeconds);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_CLIP_SECONDS;
}

export function expectedPartCount(duration, clipSeconds = DEFAULT_CLIP_SECONDS) {
  const seconds = Number(duration);
  const step = clipLength(clipSeconds);
  return Number.isFinite(seconds) && seconds > 0 ? Math.max(1, Math.ceil(seconds / step)) : 1;
}

function roundedSeconds(value) {
  return Math.round(Number(value) * 100) / 100;
}

export function sourceCoverageRanges(sourceDuration, targetDuration = null, clipSeconds = DEFAULT_CLIP_SECONDS) {
  const sourceSeconds = Math.max(0.01, Number(sourceDuration) || 0.01);
  const step = clipLength(clipSeconds);
  const customTarget = targetDuration != null;
  const outputSeconds = customTarget ? Number(targetDuration) : sourceSeconds;
  const partCount = expectedPartCount(outputSeconds, step);
  return Array.from({ length: partCount }, (_item, index) => ({
    partNumber: index + 1,
    sourceStartSeconds: customTarget ? roundedSeconds(sourceSeconds * index / partCount) : index * step,
    sourceEndSeconds: customTarget
      ? roundedSeconds(sourceSeconds * (index + 1) / partCount)
      : Math.min(sourceSeconds, (index + 1) * step)
  }));
}

function outputTimelineRanges(targetDuration, clipSeconds = DEFAULT_CLIP_SECONDS) {
  const step = clipLength(clipSeconds);
  const duration = Math.max(step, Number(targetDuration) || step);
  const partCount = expectedPartCount(duration, step);
  return Array.from({ length: partCount }, (_item, index) => ({
    partNumber: index + 1,
    startSeconds: index * step,
    endSeconds: Math.min(duration, (index + 1) * step)
  }));
}

function storyLanguageInstruction(outputLanguage) {
  if (outputLanguage === 'auto') {
    return 'Write the title and story in the primary language used by the source video. If the source has no identifiable language, use Vietnamese.';
  }
  if (outputLanguage === 'none') {
    return 'Write the title and story in Vietnamese. The no-dialogue setting applies only to the generated video, not to this text story.';
  }
  return `Write the title and story in ${videoLanguageLabel(outputLanguage)}.`;
}

export function buildGeminiStoryPrompt({ duration, outputLanguage = 'auto' }) {
  const sourceDuration = Math.max(0.01, Number(duration) || 0.01);
  return [
    'STANDALONE TEXT STORY TASK. Analyze the uploaded source video using its complete visual and audio content. Do not generate or edit video, images, or audio.',
    `The source video duration measured locally is ${sourceDuration.toFixed(2)} seconds. Make the amount of story detail proportional to this duration.`,
    'Create one coherent original story whose characters, setting, important actions, event order, mood, and central content stay closely grounded in the source video.',
    'You may add names, motivations, emotions, and natural connective details to turn the observed sequence into a satisfying story, but do not introduce unrelated scenes or contradict clearly visible events.',
    'If the source has no human character, treat its main animal, object, place, or recurring subject as the central character when appropriate.',
    storyLanguageInstruction(outputLanguage),
    'Return exactly one valid JSON object and nothing else. Do not use Markdown fences.',
    '{',
    '  "title": "a concise, engaging title grounded in the source video",',
    '  "content": "the complete prose story with characters, a clear beginning, development, and ending; use newline characters between paragraphs when useful"',
    '}',
    'The title and content must both be non-empty. Do not return a storyboard, generation prompt, transcript, timestamps, explanation, or any text outside this JSON object.'
  ].join('\n');
}

export function buildGeminiStoryRepairPrompt(error, { outputLanguage = 'auto' } = {}) {
  return [
    `Your previous story response could not be used: ${error.message}`,
    'Using the uploaded source video already present in this conversation, return the complete corrected story again.',
    storyLanguageInstruction(outputLanguage),
    'Return exactly one valid JSON object with two non-empty string fields: "title" and "content".',
    'The content must be a coherent prose story with characters and events closely grounded in the video. Do not return Markdown, a storyboard, prompts, timestamps, or commentary.'
  ].join('\n');
}

export function buildGeminiTopicStoryPrompt({
  userPrompt = '',
  targetDuration,
  outputLanguage = 'auto',
  aspectRatio = '16:9',
  clipSeconds = DEFAULT_CLIP_SECONDS
}) {
  const duration = Number(targetDuration);
  const step = clipLength(clipSeconds);
  const ranges = outputTimelineRanges(duration, step);
  const partCount = ranges.length;
  const languageInstruction = outputLanguage === 'auto'
    ? 'Choose the spoken/narration language that best fits the selected audience. Prefer Vietnamese for a general audience unless the topic clearly targets another language. Keep that language consistent in every part.'
    : videoLanguageInstruction(outputLanguage, { hasSource: false });
  const storyLangInstruction = storyLanguageInstruction(outputLanguage);
  const sampleRange = ranges[0];

  return [
    'STORY WRITING AND MULTI-PART VIDEO STORYBOARD TASK. Do not generate video, images, or audio in Gemini. Return only valid JSON text.',
    userPrompt.trim()
      ? `Write an engaging, complete prose story based on this topic: "${userPrompt.trim()}".`
      : 'Create an engaging, original, complete viral prose story with compelling characters, clear conflict, emotional depth, and a memorable conclusion.',
    storyLangInstruction,
    `The story must also be adapted into a ${duration.toFixed(0)}-second video composed of exactly ${partCount} parts (${step} seconds each) at ${aspectRatio}.`,
    `Output language requirement for dialogue/narration: ${languageInstruction}`,
    `Required video timeline: ${JSON.stringify(ranges)}`,
    '',
    'Return exactly one valid JSON object and nothing else. Do not use Markdown fences.',
    '{',
    '  "schemaVersion": 1,',
    '  "title": "a captivating, non-empty story title in the requested story language",',
    '  "content": "the complete, multi-paragraph prose narrative story written with rich description and emotional depth in the requested story language; separate paragraphs with newlines",',
    '  "summary": "a short summary of the story arc",',
    '  "globalContinuity": "precise reusable description of recurring people/subjects, faces, hair, clothing, props, environment, lighting, color palette, camera language, and art style to maintain 100% visual consistency across all parts",',
    '  "parts": [',
    '    {',
    '      "partNumber": 1,',
    `      "startSeconds": ${sampleRange.startSeconds},`,
    `      "endSeconds": ${sampleRange.endSeconds},`,
    `      "prompt": "a self-contained English ${step}-second Grok video prompt for scene 1 with exact action, characters matching globalContinuity, setting, camera motion, cinematic lighting, and mood; any spoken words or narration written verbatim in the required output language"`,
    '    }',
    '  ]',
    '}',
    '',
    'Rules:',
    `- "title" must be a non-empty string.`,
    `- "content" must be a full, detailed prose story (at least 80 characters) written in the required language (${storyLangInstruction}).`,
    `- The parts array must contain exactly ${partCount} items numbered 1 through ${partCount}.`,
    `- Each part prompt must be self-contained and detailed enough for independent Grok video generation, repeating essential continuity details from globalContinuity.`,
    `- Use double quotes, no comments, no trailing commas, and no text outside the JSON object.`
  ].join('\n');
}

export function buildGeminiTopicStoryRepairPrompt(error, { expectedParts, targetDuration, outputLanguage = 'auto', clipSeconds = DEFAULT_CLIP_SECONDS }) {
  const storyLangInstruction = storyLanguageInstruction(outputLanguage);
  return [
    `Your previous response could not be used: ${error.message}`,
    `Return a corrected JSON object only for the ${targetDuration}-second video.`,
    `It must contain a non-empty "title", a rich prose "content" written in ${storyLangInstruction}, a "summary", "globalContinuity", and exactly ${expectedParts} parts in "parts" numbered 1 through ${expectedParts}.`,
    'Do not add Markdown fences or commentary.'
  ].join('\n');
}

export function parseGeminiTopicStoryPlan(text, { targetDuration, clipSeconds = DEFAULT_CLIP_SECONDS }) {
  const ranges = outputTimelineRanges(targetDuration, clipSeconds);
  const expected = ranges.length;
  let lastError;
  for (const candidate of jsonCandidates(text)) {
    let parsed;
    try { parsed = JSON.parse(candidate); }
    catch (error) { lastError = error; continue; }
    try {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('JSON kịch bản câu chuyện phải là một object.');
      }
      const rawTitle = parsed.title ?? parsed.storyTitle;
      const rawContent = parsed.content ?? parsed.storyContent ?? parsed.narrative ?? parsed.body;
      if (typeof rawTitle !== 'string' || typeof rawContent !== 'string') {
        throw new Error('Gemini phải trả title và content câu chuyện dưới dạng chuỗi.');
      }
      const title = rawTitle.trim();
      const content = rawContent.trim();
      if (title.length < 3) throw new Error('Tiêu đề câu chuyện quá ngắn hoặc bị thiếu.');
      if (title.length > 300) throw new Error('Tiêu đề câu chuyện vượt quá 300 ký tự.');
      if (content.length < 80) throw new Error('Nội dung câu chuyện quá ngắn hoặc bị thiếu.');

      if (!Array.isArray(parsed.parts)) throw new Error('JSON Gemini thiếu mảng parts.');
      if (parsed.parts.length !== expected) {
        throw new Error(`Gemini trả ${parsed.parts.length} part, cần đúng ${expected} part.`);
      }
      const parts = parsed.parts.map((item, index) => {
        const source = typeof item === 'string' ? { prompt: item } : (item || {});
        const prompt = String(source.prompt ?? source.videoPrompt ?? source.generationPrompt ?? source.description ?? '').trim();
        const partNumber = Number(source.partNumber ?? source.part ?? source.index ?? index + 1);
        if (partNumber !== index + 1) throw new Error(`Số thứ tự part không liên tục tại vị trí ${index + 1}.`);
        if (prompt.length < 40) throw new Error(`Prompt part ${partNumber} quá ngắn hoặc bị thiếu.`);
        if (prompt.length > 8000) throw new Error(`Prompt part ${partNumber} vượt quá 8.000 ký tự.`);
        return { ...ranges[index], prompt };
      });

      const summary = String(parsed.summary ?? title).trim();
      const globalContinuity = String(parsed.globalContinuity ?? parsed.consistency ?? '').trim();
      if (globalContinuity.length < 20) throw new Error('Gemini thiếu mô tả globalContinuity đủ chi tiết.');

      return {
        schemaVersion: 1,
        title,
        content,
        summary,
        globalContinuity,
        parts
      };
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError && !(lastError instanceof SyntaxError)) throw lastError;
  throw new Error(`Gemini không trả JSON câu chuyện hợp lệ${lastError ? `: ${lastError.message}` : '.'}`);
}

export function buildGeminiMasterWriterPrompt({
  userPrompt = '',
  outputLanguage = 'auto',
  duration = null,
  hasSource = false
}) {
  const storyLangInstruction = storyLanguageInstruction(outputLanguage);
  const contextInstruction = hasSource
    ? `Dựa trên video nguồn đã tải lên (thời lượng ~${Number(duration || 10).toFixed(1)} giây). Hãy quan sát kỹ từng chi tiết nhân vật, hành động, bối cảnh và cảm xúc để mở rộng thành một tác phẩm văn học hoàn chỉnh.`
    : userPrompt?.trim()
      ? `Chủ đề sáng tác: "${userPrompt.trim()}". Hãy phát triển ý tưởng này thành một kiệt tác văn học độc đáo.`
      : 'Hãy sáng tạo một tác phẩm văn học nghệ thuật độc bản, giàu tính triết lý, nhân văn và cuốn hút.';

  return [
    'BẠN LÀ MỘT NHÀ VĂN KIỆT XUẤT (MASTER LITERARY AUTHOR) với bút lực đỉnh cao, khả năng kể chuyện lôi cuốn, ngôn từ gợi hình, giàu nhạc điệu và chiều sâu cảm xúc.',
    'NHIỆM VỤ: Sáng tác một câu chuyện văn học đầy tính nghệ thuật. KHÔNG tạo video, KHÔNG tạo prompt video hay storyboard trong bước này. Hãy tập trung 100% tài năng của bạn vào tác phẩm văn chương.',
    contextInstruction,
    storyLangInstruction,
    'YÊU CẦU NGHỆ THUẬT:',
    '- Tiêu đề (title): Đặt một nhan đề đầy chất thơ, lôi cuốn và mang tính biểu tượng nghệ thuật cao.',
    '- Nội dung (content): Một tác phẩm truyện ngắn hoàn chỉnh, có bố cục nhiều đoạn văn phong phú (phân tách bằng dấu xuống dòng), miêu tả không gian tinh tế, khắc họa nội tâm nhân vật sâu sắc, xây dựng xung đột hoặc cao trào lôi cuốn, và đọng lại một kết thúc dư ba, ý nghĩa.',
    '- Độ dài: Viết đầy đủ, sâu sắc, không tóm tắt sơ sài, không rút ngắn hay cắt xén.',
    '',
    'Trả về đúng duy nhất 01 JSON object hợp lệ, không dùng Markdown code fences, không thêm văn bản ngoài JSON:',
    '{',
    '  "title": "Nhan đề nghệ thuật của tác phẩm",',
    '  "content": "Nội dung trọn vẹn của câu chuyện với đầy đủ các đoạn văn được phân tách bởi ký tự xuống dòng \\n\\n..."',
    '}'
  ].join('\n');
}

export function buildGeminiMasterWriterRepairPrompt(error, { outputLanguage = 'auto' } = {}) {
  const storyLangInstruction = storyLanguageInstruction(outputLanguage);
  return [
    `Phản hồi trước của bạn chưa hợp lệ: ${error.message}`,
    'Với vai trò Nhà văn kiệt xuất, hãy trả về duy nhất 01 JSON object hợp lệ chứa tác phẩm văn học đầy đủ:',
    storyLangInstruction,
    '{',
    '  "title": "Nhan đề nghệ thuật",',
    '  "content": "Nội dung truyện hoàn chỉnh nhiều đoạn văn phong phú..."',
    '}',
    'Không bọc trong Markdown code fences và không có văn bản giải thích.'
  ].join('\n');
}

export function parseGeminiMasterStory(text) {
  let lastError;
  for (const candidate of jsonCandidates(text)) {
    let parsed;
    try { parsed = JSON.parse(candidate); }
    catch (error) { lastError = error; continue; }
    try {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('JSON truyện phải là một object.');
      }
      const title = String(parsed.title ?? parsed.name ?? '').trim();
      const content = String(parsed.content ?? parsed.story ?? parsed.body ?? '').trim();
      if (!title) throw new Error('Truyện thiếu tiêu đề (title).');
      if (!content || content.length < 50) throw new Error('Nội dung truyện (content) quá ngắn hoặc bị thiếu.');
      return { title, content };
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError && !(lastError instanceof SyntaxError)) throw lastError;
  throw new Error(`Gemini không trả JSON truyện nghệ thuật hợp lệ${lastError ? `: ${lastError.message}` : '.'}`);
}

export function buildGeminiThumbnailPrompt({ title, content = '' }) {
  const summarySnippet = String(content || '').replace(/\s+/g, ' ').slice(0, 350);
  return [
    'Tạo một hình ảnh minh họa nghệ thuật điện ảnh chất lượng cao 16:9 (cinematic 16:9 featured artwork) làm ảnh đại diện cho tác phẩm văn học:',
    `Tiêu đề tác phẩm: "${title}"`,
    summarySnippet ? `Cốt lõi câu chuyện: "${summarySnippet}..."` : '',
    'Yêu cầu hình ảnh: Phong cách nghệ thuật giàu cảm xúc, góc máy điện ảnh hùng vĩ hoặc sâu lắng, ánh sáng chân thực tuyệt đẹp (masterpiece lighting, cinematic atmosphere, 8k resolution, award-winning illustration). KHÔNG vẽ bất kỳ chữ viết, typography, watermark hay ký tự nào trên hình ảnh.'
  ].filter(Boolean).join('\n');
}

export function buildGeminiStoryboardFromStoryPrompt({
  story,
  targetDuration,
  clipSeconds = DEFAULT_CLIP_SECONDS,
  aspectRatio = '16:9',
  outputLanguage = 'auto'
}) {
  const duration = Number(targetDuration);
  const step = clipLength(clipSeconds);
  const ranges = outputTimelineRanges(duration, step);
  const partCount = ranges.length;
  const languageInstruction = outputLanguage === 'auto'
    ? 'Choose the spoken/narration language that matches the literary story. Keep that language consistent in every part.'
    : videoLanguageInstruction(outputLanguage, { hasSource: false });
  const sampleRange = ranges[0];

  return [
    'CINEMATIC STORYBOARD ADAPTATION TASK. Do not generate video, images, or audio in Gemini. Return only valid JSON text.',
    'You are a master cinematic director adapting this completed literary story into a sequential video plan:',
    `TITLE: "${story.title}"`,
    `STORY CONTENT:\n${story.content}`,
    '',
    `Adapt this story visually into a ${duration.toFixed(0)}-second video sequence composed of exactly ${partCount} parts (${step} seconds each) at ${aspectRatio}.`,
    `Output language requirement for dialogue/narration: ${languageInstruction}`,
    `Required video timeline: ${JSON.stringify(ranges)}`,
    '',
    'Return exactly one valid JSON object and nothing else. Do not use Markdown fences.',
    '{',
    '  "schemaVersion": 1,',
    '  "globalContinuity": "precise reusable description of recurring subjects/characters, faces, hair, clothing, props, environment, lighting, color palette, camera language, and art style to maintain 100% visual consistency across all parts",',
    '  "parts": [',
    '    {',
    '      "partNumber": 1,',
    `      "startSeconds": ${sampleRange.startSeconds},`,
    `      "endSeconds": ${sampleRange.endSeconds},`,
    `      "prompt": "a self-contained English ${step}-second Grok video prompt for scene 1 adapting this moment of the story with exact action, characters matching globalContinuity, setting, camera motion, cinematic lighting, and mood; any spoken words or narration written verbatim in the required output language"`,
    '    }',
    '  ]',
    '}',
    '',
    'Rules:',
    `- The parts array must contain exactly ${partCount} items numbered 1 through ${partCount}.`,
    `- The sequence must faithfully translate the story arc (beginning, development, climax, resolution) across all ${partCount} parts.`,
    `- Each part prompt must be self-contained and detailed enough for independent Grok video generation, repeating essential continuity details from globalContinuity.`,
    `- Use double quotes, no comments, no trailing commas, and no text outside the JSON object.`
  ].join('\n');
}

export function buildGeminiStoryboardFromStoryRepairPrompt(error, { expectedParts, targetDuration, clipSeconds = DEFAULT_CLIP_SECONDS }) {
  return [
    `Your previous storyboard response could not be used: ${error.message}`,
    `Return a corrected JSON object only for the ${targetDuration}-second video adapted from the story.`,
    `It must contain "globalContinuity" and exactly ${expectedParts} parts in "parts" numbered 1 through ${expectedParts}.`,
    'Do not add Markdown fences or commentary.'
  ].join('\n');
}

export function parseGeminiStoryboardFromStory(text, { targetDuration, clipSeconds = DEFAULT_CLIP_SECONDS }) {
  const ranges = outputTimelineRanges(targetDuration, clipSeconds);
  const expected = ranges.length;
  let lastError;
  for (const candidate of jsonCandidates(text)) {
    let parsed;
    try { parsed = JSON.parse(candidate); }
    catch (error) { lastError = error; continue; }
    try {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('JSON kịch bản phân cảnh phải là một object.');
      }
      const root = parsed;
      if (!Array.isArray(root.parts)) throw new Error('JSON thiếu mảng parts.');
      if (root.parts.length !== expected) throw new Error(`Gemini trả ${root.parts.length} part, cần đúng ${expected} part.`);
      const parts = root.parts.map((item, index) => {
        const source = typeof item === 'string' ? { prompt: item } : (item || {});
        const prompt = String(source.prompt ?? source.videoPrompt ?? source.generationPrompt ?? source.description ?? '').trim();
        const partNumber = Number(source.partNumber ?? source.part ?? source.index ?? index + 1);
        if (partNumber !== index + 1) throw new Error(`Số thứ tự part không liên tục tại vị trí ${index + 1}.`);
        if (prompt.length < 40) throw new Error(`Prompt part ${partNumber} quá ngắn hoặc bị thiếu.`);
        if (prompt.length > 8000) throw new Error(`Prompt part ${partNumber} vượt quá 8.000 ký tự.`);
        return { ...ranges[index], prompt };
      });
      const globalContinuity = String(root.globalContinuity ?? root.consistency ?? '').trim();
      if (globalContinuity.length < 30) throw new Error('Gemini thiếu mô tả globalContinuity đủ chi tiết.');
      return {
        schemaVersion: 1,
        globalContinuity,
        parts
      };
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError && !(lastError instanceof SyntaxError)) throw lastError;
  throw new Error(`Gemini không trả JSON phân cảnh hợp lệ${lastError ? `: ${lastError.message}` : '.'}`);
}

export function buildGeminiAutoTopicPrompt({
  targetDuration,
  outputLanguage = 'auto',
  aspectRatio = '16:9',
  clipSeconds = DEFAULT_CLIP_SECONDS,
  currentDate = new Date().toISOString().slice(0, 10)
}) {
  const duration = Number(targetDuration);
  const step = clipLength(clipSeconds);
  const ranges = outputTimelineRanges(duration, step);
  const partCount = ranges.length;
  const languageInstruction = outputLanguage === 'auto'
    ? 'Choose the spoken/narration language that best fits the selected audience. Prefer Vietnamese for a general audience unless the trend clearly targets another language. Keep that language consistent in every part.'
    : videoLanguageInstruction(outputLanguage, { hasSource: false });
  const sampleRange = ranges[0];
  return [
    'CURRENT-TREND RESEARCH AND TEXT-ONLY STORYBOARD TASK. Do not generate video, images, or audio in Gemini.',
    `Today is ${currentDate}. Use Google Search now to research topics that are demonstrably trending or rapidly gaining public interest during the last 7 days. Do not rely only on model memory.`,
    'Compare several recent, credible public sources or trend signals. Pick one timely topic that can become an original, visually compelling short video. Do not copy a creator, copyrighted scene, trademarked character, misinformation, private tragedy, or dangerous challenge.',
    `The final video must be ${duration.toFixed(0)} seconds long at ${aspectRatio}. Create exactly ${partCount} storyboard parts, each rendered later as one independently generated ${step}-second clip.`,
    `Plan the hook, development, and payoff across the full ${duration.toFixed(0)} seconds. Give every part only the amount of action and speech that can naturally fit its own ${step}-second window.`,
    `Output language requirement: ${languageInstruction}`,
    `Required output timeline: ${JSON.stringify(ranges)}`,
    '',
    'After researching, return exactly one valid JSON object and nothing else. Do not use Markdown fences.',
    '{',
    '  "schemaVersion": 1,',
    '  "selectedTopic": "concise name of the timely topic selected after web research",',
    '  "trendRationale": "why this topic is timely now, stated cautiously and without fabricated metrics",',
    '  "sources": [',
    '    { "title": "recent source or trend signal", "url": "https://..." }',
    '  ],',
    '  "summary": "the complete original video story, including its hook and payoff",',
    '  "globalContinuity": "precise reusable description of recurring people or subjects, faces, wardrobe, props, environment, lighting, palette, camera language, visual style and audio identity",',
    '  "parts": [',
    '    {',
    '      "partNumber": 1,',
    `      "startSeconds": ${sampleRange.startSeconds},`,
    `      "endSeconds": ${sampleRange.endSeconds},`,
    `      "prompt": "a self-contained English ${step}-second video-generation prompt with exact action, subject identity, setting, camera, lighting, motion, transition and feasible audio; any dialogue or narration is written verbatim in the required output language"`,
    '    }',
    '  ]',
    '}',
    '',
    'Rules:',
    `- The parts array must contain exactly ${partCount} items numbered 1 through ${partCount}.`,
    `- Use the required output timeline exactly. Each part represents one full ${step}-second Grok clip.`,
    '- Part 1 must create an immediate visual hook. Middle parts must advance the same story. The final part must deliver a satisfying payoff or conclusion.',
    '- Each prompt must be self-contained. Repeat every identity-critical detail so independently generated clips remain visually and aurally consistent.',
    `- Apply this language rule to every part: ${languageInstruction}`,
    '- Keep all intentional on-screen text minimal because video generators often distort lettering.',
    '- Sources must contain only URLs actually consulted during this research. Never invent a URL or a popularity statistic.',
    '- Use double quotes, no comments, no trailing commas, and no text outside the JSON object.'
  ].join('\n');
}

export function buildGeminiStoryboardPrompt({
  duration, targetDuration = null, userInstruction = '', aspectRatio = null, outputLanguage = 'auto',
  clipSeconds = DEFAULT_CLIP_SECONDS
}) {
  const sourceDuration = Number(duration);
  const step = clipLength(clipSeconds);
  const outputDuration = targetDuration == null ? sourceDuration : Number(targetDuration);
  const ranges = sourceCoverageRanges(sourceDuration, targetDuration, step);
  const partCount = ranges.length;
  const instruction = userInstruction.trim() || 'Recreate the source video faithfully without adding unrelated scenes.';
  const languageInstruction = videoLanguageInstruction(outputLanguage, { hasSource: true });
  const sampleRange = ranges[0];
  return [
    'TEXT-ONLY ANALYSIS TASK. Do not create, edit, render, or generate any video, image, or audio in Gemini. Return only JSON text for use by a separate tool.',
    'Analyze the uploaded source video using both its visual and audio content.',
    `The source duration measured locally is ${sourceDuration.toFixed(2)} seconds.`,
    targetDuration == null ? '' : `The requested output duration is ${outputDuration.toFixed(0)} seconds. Compress or expand the source story across that duration without changing its essential order.`,
    `Create exactly ${partCount} storyboard parts, one for each source coverage range below.`,
    `A separate Grok step will later create ${partCount} full ${step}-second clips. Its final duration may differ from the requested duration by a fraction of a second.`,
    aspectRatio ? `The target aspect ratio is ${aspectRatio}.` : '',
    `Output language requirement: ${languageInstruction}`,
    `Additional user direction: ${instruction}`,
    `Required source coverage ranges: ${JSON.stringify(ranges)}`,
    '',
    'Write storyboard prompts for that separate tool. Return exactly one valid JSON object and nothing else. Do not use Markdown fences.',
    '{',
    '  "schemaVersion": 1,',
    '  "summary": "short factual summary of the whole source video",',
    '  "globalContinuity": "precise reusable description of recurring characters, faces, wardrobe, props, environment, lighting, color palette, camera language, visual style and audio identity",',
    '  "parts": [',
    '    {',
    '      "partNumber": 1,',
    `      "sourceStartSeconds": ${sampleRange.sourceStartSeconds},`,
    `      "sourceEndSeconds": ${sampleRange.sourceEndSeconds},`,
    '      "prompt": "a self-contained English video-generation prompt describing action, subject, setting, camera, lighting, style, motion, audio and the opening/closing transition for this source range"',
    '    }',
    '  ]',
    '}',
    '',
    'Rules:',
    `- The parts array must contain exactly ${partCount} items numbered 1 through ${partCount}.`,
    '- Use the required source coverage ranges exactly.',
    '- Each part prompt must be self-contained and detailed enough for independent text-to-video generation.',
    '- Repeat all identity-critical visual details in every part prompt. Do not refer to “the previous part” as the only description.',
    '- Preserve the source order, pacing, important actions, camera movement, ambient sound and transitions, subject to the language rule below.',
    `- Apply this language rule in every part: ${languageInstruction}`,
    '- Do not invent titles, captions, logos, watermarks, intros or outros unless they are clearly present in the source.',
    '- Use double quotes, no comments, no trailing commas, and output no text outside the JSON object.'
  ].filter(Boolean).join('\n');
}

function balancedCandidates(text) {
  const candidates = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{' && text[start] !== '[') continue;
    const stack = [];
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') { inString = true; continue; }
      if (character === '{' || character === '[') stack.push(character);
      if (character === '}' || character === ']') {
        const opening = stack.pop();
        if ((opening === '{' && character !== '}') || (opening === '[' && character !== ']')) break;
        if (!stack.length) {
          candidates.push(text.slice(start, index + 1));
          start = index;
          break;
        }
      }
    }
  }
  return candidates;
}

function jsonCandidates(text) {
  const fenced = [...String(text).matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1].trim());
  return [...fenced, ...balancedCandidates(String(text))];
}

export function parseGeminiStory(text) {
  let lastError;
  for (const candidate of jsonCandidates(text)) {
    let parsed;
    try { parsed = JSON.parse(candidate); }
    catch (error) { lastError = error; continue; }
    try {
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
        throw new Error('JSON câu chuyện phải là một object.');
      }
      const rawTitle = parsed.title ?? parsed.storyTitle;
      const rawContent = parsed.content ?? parsed.storyContent ?? parsed.narrative ?? parsed.body;
      if (typeof rawTitle !== 'string' || typeof rawContent !== 'string') {
        throw new Error('Gemini phải trả title và content dưới dạng chuỗi.');
      }
      const title = rawTitle.trim();
      const content = rawContent.trim();
      if (title.length < 3) throw new Error('Gemini chưa trả tiêu đề câu chuyện hợp lệ.');
      if (title.length > 300) throw new Error('Tiêu đề câu chuyện vượt quá 300 ký tự.');
      if (content.length < 80) throw new Error('Nội dung câu chuyện quá ngắn hoặc bị thiếu.');
      if (content.length > 100000) throw new Error('Nội dung câu chuyện vượt quá 100.000 ký tự.');
      return { title, content };
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError && !(lastError instanceof SyntaxError)) throw lastError;
  throw new Error(`Gemini không trả JSON câu chuyện hợp lệ${lastError ? `: ${lastError.message}` : '.'}`);
}

export function formatGeminiStoryText(story) {
  const title = String(story?.title ?? '').trim();
  const content = String(story?.content ?? '').trim();
  if (!title || !content) throw new Error('Không thể lưu câu chuyện vì thiếu tiêu đề hoặc nội dung.');
  return `Tiêu đề: ${title}\n\nNội dung:\n${content}\n`;
}

function normalizePart(item, index, range) {
  const source = typeof item === 'string' ? { prompt: item } : (item || {});
  const prompt = source.prompt ?? source.videoPrompt ?? source.generationPrompt ?? source.description;
  return {
    partNumber: Number(source.partNumber ?? source.part ?? source.index ?? index + 1),
    sourceStartSeconds: Number(source.sourceStartSeconds ?? source.startSeconds ?? range.sourceStartSeconds),
    sourceEndSeconds: Number(source.sourceEndSeconds ?? source.endSeconds ?? range.sourceEndSeconds),
    prompt: typeof prompt === 'string' ? prompt.trim() : ''
  };
}

export function parseGeminiStoryboard(text, { duration, targetDuration = null, clipSeconds = DEFAULT_CLIP_SECONDS }) {
  const ranges = sourceCoverageRanges(duration, targetDuration, clipSeconds);
  const expected = ranges.length;
  let parsed;
  let lastError;
  for (const candidate of jsonCandidates(text)) {
    try { parsed = JSON.parse(candidate); break; }
    catch (error) { lastError = error; }
  }
  if (parsed == null) throw new Error(`Gemini không trả JSON hợp lệ${lastError ? `: ${lastError.message}` : '.'}`);
  const root = Array.isArray(parsed) ? { parts: parsed } : parsed;
  if (!Array.isArray(root.parts)) throw new Error('JSON Gemini thiếu mảng parts.');
  const parts = root.parts.map((item, index) => normalizePart(item, index, ranges[index]));
  if (parts.length !== expected) throw new Error(`Gemini trả ${parts.length} part, cần đúng ${expected} part.`);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part.partNumber !== index + 1) throw new Error(`Số thứ tự part không liên tục tại vị trí ${index + 1}.`);
    if (part.prompt.length < 40) throw new Error(`Prompt part ${part.partNumber} quá ngắn hoặc bị thiếu.`);
    if (part.prompt.length > 8000) throw new Error(`Prompt part ${part.partNumber} vượt quá 8.000 ký tự.`);
    part.sourceStartSeconds = ranges[index].sourceStartSeconds;
    part.sourceEndSeconds = ranges[index].sourceEndSeconds;
  }
  const globalContinuity = String(root.globalContinuity ?? root.consistency ?? '').trim();
  if (globalContinuity.length < 30) throw new Error('Gemini thiếu mô tả globalContinuity đủ chi tiết.');
  return {
    schemaVersion: 1,
    summary: String(root.summary ?? '').trim(),
    globalContinuity,
    parts
  };
}

function normalizeTrendSource(source) {
  if (typeof source === 'string') return /^https?:\/\//i.test(source.trim()) ? { title: '', url: source.trim() } : null;
  if (!source || typeof source !== 'object') return null;
  const url = String(source.url ?? source.link ?? '').trim();
  if (!/^https?:\/\//i.test(url)) return null;
  const normalized = {
    title: String(source.title ?? source.name ?? '').trim(),
    url
  };
  const publishedAt = String(source.publishedAt ?? source.date ?? '').trim();
  if (publishedAt) normalized.publishedAt = publishedAt;
  return normalized;
}

export function parseGeminiAutoTopicPlan(text, { targetDuration, clipSeconds = DEFAULT_CLIP_SECONDS }) {
  const ranges = outputTimelineRanges(targetDuration, clipSeconds);
  const expected = ranges.length;
  let lastError;
  for (const candidate of jsonCandidates(text)) {
    let parsed;
    try { parsed = JSON.parse(candidate); }
    catch (error) { lastError = error; continue; }
    try {
      const root = Array.isArray(parsed) ? { parts: parsed } : parsed;
      if (!Array.isArray(root.parts)) throw new Error('JSON Gemini thiếu mảng parts.');
      if (root.parts.length !== expected) throw new Error(`Gemini trả ${root.parts.length} part, cần đúng ${expected} part.`);
      const parts = root.parts.map((item, index) => {
        const source = typeof item === 'string' ? { prompt: item } : (item || {});
        const prompt = String(source.prompt ?? source.videoPrompt ?? source.generationPrompt ?? source.description ?? '').trim();
        const partNumber = Number(source.partNumber ?? source.part ?? source.index ?? index + 1);
        if (partNumber !== index + 1) throw new Error(`Số thứ tự part không liên tục tại vị trí ${index + 1}.`);
        if (prompt.length < 40) throw new Error(`Prompt part ${partNumber} quá ngắn hoặc bị thiếu.`);
        if (prompt.length > 8000) throw new Error(`Prompt part ${partNumber} vượt quá 8.000 ký tự.`);
        return { ...ranges[index], prompt };
      });
      const summary = String(root.summary ?? '').trim();
      if (summary.length < 20) throw new Error('Gemini thiếu summary đủ chi tiết.');
      const globalContinuity = String(root.globalContinuity ?? root.consistency ?? '').trim();
      if (globalContinuity.length < 30) throw new Error('Gemini thiếu mô tả globalContinuity đủ chi tiết.');
      const selectedTopic = String(root.selectedTopic ?? root.topic ?? '').trim();
      if (selectedTopic.length < 5) throw new Error('Gemini chưa nêu rõ chủ đề xu hướng đã chọn.');
      const trendRationale = String(root.trendRationale ?? root.rationale ?? '').trim();
      if (trendRationale.length < 20) throw new Error('Gemini chưa giải thích đủ căn cứ xu hướng hiện tại.');
      const sources = (Array.isArray(root.sources) ? root.sources : []).map(normalizeTrendSource).filter(Boolean);
      if (!sources.length) throw new Error('Gemini chưa cung cấp nguồn web hợp lệ cho chủ đề xu hướng.');
      return {
        schemaVersion: 1,
        selectedTopic,
        trendRationale,
        sources,
        summary,
        globalContinuity,
        parts
      };
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError && !(lastError instanceof SyntaxError)) throw lastError;
  throw new Error(`Gemini không trả JSON hợp lệ${lastError ? `: ${lastError.message}` : '.'}`);
}

export function buildGeminiAutoTopicRepairPrompt(error, { expectedParts, targetDuration, currentDate, clipSeconds = DEFAULT_CLIP_SECONDS }) {
  return [
    `Your previous trend storyboard could not be used: ${error.message}`,
    `Today is ${currentDate}. Return the complete corrected JSON object for the ${targetDuration}-second video.`,
    `It must contain exactly ${expectedParts} parts numbered 1 through ${expectedParts}, with one feasible self-contained ${clipLength(clipSeconds)}-second prompt per part.`,
    'It must also contain a non-empty selectedTopic, a factual trendRationale, summary, detailed globalContinuity, and at least one valid http(s) source URL actually consulted through Google Search.',
    'Do not invent a URL, citation, popularity metric, or claim. Use only the trend research already performed in this conversation.',
    'Return JSON only, without Markdown or commentary.'
  ].join('\n');
}

export function buildGeminiRepairPrompt(error, expectedParts) {
  return [
    `Your previous response could not be used: ${error.message}`,
    `Return a corrected JSON object only. It must contain exactly ${expectedParts} parts numbered 1 through ${expectedParts}.`,
    'Keep every prompt self-contained and keep globalContinuity detailed. Do not add Markdown or commentary.'
  ].join('\n');
}

const REFERENCE_ROLE_TEXT = Object.freeze({
  user: 'a reference supplied by the user — keep this subject identity, wardrobe, and art style',
  source_frame: 'a still frame from the source video for this exact part — match its subject identity, wardrobe, setting, framing, and color grading',
  previous_tail: 'the final frame of the previous clip — begin this clip from that exact state so the two join seamlessly'
});

export function referenceImageInstruction(references = []) {
  if (!references.length) return '';
  const described = references
    .map((reference, index) => `${index + 1}) ${REFERENCE_ROLE_TEXT[reference.role] || 'a visual reference'}`)
    .join('; ');
  return [
    `REFERENCE IMAGES (attached in this order): ${described}.`,
    'Use them for identity, styling, and continuity only. Animate a new shot for the full clip length — do not return a frozen frame, a slideshow, a pan over a still, a collage, a border, or any caption taken from these images.'
  ].join(' ');
}

function referenceFields(references = []) {
  return {
    referencePaths: references.map((reference) => reference.path),
    referenceRoles: references.map((reference) => reference.role)
  };
}

export function buildGrokTextPartJob(job, plan, index, { references = [] } = {}) {
  const storyboardPart = plan.parts[index];
  const partNumber = index + 1;
  if (!storyboardPart) throw new Error(`Không có storyboard part ${partNumber}.`);
  return {
    ...job,
    sourcePath: null,
    ...referenceFields(references),
    prompt: [
      `Create exactly one ${clipLength(job.clipSeconds)}-second video clip at the highest available quality. Prefer 1080p; use 720p when 1080p is unavailable.`,
      `This is storyboard part ${partNumber}/${plan.parts.length}, representing source seconds ${storyboardPart.sourceStartSeconds}-${storyboardPart.sourceEndSeconds}.`,
      `GLOBAL CONTINUITY — reproduce these visual, identity, and non-speech audio details exactly; speech follows the LANGUAGE rule below: ${plan.globalContinuity}`,
      `THIS PART: ${storyboardPart.prompt}`,
      referenceImageInstruction(references),
      `LANGUAGE: ${videoLanguageInstruction(job.language || 'auto', { hasSource: true })}`,
      'No extra title, caption, logo, watermark, intro or outro. Use a natural opening and ending suitable for seamless concatenation.'
    ].filter(Boolean).join('\n\n')
  };
}

export function buildGrokTopicPartJob(job, index, totalParts, { references = [] } = {}) {
  const partNumber = index + 1;
  const position = totalParts === 1
    ? 'Tell the complete scene naturally within this clip.'
    : partNumber === 1
      ? 'Establish the recurring subject, setting, lighting, and motion. End on an action that can continue into the next clip.'
      : partNumber === totalParts
        ? 'Continue with exactly the same recurring identities and visual language, then give the sequence a natural conclusion.'
        : 'Continue the central action with exactly the same recurring identities, wardrobe, setting, lighting, palette, and camera language.';
  return {
    ...job,
    sourcePath: null,
    ...referenceFields(references),
    prompt: [
      `Create exactly one ${clipLength(job.clipSeconds)}-second video clip at the highest available quality. Prefer 1080p; use 720p when 1080p is unavailable.`,
      totalParts > 1 ? `This is storyboard part ${partNumber}/${totalParts} of a ${totalParts * clipLength(job.clipSeconds)}-second sequence.` : '',
      `STORY CONCEPT: ${job.prompt}`,
      position,
      referenceImageInstruction(references),
      `LANGUAGE: ${videoLanguageInstruction(job.language || 'auto', { hasSource: false })}`,
      'Do not add an unrelated title, caption, logo, watermark, intro, or outro.'
    ].filter(Boolean).join('\n\n')
  };
}

export function buildGrokAutoTopicPartJob(job, plan, index, { references = [] } = {}) {
  const storyboardPart = plan.parts[index];
  const partNumber = index + 1;
  if (!storyboardPart) throw new Error(`Không có storyboard part ${partNumber}.`);
  const languageRule = (job.language || 'auto') === 'auto'
    ? 'Follow the exact spoken, narration, and intentional text language specified in this Gemini storyboard. Keep it unchanged across every part.'
    : videoLanguageInstruction(job.language, { hasSource: false });
  return {
    ...job,
    sourcePath: null,
    ...referenceFields(references),
    prompt: [
      `Create exactly one ${clipLength(job.clipSeconds)}-second video clip at the highest available quality. Prefer 1080p; use 720p when 1080p is unavailable.`,
      `This is storyboard part ${partNumber}/${plan.parts.length}, covering final video seconds ${storyboardPart.startSeconds}-${storyboardPart.endSeconds}.`,
      `ORIGINAL TREND-INSPIRED STORY: ${plan.selectedTopic || plan.summary}`,
      `GLOBAL CONTINUITY — reproduce these identities, visual details, and non-speech audio details exactly: ${plan.globalContinuity}`,
      `THIS PART: ${storyboardPart.prompt}`,
      referenceImageInstruction(references),
      `LANGUAGE: ${languageRule}`,
      'No extra title, caption, logo, watermark, intro, or outro. Preserve the planned opening and ending transition for seamless concatenation.'
    ].filter(Boolean).join('\n\n')
  };
}

export function buildGrokTopicStoryPartJob(job, plan, index, { references = [] } = {}) {
  const storyboardPart = plan.parts[index];
  const partNumber = index + 1;
  if (!storyboardPart) throw new Error(`Không có storyboard part ${partNumber}.`);
  const languageRule = (job.language || 'auto') === 'auto'
    ? 'Follow the exact spoken, narration, and intentional text language specified in this story storyboard. Keep it unchanged across every part.'
    : videoLanguageInstruction(job.language, { hasSource: false });
  return {
    ...job,
    sourcePath: null,
    ...referenceFields(references),
    prompt: [
      `Create exactly one ${clipLength(job.clipSeconds)}-second video clip at the highest available quality. Prefer 1080p; use 720p when 1080p is unavailable.`,
      `This is storyboard part ${partNumber}/${plan.parts.length}, covering final video seconds ${storyboardPart.startSeconds}-${storyboardPart.endSeconds}.`,
      `ORIGINAL STORY SCENE: ${plan.title || job.prompt}`,
      `GLOBAL CONTINUITY — reproduce these identities, visual details, and non-speech audio details exactly: ${plan.globalContinuity}`,
      `THIS PART: ${storyboardPart.prompt}`,
      referenceImageInstruction(references),
      `LANGUAGE: ${languageRule}`,
      'No extra title, caption, logo, watermark, intro, or outro. Preserve the planned opening and ending transition for seamless concatenation.'
    ].filter(Boolean).join('\n\n')
  };
}

export { formatTimestamp };

