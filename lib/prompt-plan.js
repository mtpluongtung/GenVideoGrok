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

export const MIN_STORY_WORDS = 2000;
export const MIN_STORY_WORDS_RETRY = 1500;

export function countWords(text) {
  if (!text || typeof text !== 'string') return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function buildVideoDescriptionPrompt({
  duration,
  userInstruction = '',
  outputLanguage = 'auto'
} = {}) {
  const sourceDuration = Math.max(0.01, Number(duration) || 0.01);
  const langLabel = videoLanguageLabel(outputLanguage);
  const langNote = outputLanguage === 'auto'
    ? 'Viết bản phân tích bằng Tiếng Việt chuẩn xác, rõ ràng.'
    : `Viết bản phân tích bằng ${langLabel}.`;

  const userNote = userInstruction?.trim()
    ? `Lưu ý thêm từ người dùng: "${userInstruction.trim()}".`
    : '';

  return [
    'BẠN LÀ CHUYÊN GIA PHÂN TÍCH HÌNH ẢNH VÀ NỘI DUNG VIDEO (EXPERT VIDEO ANALYST).',
    `Hãy xem kỹ các ảnh ghép khung hình đã tải lên, được trích đều từ video nguồn dài ~${sourceDuration.toFixed(1)} giây; mỗi ảnh là một lưới khung hình đọc từ trái sang phải, trên xuống dưới theo thứ tự thời gian.`,
    userNote,
    langNote,
    'NHIỆM VỤ: Phân tích toàn diện và mô tả chi tiết, chân thực 100% nội dung của video này. Bám sát tối đa từng chi tiết vi mô, không bỏ sót các khoảnh khắc quan trọng.',
    'Hãy trình bày bản mô tả nội dung video theo cấu trúc đầy đủ sau:',
    '1. CHỦ THỂ & NHÂN VẬT: Ai hoặc cái gì là trung tâm của video? (Mô tả tỉ mỉ ngoại hình, độ tuổi, vóc dáng, trang phục, màu sắc/chất liệu vải, kiểu tóc, màu da, khuôn mặt, ánh mắt, cử chỉ tay, dáng đi, vi biểu cảm xúc động hoặc biến đổi nét mặt).',
    '2. BỐI CẢNH & KHÔNG GIAN: Video diễn ra ở đâu? (Chi tiết không gian trong nhà hay ngoài trời, kiến trúc, đồ vật xung quanh, đạo cụ tương tác, thời tiết, hướng ánh sáng, nhiệt độ màu, bảng màu chủ đạo).',
    '3. DIỄN BIẾN HÀNH ĐỘNG THEO THỜI GIAN: Mô tả chi tiết trình tự hành động diễn ra từ đầu video, giữa video đến cuối video.',
    '4. ÂM THANH & THOẠI (BẮT BUỘC): Phân tích kỹ cử chỉ, chuyển động môi/khẩu hình miệng, nét mặt và tình huống của nhân vật trong từng khung hình để tái hiện đầy đủ lời thoại, câu nói hoặc tiếng lòng của nhân vật. Ghi rõ nguyên văn từng câu thoại trong dấu ngoặc kép kèm cảm xúc và khẩu hình phát âm (ví dụ: Cậu bé ngước nhìn người đàn ông nói: "Cảm ơn chú"). Ghi nhận cả tiếng động môi trường, bối cảnh xung quanh để tạo nên bức tranh âm thanh sống động.',
    '5. THÔNG ĐIỆP & TỔNG KẾT: Ý nghĩa câu chuyện, mạch cảm xúc chủ đạo và phong cách nghệ thuật của video.',
    'Yêu cầu: Trả về văn bản phân tích rõ ràng, mạch lạc, giàu chi tiết thị giác và bám sát thực tế của video.'
  ].filter(Boolean).join('\n');
}

export function parseVideoDescription(text) {
  if (!text || typeof text !== 'string') {
    throw new Error('ChatGPT chưa trả về văn bản mô tả nội dung video.');
  }
  const clean = text.trim();
  if (clean.length < 50) {
    throw new Error('Nội dung mô tả video quá ngắn hoặc bị thiếu.');
  }
  return clean;
}

export function buildStoryPrompt({
  duration,
  outputLanguage = 'auto',
  videoDescription = '',
  videoSummary = '',
  globalContinuity = '',
  planParts = [],
  userPrompt = ''
}) {
  const sourceDuration = Math.max(0.01, Number(duration) || 0.01);
  const storyLangInstruction = storyLanguageInstruction(outputLanguage);

  const contextLines = [];
  if (userPrompt?.trim()) {
    contextLines.push(`USER INSTRUCTION / CHỦ ĐỀ: "${userPrompt.trim()}".`);
  }
  if (videoDescription?.trim()) {
    contextLines.push(`NỘI DUNG CHI TIẾT CỦA VIDEO NGUỒN (ĐÃ ĐƯỢC PHÂN TÍCH):\n${videoDescription.trim()}`);
  }
  if (videoSummary?.trim()) {
    contextLines.push(`TÓM TẮT NỘI DUNG VIDEO NGUỒN: "${videoSummary.trim()}".`);
  }
  if (globalContinuity?.trim()) {
    contextLines.push(`CHỦ THỂ, NHÂN VẬT VÀ BỐI CẢNH THỊ GIÁC: "${globalContinuity.trim()}".`);
  }
  if (Array.isArray(planParts) && planParts.length > 0) {
    const partsSnippets = planParts
      .slice(0, 5)
      .map((p, idx) => `  - Cảnh ${idx + 1}: ${String(p.prompt || '').slice(0, 200)}...`)
      .join('\n');
    contextLines.push(`DIỄN BIẾN CÁC CẢNH TRONG VIDEO:\n${partsSnippets}`);
  }

  return [
    'STANDALONE TEXT STORY TASK GROUNDED IN SOURCE VIDEO. Analyze the uploaded contact-sheet frames sampled from the source video. The original audio is not available. Do not generate or edit video, images, or audio.',
    `The source video duration measured locally is ${sourceDuration.toFixed(2)} seconds.`,
    'The story must be closely grounded in the source video: characters, setting, important actions, event order, and emotional tone.',
    'MANDATORY MINIMUM LENGTH: The story content MUST BE OVER 2,000 WORDS (tối thiểu trên 2.000 từ). Do not provide a summary or brief scene.',
    contextLines.length > 0
      ? ['\n--- THÔNG TIN XÁC THỰC TỪ VIDEO NGUỒN (BẮT BUỘC BÁM SÁT) ---', ...contextLines, '-----------------------------------------------------------\n'].join('\n')
      : '',
    'YÊU CẦU BẮT BUỘC VỀ BỐI CẢNH VÀ NỘI DUNG (STRICT GROUNDING):',
    '1. KHÔNG LẠC ĐỀ: Câu chuyện BẮT BUỘC PHẢI KHỚP 100% với nội dung, nhân vật, bối cảnh và hành động xuất hiện trong video.',
    '   - Tuyệt đối KHÔNG tự ý sáng tác ra một câu chuyện hoàn toàn không liên quan (ví dụ: video làm đẹp, chăm sóc da thì câu chuyện phải về nhân vật đó, công việc, thói quen chăm sóc bản thân, sự tự tin...; TUYỆT ĐỐI KHÔNG viết về thám hiểm rừng rậm, đầm lầy, cá sấu, chiến tranh hay những thứ không có trong video).',
    '   - Nếu video có người, hãy lấy người đó làm nhân vật chính. Nếu video về sản phẩm, đồ vật, động vật hoặc phong cảnh, hãy xây dựng câu chuyện xoay quanh chính chủ thể đó.',
    '2. CÁCH PHÁT TRIỂN CÂU CHUYỆN TRÊN 2.000 TỪ TỪ VIDEO NGẮN:',
    '   - Đặt tên cho nhân vật trong video, khắc họa xuất thân, nghề nghiệp, tính cách, những trăn trở hoặc động lực sống của họ.',
    '   - Miêu tả chi tiết từng cử chỉ, ánh sáng, cảm giác xúc giác, không gian tĩnh lặng và dòng độc thoại nội tâm của nhân vật trong khoảnh khắc của video.',
    '   - Mở rộng dòng thời gian trước và sau: những thử thách, một ngày bận rộn trước đó dẫn đến khoảnh khắc này -> giây phút tĩnh tâm, chăm sóc hoặc tập trung cao độ trong video -> và sự chuyển biến tích cực, niềm tin mới sau khoảnh khắc đó.',
    '   - Đưa vào các đoạn hội thoại tự nhiên với đồng nghiệp, bạn bè, người thân hoặc độc thoại nội tâm để làm giàu cảm xúc cho câu chuyện.',
    '3. ĐỘ DÀI BẮT BUỘC: Câu chuyện PHẢI DÀI TRÊN 2.000 TỪ (tối thiểu trên 2.000 words). Không tóm tắt sơ sài, không cắt ngắn.',
    '   - Chia tác phẩm thành 5 đến 8 phân đoạn chi tiết, phân tách rõ ràng bằng hai dấu xuống dòng (\\n\\n).',
    storyLangInstruction,
    '',
    'QUY TẮC ĐỊNH DẠNG JSON VÀ LỜI THOẠI (JSON SAFETY):',
    JSON_CODE_BLOCK_RULE,
    '- QUAN TRỌNG: Khi viết lời thoại của nhân vật trong trường "content", BẮT BUỘC DÙNG DẤU NGOẶC KÉP CONG “ ” HOẶC DẤU NHÁY ĐƠN \' \' (ví dụ: “Chào bạn”, \'Chào bạn\'). TUYỆT ĐỐI KHÔNG dùng dấu ngoặc kép thẳng " để tránh gây lỗi cú pháp JSON.',
    '{',
    '  "title": "Nhan đề cuốn hút và bám sát trực tiếp vào câu chuyện của video",',
    '  "content": "Toàn bộ tác phẩm văn học trên 2.000 từ bám sát video nguồn với các đoạn văn phân tách bằng \\\\n\\\\n..."',
    '}',
    'Tiêu đề và nội dung đều không được để trống. Không trả thêm bất kỳ văn bản nào ngoài JSON object này.'
  ].filter(Boolean).join('\n');
}

export function buildStoryRepairPrompt(error, {
  outputLanguage = 'auto',
  attempt = 2,
  videoDescription = '',
  videoSummary = '',
  globalContinuity = ''
} = {}) {
  const storyLangInstruction = storyLanguageInstruction(outputLanguage);
  const errorMsg = String(error?.message || '');
  const isJsonError = /JSON|SyntaxError|Expected|position|token|quote/i.test(errorMsg);
  const isLengthError = /ngắn|short|từ|words/i.test(errorMsg);

  const errorHints = [];
  if (isJsonError) {
    errorHints.push('- LỖI CÚ PHÁP JSON: Phản hồi trước bị lỗi do chứa dấu ngoặc kép thẳng " chưa escape trong lời thoại. Trong lời thoại, HÃY DÙNG DẤU NGOẶC KÉP CONG “ ” HOẶC DẤU NHÁY ĐƠN \' \' thay cho dấu ngoặc kép thẳng.');
  }
  if (isLengthError) {
    errorHints.push('- LỖI ĐỘ DÀI: Nội dung quá ngắn. YÊU CẦU BẮT BUỘC PHẢI VIẾT TRÊN 2.000 TỪ (hơn 2.000 words), đào sâu bối cảnh và diễn biến.');
  }
  if (videoDescription?.trim()) {
    errorHints.push(`- BÁM SÁT NỘI DUNG VIDEO: Câu chuyện phải trực tiếp xoay quanh nội dung video đã phân tích: "${videoDescription.slice(0, 200).trim()}...". Tuyệt đối không viết chuyện lạc đề.`);
  } else if (videoSummary?.trim()) {
    errorHints.push(`- BÁM SÁT VIDEO: Câu chuyện phải trực tiếp xoay quanh nội dung: "${videoSummary.trim()}". Tuyệt đối không viết chuyện lạc đề.`);
  }

  if (attempt >= 3) {
    return [
      `Phản hồi trước của bạn gặp lỗi: ${errorMsg}`,
      ...errorHints,
      storyLangInstruction,
      'Để tránh hoàn toàn lỗi cú pháp JSON, hãy trả về toàn bộ tác phẩm theo ĐÚNG ĐỊNH DẠNG VĂN BẢN ĐƠN GIẢN sau (không dùng JSON, không dùng code fence):',
      'Tiêu đề: [Nhan đề tác phẩm bám sát video]',
      'Nội dung:',
      '[Toàn bộ tác phẩm truyện trên 2.000 từ bám sát video nguồn, nhiều đoạn văn phân tách bằng hai dấu xuống dòng]'
    ].join('\n');
  }

  return [
    `Your previous story response could not be used: ${errorMsg}`,
    ...errorHints,
    'Using the source frames and video description already present in this conversation, return the complete corrected story again.',
    'MANDATORY LENGTH REQUIREMENT: The story MUST BE OVER 2,000 WORDS (bắt buộc độ dài tối thiểu trên 2.000 từ). Do not summarize or truncate. Expand with rich descriptive paragraphs, detailed dialogues (using curly quotes “ ” or single quotes \' \'), character psychology, and vivid world-building matching the video.',
    storyLangInstruction,
    'Return exactly one valid JSON object with two non-empty string fields: "title" and "content".',
    '{',
    '  "title": "Nhan đề bám sát video",',
    '  "content": "Toàn bộ tác phẩm trên 2.000 từ bám sát video, lời thoại dùng ngoặc kép cong “ ”..."',
    '}',
    'Do not return a storyboard, prompts, timestamps, or commentary outside the code block.',
    JSON_CODE_BLOCK_RULE
  ].join('\n');
}

export function buildTopicStoryPrompt({
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
    'STORY WRITING AND MULTI-PART VIDEO STORYBOARD TASK. Do not generate video, images, or audio. Return only valid JSON text.',
    userPrompt.trim()
      ? `Write an engaging, complete, full-length prose story based on this topic: "${userPrompt.trim()}".`
      : 'Create an engaging, original, complete viral prose story with compelling characters, clear conflict, emotional depth, and a memorable conclusion.',
    'MANDATORY MINIMUM LENGTH: The prose story content MUST BE OVER 2,000 WORDS (tối thiểu trên 2.000 từ). Do not provide a summary or brief scene. Write an extensive, multi-chapter narrative with rich dialogue, character psychology, and world-building.',
    storyLangInstruction,
    `The story must also be adapted into a ${duration.toFixed(0)}-second video composed of exactly ${partCount} parts (${step} seconds each) at ${aspectRatio}.`,
    `Output language requirement for dialogue/narration: ${languageInstruction}`,
    `Required video timeline: ${JSON.stringify(ranges)}`,
    '',
    'Return exactly one valid JSON object and nothing else.',
    JSON_CODE_BLOCK_RULE,
    '{',
    '  "schemaVersion": 1,',
    '  "title": "a captivating, non-empty story title in the requested story language",',
    '  "content": "the complete, multi-paragraph prose narrative story exceeding 2,000 words written with rich description, dialogues, and emotional depth in the requested story language; separate paragraphs with newlines (\\\\n\\\\n)",',
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
    `- "content" must be a full, detailed prose story exceeding 2,000 words (tối thiểu trên 2.000 từ) written in the required language (${storyLangInstruction}).`,
    `- The parts array must contain exactly ${partCount} items numbered 1 through ${partCount}.`,
    `- Each part prompt must be self-contained and detailed enough for independent Grok video generation, repeating essential continuity details from globalContinuity.`,
    `- Use double quotes, no comments, no trailing commas, and no text outside the JSON object.`
  ].join('\n');
}

export function buildTopicStoryRepairPrompt(error, { expectedParts, targetDuration, outputLanguage = 'auto', clipSeconds = DEFAULT_CLIP_SECONDS }) {
  const storyLangInstruction = storyLanguageInstruction(outputLanguage);
  return [
    `Your previous response could not be used: ${error.message}`,
    `Return a corrected JSON object only for the ${targetDuration}-second video.`,
    `It must contain a non-empty "title", a rich prose "content" exceeding 2,000 words (trên 2.000 từ) written in ${storyLangInstruction}, a "summary", "globalContinuity", and exactly ${expectedParts} parts in "parts" numbered 1 through ${expectedParts}.`,
    JSON_CODE_BLOCK_RULE
  ].join('\n');
}

export function parseTopicStoryPlan(text, { targetDuration, clipSeconds = DEFAULT_CLIP_SECONDS, minWords = 0 } = {}) {
  const ranges = outputTimelineRanges(targetDuration, clipSeconds);
  const expected = ranges.length;
  let lastError;
  for (const candidate of jsonCandidates(text)) {
    let parsed;
    try { parsed = parseLenientJson(candidate); }
    catch (error) { lastError = error; continue; }
    try {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('JSON kịch bản câu chuyện phải là một object.');
      }
      const rawTitle = parsed.title ?? parsed.storyTitle;
      const rawContent = parsed.content ?? parsed.storyContent ?? parsed.narrative ?? parsed.body;
      if (typeof rawTitle !== 'string' || typeof rawContent !== 'string') {
        throw new Error('ChatGPT phải trả title và content câu chuyện dưới dạng chuỗi.');
      }
      const title = rawTitle.trim();
      const content = rawContent.trim();
      if (title.length < 3) throw new Error('Tiêu đề câu chuyện quá ngắn hoặc bị thiếu.');
      if (title.length > 300) throw new Error('Tiêu đề câu chuyện vượt quá 300 ký tự.');
      if (content.length < 80) throw new Error('Nội dung câu chuyện quá ngắn hoặc bị thiếu.');
      const wordCount = countWords(content);
      if (minWords > 0 && wordCount < minWords) {
        throw new Error(`Nội dung câu chuyện quá ngắn (${wordCount} từ). Yêu cầu tối thiểu trên ${minWords} từ.`);
      }

      if (!Array.isArray(parsed.parts)) throw new Error('JSON ChatGPT thiếu mảng parts.');
      if (parsed.parts.length !== expected) {
        throw new Error(`ChatGPT trả ${parsed.parts.length} part, cần đúng ${expected} part.`);
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
      if (globalContinuity.length < 20) throw new Error('ChatGPT thiếu mô tả globalContinuity đủ chi tiết.');

      return {
        schemaVersion: 1,
        title,
        content,
        wordCount,
        summary,
        globalContinuity,
        parts
      };
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError && !(lastError instanceof SyntaxError)) throw lastError;
  throw new Error(`ChatGPT không trả JSON câu chuyện hợp lệ${lastError ? `: ${lastError.message}` : '.'}`);
}

export function buildMasterWriterPrompt({
  userPrompt = '',
  outputLanguage = 'auto',
  duration = null,
  hasSource = false,
  videoSummary = '',
  globalContinuity = '',
  planParts = []
}) {
  const storyLangInstruction = storyLanguageInstruction(outputLanguage);

  let contextInstruction = '';
  if (hasSource) {
    const details = [];
    if (videoSummary?.trim()) details.push(`Tóm tắt nội dung video: "${videoSummary.trim()}".`);
    if (globalContinuity?.trim()) details.push(`Nhân vật, chủ thể và bối cảnh: "${globalContinuity.trim()}".`);
    if (Array.isArray(planParts) && planParts.length > 0) {
      const snippets = planParts.slice(0, 3).map((p, i) => `Cảnh ${i + 1}: ${String(p.prompt || '').slice(0, 150)}...`).join('; ');
      details.push(`Diễn biến các cảnh: ${snippets}.`);
    }
    contextInstruction = `Dựa trên các khung hình trích từ video nguồn đã tải lên (thời lượng ~${Number(duration || 10).toFixed(1)} giây). ${details.join(' ')}\nQUY TẮC CỐT LÕI: Tác phẩm văn học BẮT BUỘC phải bám sát trực tiếp vào đúng nhân vật, bối cảnh, hành động và thông điệp của video trên. Tuyệt đối KHÔNG sáng tác một câu chuyện đi lệch chủ đề (ví dụ: video làm đẹp/chăm sóc da/thời trang thì phải viết về nhân vật đó, sự chăm sóc bản thân, công việc, tâm lý, lối sống; KHÔNG viết về thám hiểm rừng rậm, đầm lầy, cá sấu, chiến tranh...).`;
  } else if (userPrompt?.trim()) {
    contextInstruction = `Chủ đề sáng tác: "${userPrompt.trim()}". Hãy phát triển ý tưởng này thành một kiệt tác văn học trường đoạn đồ sộ và độc đáo.`;
  } else {
    contextInstruction = 'Hãy sáng tạo một tác phẩm văn học nghệ thuật trường đoạn độc bản, giàu tính triết lý, nhân văn và cuốn hút.';
  }

  return [
    'BẠN LÀ MỘT NHÀ VĂN KIỆT XUẤT (MASTER LITERARY AUTHOR) với bút lực đỉnh cao, khả năng kể chuyện lôi cuốn, ngôn từ gợi hình, giàu nhạc điệu và chiều sâu cảm xúc.',
    'NHIỆM VỤ: Sáng tác một tác phẩm văn học trường thiên hoàn chỉnh, sâu sắc và đầy tính nghệ thuật. KHÔNG tạo video, KHÔNG tạo prompt video hay storyboard trong bước này. Hãy tập trung 100% tài năng của bạn vào tác phẩm văn chương.',
    contextInstruction,
    storyLangInstruction,
    'YÊU CẦU NGHỆ THUẬT VÀ ĐỘ DÀI BẮT BUỘC:',
    '- ĐỘ DÀI BẮT BUỘC: Tác phẩm PHẢI CÓ ĐỘ DÀI TRÊN 2.000 TỪ (tối thiểu trên 2.000 words). Tuyệt đối KHÔNG tóm tắt, không viết sơ sài, không rút ngắn hay cắt xén câu chuyện.',
    '- KẾT CẤU VÀ DUNG LƯỢNG TRƯỜNG ĐOẠN: Triển khai tác phẩm theo kết cấu trường đoạn liền mạch nhiều chương/hồi (từ 5 đến 8 phần chi tiết). Mỗi phân đoạn cần được miêu tả tỉ mỉ, giàu sức sống và được phân tách bằng hai ký tự xuống dòng (\\n\\n).',
    '- CHIỀU SÂU VĂN CHƯƠNG: Miêu tả không gian và bối cảnh đa giác quan (thời tiết, ánh sáng, mùi hương, thanh âm); khắc họa thế giới nội tâm, độc thoại nhân vật sâu sắc; xây dựng những trường đoạn đối thoại chân thực, sắc sảo.',
    '- CAO TRÀO VÀ DƯ BA: Phát triển kịch tính và xung đột lên đến đỉnh điểm cao trào trước khi dẫn dắt đến cái kết đọng lại nhiều suy tưởng triết lý nhân sinh.',
    '- Tiêu đề (title): Đặt một nhan đề đầy chất thơ, lôi cuốn và mang tính biểu tượng nghệ thuật cao.',
    '- Nội dung (content): Toàn văn tác phẩm truyện dài trên 2.000 từ với đầy đủ chi tiết văn học đặc sắc.',
    '',
    'QUY TẮC AN TOÀN JSON (QUAN TRỌNG):',
    JSON_CODE_BLOCK_RULE,
    '- Trong phần lời thoại của nhân vật ("content"), BẮT BUỘC DÙNG DẤU NGOẶC KÉP CONG “ ” HOẶC DẤU NHÁY ĐƠN \' \' (ví dụ: “Chào bạn”, \'Chào bạn\'). TUYỆT ĐỐI KHÔNG dùng dấu ngoặc kép thẳng " để tránh gây lỗi cú pháp JSON.',
    '{',
    '  "title": "Nhan đề nghệ thuật của tác phẩm",',
    '  "content": "Toàn bộ tác phẩm văn học trường đoạn dài trên 2.000 từ với đầy đủ các đoạn văn được phân tách bởi ký tự xuống dòng \\\\n\\\\n..."',
    '}'
  ].join('\n');
}

export function buildMasterWriterRepairPrompt(error, {
  outputLanguage = 'auto',
  attempt = 2,
  videoSummary = '',
  globalContinuity = ''
} = {}) {
  const storyLangInstruction = storyLanguageInstruction(outputLanguage);
  const errorMsg = String(error?.message || '');
  const isJsonError = /JSON|SyntaxError|Expected|position|token|quote/i.test(errorMsg);
  const isLengthError = /ngắn|short|từ|words/i.test(errorMsg);

  const errorHints = [];
  if (isJsonError) {
    errorHints.push('- LỖI CÚ PHÁP JSON: Phản hồi trước bị lỗi dấu ngoặc kép trong đối thoại. Hãy dùng dấu ngoặc kép cong “ ” hoặc ngoặc đơn \' \' cho lời thoại.');
  }
  if (isLengthError) {
    errorHints.push('- LỖI ĐỘ DÀI: Tác phẩm phải có độ dài BẮT BUỘC TRÊN 2.000 TỪ (hơn 2.000 words). Không tóm tắt hay cắt ngắn.');
  }
  if (videoSummary?.trim()) {
    errorHints.push(`- BÁM SÁT VIDEO: Tác phẩm phải trực tiếp xoay quanh nội dung: "${videoSummary.trim()}". Tuyệt đối không viết chuyện lạc đề.`);
  }

  if (attempt >= 3) {
    return [
      `Phản hồi trước của bạn chưa đạt yêu cầu: ${errorMsg}`,
      ...errorHints,
      storyLangInstruction,
      'Để tránh hoàn toàn lỗi cú pháp JSON, hãy trả về tác phẩm theo ĐÚNG ĐỊNH DẠNG VĂN BẢN ĐƠN GIẢN sau (không dùng JSON, không dùng code fence):',
      'Tiêu đề: [Nhan đề nghệ thuật]',
      'Nội dung:',
      '[Toàn văn tác phẩm văn học trường đoạn trên 2.000 từ phân tách bởi hai dấu xuống dòng]'
    ].join('\n');
  }

  return [
    `Phản hồi trước của bạn chưa đạt yêu cầu: ${errorMsg}`,
    ...errorHints,
    'Với vai trò Nhà văn kiệt xuất, hãy viết lại tác phẩm hoàn chỉnh, ĐẢM BẢO ĐỘ DÀI BẮT BUỘC TRÊN 2.000 TỪ (hơn 2.000 words).',
    'Hãy mở rộng sâu sắc bối cảnh không gian, miêu tả tâm lý và độc thoại nội tâm nhân vật, các màn đối thoại chi tiết (dùng ngoặc kép cong “ ” hoặc nháy đơn \' \') và trường đoạn cao trào.',
    storyLangInstruction,
    'Trả về duy nhất 01 JSON object hợp lệ theo mẫu dưới đây, đặt trong một khối code ```json:',
    '{',
    '  "title": "Nhan đề nghệ thuật",',
    '  "content": "Toàn văn tác phẩm văn học trên 2.000 từ với nhiều đoạn văn phong phú phân tách bởi \\\\n\\\\n..."',
    '}',
    JSON_CODE_BLOCK_RULE
  ].join('\n');
}

export function parseMasterStory(text, { minWords = 0 } = {}) {
  let lastError;
  for (const candidate of jsonCandidates(text)) {
    let parsed;
    try { parsed = parseLenientJson(candidate); }
    catch (error) { lastError = error; continue; }
    try {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('JSON truyện phải là một object.');
      }
      const title = String(parsed.title ?? parsed.name ?? '').trim();
      const content = String(parsed.content ?? parsed.story ?? parsed.body ?? '').trim();
      if (!title) throw new Error('Truyện thiếu tiêu đề (title).');
      if (!content || content.length < 50) throw new Error('Nội dung truyện (content) quá ngắn hoặc bị thiếu.');
      const wordCount = countWords(content);
      if (minWords > 0 && wordCount < minWords) {
        throw new Error(`Nội dung tác phẩm quá ngắn (${wordCount} từ). Yêu cầu tối thiểu trên ${minWords} từ.`);
      }
      return { title, content, wordCount };
    } catch (error) {
      lastError = error;
    }
  }
  // Cứu chuỗi JSON có ngoặc kép chưa escape trong đối thoại hoặc định dạng văn bản
  const fallback = extractStoryFallback(text);
  if (fallback) {
    const { title, content } = fallback;
    if (title.length < 3) throw new Error('ChatGPT chưa trả tiêu đề câu chuyện hợp lệ.');
    if (title.length > 300) throw new Error('Tiêu đề câu chuyện vượt quá 300 ký tự.');
    if (content.length < 50) throw new Error('Nội dung tác phẩm quá ngắn hoặc bị thiếu.');
    const wordCount = countWords(content);
    if (minWords > 0 && wordCount < minWords) {
      throw new Error(`Nội dung tác phẩm quá ngắn (${wordCount} từ). Yêu cầu tối thiểu trên ${minWords} từ.`);
    }
    return { title, content, wordCount };
  }

  if (lastError && !(lastError instanceof SyntaxError)) throw lastError;
  throw new Error(`ChatGPT không trả JSON truyện nghệ thuật hợp lệ${lastError ? `: ${lastError.message}` : '.'}`);
}

export function buildThumbnailPrompt({ title, content = '' }) {
  const summarySnippet = String(content || '').replace(/\s+/g, ' ').slice(0, 350);
  return [
    'Tạo một hình ảnh minh họa nghệ thuật điện ảnh chất lượng cao 16:9 (cinematic 16:9 featured artwork) làm ảnh đại diện cho tác phẩm văn học:',
    `Tiêu đề tác phẩm: "${title}"`,
    summarySnippet ? `Cốt lõi câu chuyện: "${summarySnippet}..."` : '',
    'Yêu cầu hình ảnh: Phong cách nghệ thuật giàu cảm xúc, góc máy điện ảnh hùng vĩ hoặc sâu lắng, ánh sáng chân thực tuyệt đẹp (masterpiece lighting, cinematic atmosphere, 8k resolution, award-winning illustration). KHÔNG vẽ bất kỳ chữ viết, typography, watermark hay ký tự nào trên hình ảnh.'
  ].filter(Boolean).join('\n');
}

export function buildStoryboardFromStoryPrompt({
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
    'CINEMATIC STORYBOARD ADAPTATION TASK. Do not generate video, images, or audio. Return only valid JSON text.',
    'You are a master cinematic director adapting this completed literary story into a sequential video plan:',
    `TITLE: "${story.title}"`,
    `STORY CONTENT:\n${story.content}`,
    '',
    `Adapt this story visually into a ${duration.toFixed(0)}-second video sequence composed of exactly ${partCount} parts (${step} seconds each) at ${aspectRatio}.`,
    `Output language requirement for dialogue/narration: ${languageInstruction}`,
    `Required video timeline: ${JSON.stringify(ranges)}`,
    '',
    'Return exactly one valid JSON object and nothing else.',
    JSON_CODE_BLOCK_RULE,
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

export function buildStoryboardFromStoryRepairPrompt(error, { expectedParts, targetDuration, clipSeconds = DEFAULT_CLIP_SECONDS }) {
  return [
    `Your previous storyboard response could not be used: ${error.message}`,
    `Return a corrected JSON object only for the ${targetDuration}-second video adapted from the story.`,
    `It must contain "globalContinuity" and exactly ${expectedParts} parts in "parts" numbered 1 through ${expectedParts}.`,
    JSON_CODE_BLOCK_RULE
  ].join('\n');
}

export function parseStoryboardFromStory(text, { targetDuration, clipSeconds = DEFAULT_CLIP_SECONDS }) {
  const ranges = outputTimelineRanges(targetDuration, clipSeconds);
  const expected = ranges.length;
  let lastError;
  for (const candidate of jsonCandidates(text)) {
    let parsed;
    try { parsed = parseLenientJson(candidate); }
    catch (error) { lastError = error; continue; }
    try {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('JSON kịch bản phân cảnh phải là một object.');
      }
      const root = parsed;
      if (!Array.isArray(root.parts)) throw new Error('JSON thiếu mảng parts.');
      if (root.parts.length !== expected) throw new Error(`ChatGPT trả ${root.parts.length} part, cần đúng ${expected} part.`);
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
      if (globalContinuity.length < 30) throw new Error('ChatGPT thiếu mô tả globalContinuity đủ chi tiết.');
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
  throw new Error(`ChatGPT không trả JSON phân cảnh hợp lệ${lastError ? `: ${lastError.message}` : '.'}`);
}

export function buildAutoTopicPrompt({
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
    'CURRENT-TREND RESEARCH AND TEXT-ONLY STORYBOARD TASK. Do not generate video, images, or audio.',
    `Today is ${currentDate}. Use web search now to research topics that are demonstrably trending or rapidly gaining public interest during the last 7 days. Do not rely only on model memory.`,
    'Compare several recent, credible public sources or trend signals. Pick one timely topic that can become an original, visually compelling short video. Do not copy a creator, copyrighted scene, trademarked character, misinformation, private tragedy, or dangerous challenge.',
    `The final video must be ${duration.toFixed(0)} seconds long at ${aspectRatio}. Create exactly ${partCount} storyboard parts, each rendered later as one independently generated ${step}-second clip.`,
    `Plan the hook, development, and payoff across the full ${duration.toFixed(0)} seconds. Give every part only the amount of action and speech that can naturally fit its own ${step}-second window.`,
    `Output language requirement: ${languageInstruction}`,
    `Required output timeline: ${JSON.stringify(ranges)}`,
    '',
    'After researching, return exactly one valid JSON object and nothing else.',
    JSON_CODE_BLOCK_RULE,
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

export function buildStoryboardPrompt({
  duration, targetDuration = null, userInstruction = '', aspectRatio = null, outputLanguage = 'auto',
  clipSeconds = DEFAULT_CLIP_SECONDS,
  videoDescription = '',
  story = null
}) {
  const sourceDuration = Number(duration);
  const step = clipLength(clipSeconds);
  const outputDuration = targetDuration == null ? sourceDuration : Number(targetDuration);
  const ranges = sourceCoverageRanges(sourceDuration, targetDuration, step);
  const partCount = ranges.length;
  const instruction = userInstruction.trim() || 'Recreate the source video faithfully without adding unrelated scenes.';
  const languageInstruction = videoLanguageInstruction(outputLanguage, { hasSource: true });
  const sampleRange = ranges[0];

  const contextBlocks = [];
  if (videoDescription?.trim()) {
    contextBlocks.push(`VERIFIED SOURCE VIDEO CONTENT (ANALYZED IN PREVIOUS STEP):\n${videoDescription.trim()}`);
  }
  if (story?.title || story?.content) {
    const storySnippet = String(story.content || '').slice(0, 500);
    contextBlocks.push(`LITERARY STORY CONTEXT:\nTitle: "${story.title || ''}"\nExcerpt: ${storySnippet}...`);
  }

  return [
    'TEXT-ONLY ANALYSIS TASK. Do not create, edit, render, or generate any video, image, or audio. Return only JSON text for use by a separate tool.',
    'Analyze the uploaded contact-sheet frames sampled from the source video. RECONSTRUCT RICH AUDIO & SPOKEN DIALOGUE: The final video MUST have realistic sound and spoken dialogue. Based on the characters mouth movements, facial expressions, actions, and scene context, reconstruct natural, expressive spoken dialogue and sound effects for each scene.',
    `The source duration measured locally is ${sourceDuration.toFixed(2)} seconds.`,
    targetDuration == null ? '' : `The requested output duration is ${outputDuration.toFixed(0)} seconds. Compress or expand the source story across that duration without changing its essential order.`,
    `TASK GOAL: Write prompts for Grok AI to create a video that is SIMILAR TO THE SOURCE VIDEO (tạo 1 video tương tự video nguồn) with matching aesthetic style, sequence, subject continuity, and mood.`,
    `Create exactly ${partCount} storyboard parts, one for each source coverage range below.`,
    `A separate Grok step will later create ${partCount} full ${step}-second clips. Its final duration may differ from the requested duration by a fraction of a second.`,
    aspectRatio ? `The target aspect ratio is ${aspectRatio}.` : '',
    `Output language requirement: ${languageInstruction}`,
    `Additional user direction: ${instruction}`,
    contextBlocks.length > 0 ? contextBlocks.join('\n\n') : '',
    `Required source coverage ranges: ${JSON.stringify(ranges)}`,
    '',
    'Write storyboard prompts for that separate tool. Return exactly one valid JSON object and nothing else.',
    JSON_CODE_BLOCK_RULE,
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
    outputLanguage === 'none'
      ? '- Do not add spoken dialogue, narration, or voice-over.'
      : '- MANDATORY CHARACTER DIALOGUE & SPEECH: For parts where characters speak, interact, cry, or express emotion, you MUST write their exact spoken dialogue in single quotes \'...\' (e.g. Character speaks in Vietnamese with natural lip-sync: \'...\'). Include ambient sound effects and Foley. Ensure each part prompt specifies both visual action and audible dialogue so Grok generates clear character voice and speech instead of a silent clip.',
    '- PRESERVE RICH VISUAL DETAILS: Transfer all verified fine details from the video analysis (exact clothing, colors, facial expressions, tears, props, camera angles, and lighting) into globalContinuity and each part prompt.',
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
  const source = String(text);
  const fenced = [...source.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1].trim());
  const candidates = [...fenced, ...balancedCandidates(source)];
  // Stray unescaped quotes can throw off the balanced scan; the outermost braces are a last resort.
  const first = source.indexOf('{');
  const last = source.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(source.slice(first, last + 1));
  return [...new Set(candidates)];
}

/**
 * ChatGPT renders every reply as Markdown, and Markdown turns \" into " — so a JSON reply that was
 * valid when the model wrote it reaches us with bare quotes inside string values. A ```json code
 * block keeps backslashes verbatim, so every JSON prompt asks for one.
 */
export const JSON_CODE_BLOCK_RULE = 'OUTPUT FORMAT: put the entire JSON object inside ONE fenced code block that starts with ```json and ends with ```, and write nothing outside that block. Outside a code block the chat interface strips the backslash from \\" and breaks the JSON. Inside string values prefer single quotes \' \' or curly quotes “ ” for quoted words and character dialogue (for example: character says \'Thank you\' or a sign reading \'I am hungry\'); NEVER use raw unescaped straight double quotes inside string values.';

/**
 * Escapes a straight quote that sits inside a JSON string value but does not end it.
 * Smartly inspects delimiters so dialogue quotes followed by commas (e.g. He said "Hi", and left)
 * are recognized as interior text rather than JSON property separators.
 */
export function escapeStrayQuotes(text) {
  const source = String(text);
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (!inString) {
      if (character === '"') inString = true;
      output += character;
      continue;
    }
    if (escaped) { escaped = false; output += character; continue; }
    if (character === '\\') { escaped = true; output += character; continue; }
    if (character === '"') {
      let next = index + 1;
      while (next < source.length && /\s/.test(source[next])) next += 1;

      let isClosingQuote = false;
      if (next >= source.length) {
        isClosingQuote = true;
      } else {
        const nextChar = source[next];
        if (nextChar === '}' || nextChar === ']' || nextChar === ':') {
          isClosingQuote = true;
        } else if (nextChar === ',') {
          let afterComma = next + 1;
          while (afterComma < source.length && /\s/.test(source[afterComma])) afterComma += 1;
          if (afterComma >= source.length) {
            isClosingQuote = true;
          } else {
            const charAfter = source[afterComma];
            if ('{[}]-0123456789'.includes(charAfter)) {
              isClosingQuote = true;
            } else if (/^(?:true\b|false\b|null\b)/.test(source.slice(afterComma, afterComma + 6))) {
              isClosingQuote = true;
            } else if (charAfter === '"') {
              let keyEnd = afterComma + 1;
              while (keyEnd < source.length && source[keyEnd] !== '"' && source[keyEnd] !== '\n') keyEnd += 1;
              if (keyEnd < source.length && source[keyEnd] === '"') {
                let afterKey = keyEnd + 1;
                while (afterKey < source.length && /\s/.test(source[afterKey])) afterKey += 1;
                if (afterKey < source.length && source[afterKey] === ':') {
                  isClosingQuote = true;
                }
              }
            }
          }
        }
      }

      if (isClosingQuote) {
        inString = false;
        output += character;
      } else {
        output += '\\"';
      }
      continue;
    }
    if (character === '\n') { output += '\\n'; continue; }
    if (character === '\r') { output += '\\r'; continue; }
    if (character === '\t') { output += '\\t'; continue; }
    output += character;
  }
  return output;
}

/** JSON.parse, then one more try after repairing stray quotes. Throws the original error if both fail. */
export function parseLenientJson(candidate) {
  try {
    return JSON.parse(candidate);
  } catch (error) {
    try {
      return JSON.parse(escapeStrayQuotes(candidate));
    } catch {
      throw error;
    }
  }
}

export function jsonRetryInstruction(error, { attempt = 2, maxAttempts = 3 } = {}) {
  return [
    `RETRY ${attempt}/${maxAttempts}. The previous reply could not be parsed: ${error?.message || 'invalid JSON'}.`,
    'Resend the COMPLETE corrected JSON from the beginning — never a fragment, a diff, an explanation, or an apology.',
    JSON_CODE_BLOCK_RULE,
    attempt >= maxAttempts
      ? 'This is the final attempt: check that every string value closes properly and that nothing appears outside the code block.'
      : ''
  ].filter(Boolean).join('\n');
}

/**
 * Asks for a JSON reply up to `maxAttempts` times. `ask(attempt, lastError)` produces the raw reply and
 * `parse(raw, attempt)` validates it; a parse or validation failure triggers the next attempt, while a
 * cancellation (or any error thrown by `ask` itself) stops immediately.
 */
export async function runJsonAttempts({
  maxAttempts = 3,
  ask,
  parse,
  onInvalid = async () => {},
  isCancellation = () => false,
  failureMessage
}) {
  const attempts = Math.max(1, Math.floor(Number(maxAttempts) || 1));
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const raw = await ask(attempt, lastError);
    try {
      return { value: parse(raw, attempt), attempt, raw };
    } catch (error) {
      if (isCancellation(error)) throw error;
      lastError = error;
      await onInvalid(error, attempt);
    }
  }
  const finalError = new Error(failureMessage
    ? failureMessage(lastError, attempts)
    : `Không nhận được JSON hợp lệ sau ${attempts} lần thử: ${lastError?.message || 'không rõ lỗi'}`);
  finalError.cause = lastError;
  throw finalError;
}

export function extractStoryFallback(text) {
  if (!text || typeof text !== 'string') return null;
  const str = text.trim();

  // 1. Thử bóc tách JSON lỏng (cứu các trường hợp đối thoại chứa ngoặc kép chưa escape)
  const titleMatch = str.match(/["'](?:title|storyTitle|name)["']\s*:\s*["']([^"\r\n]+)["']/i);
  const contentKeyMatch = str.match(/["'](?:content|storyContent|narrative|body|story)["']\s*:\s*["']/i);
  if (titleMatch && contentKeyMatch) {
    const title = titleMatch[1].trim();
    const start = contentKeyMatch.index + contentKeyMatch[0].length;
    const lastBrace = str.lastIndexOf('}');
    const searchSlice = lastBrace > start ? str.slice(start, lastBrace) : str.slice(start);
    const endInSlice = searchSlice.lastIndexOf('"');
    const rawContent = endInSlice !== -1 ? searchSlice.slice(0, endInSlice) : searchSlice;
    const content = rawContent
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\r/g, '')
      .replace(/\\t/g, '\t')
      .trim();
    if (title.length >= 3 && content.length >= 50) {
      return { title, content };
    }
  }

  // 2. Thử bóc tách theo định dạng văn bản (Tiêu đề: ... / Nội dung: ...)
  const textTitleMatch = str.match(/(?:^|\n)\s*(?:Tiêu đề|Nhan đề|Title)\s*:\s*([^\r\n]+)/i);
  const textContentMatch = str.match(/(?:^|\n)\s*(?:Nội dung|Câu chuyện|Story|Content)\s*:\s*([\s\S]+)/i);
  if (textTitleMatch && textContentMatch) {
    const title = textTitleMatch[1].replace(/^[#"'\s]+|[#"'\s]+$/g, '').trim();
    const content = textContentMatch[1].trim();
    if (title.length >= 3 && content.length >= 50) {
      return { title, content };
    }
  }

  // 3. Thử bóc tách theo Markdown header (# Tiêu đề \n\n Nội dung)
  const mdMatch = str.match(/(?:^|\n)#\s+([^\r\n]+)\r?\n+([\s\S]+)/);
  if (mdMatch) {
    const title = mdMatch[1].replace(/^[#"'\s]+|[#"'\s]+$/g, '').trim();
    const content = mdMatch[2].trim();
    if (title.length >= 3 && content.length >= 50) {
      return { title, content };
    }
  }

  return null;
}

export function parseStory(text, { minWords = 0 } = {}) {
  let lastError;
  for (const candidate of jsonCandidates(text)) {
    let parsed;
    try { parsed = parseLenientJson(candidate); }
    catch (error) { lastError = error; continue; }
    try {
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
        throw new Error('JSON câu chuyện phải là một object.');
      }
      const rawTitle = parsed.title ?? parsed.storyTitle;
      const rawContent = parsed.content ?? parsed.storyContent ?? parsed.narrative ?? parsed.body;
      if (typeof rawTitle !== 'string' || typeof rawContent !== 'string') {
        throw new Error('ChatGPT phải trả title và content dưới dạng chuỗi.');
      }
      const title = rawTitle.trim();
      const content = rawContent.trim();
      if (title.length < 3) throw new Error('ChatGPT chưa trả tiêu đề câu chuyện hợp lệ.');
      if (title.length > 300) throw new Error('Tiêu đề câu chuyện vượt quá 300 ký tự.');
      if (content.length < 80) throw new Error('Nội dung câu chuyện quá ngắn hoặc bị thiếu.');
      if (content.length > 200000) throw new Error('Nội dung câu chuyện vượt quá giới hạn an toàn.');
      const wordCount = countWords(content);
      if (minWords > 0 && wordCount < minWords) {
        throw new Error(`Nội dung câu chuyện quá ngắn (${wordCount} từ). Yêu cầu tối thiểu trên ${minWords} từ.`);
      }
      return { title, content, wordCount };
    } catch (error) {
      lastError = error;
    }
  }

  // Cứu chuỗi JSON có ngoặc kép chưa escape trong đối thoại hoặc định dạng văn bản
  const fallback = extractStoryFallback(text);
  if (fallback) {
    const { title, content } = fallback;
    if (title.length < 3) throw new Error('ChatGPT chưa trả tiêu đề câu chuyện hợp lệ.');
    if (title.length > 300) throw new Error('Tiêu đề câu chuyện vượt quá 300 ký tự.');
    if (content.length < 80) throw new Error('Nội dung câu chuyện quá ngắn hoặc bị thiếu.');
    const wordCount = countWords(content);
    if (minWords > 0 && wordCount < minWords) {
      throw new Error(`Nội dung câu chuyện quá ngắn (${wordCount} từ). Yêu cầu tối thiểu trên ${minWords} từ.`);
    }
    return { title, content, wordCount };
  }

  if (lastError && !(lastError instanceof SyntaxError)) throw lastError;
  throw new Error(`ChatGPT không trả JSON câu chuyện hợp lệ${lastError ? `: ${lastError.message}` : '.'}`);
}

export function formatStoryText(story) {
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

export function parseStoryboard(text, { duration, targetDuration = null, clipSeconds = DEFAULT_CLIP_SECONDS }) {
  const ranges = sourceCoverageRanges(duration, targetDuration, clipSeconds);
  const expected = ranges.length;
  let parsed;
  let lastError;
  for (const candidate of jsonCandidates(text)) {
    try { parsed = parseLenientJson(candidate); break; }
    catch (error) { lastError = error; }
  }
  if (parsed == null) throw new Error(`ChatGPT không trả JSON hợp lệ${lastError ? `: ${lastError.message}` : '.'}`);
  const root = Array.isArray(parsed) ? { parts: parsed } : parsed;
  if (!Array.isArray(root.parts)) throw new Error('JSON ChatGPT thiếu mảng parts.');
  const parts = root.parts.map((item, index) => normalizePart(item, index, ranges[index]));
  if (parts.length !== expected) throw new Error(`ChatGPT trả ${parts.length} part, cần đúng ${expected} part.`);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part.partNumber !== index + 1) throw new Error(`Số thứ tự part không liên tục tại vị trí ${index + 1}.`);
    if (part.prompt.length < 40) throw new Error(`Prompt part ${part.partNumber} quá ngắn hoặc bị thiếu.`);
    if (part.prompt.length > 8000) throw new Error(`Prompt part ${part.partNumber} vượt quá 8.000 ký tự.`);
    part.sourceStartSeconds = ranges[index].sourceStartSeconds;
    part.sourceEndSeconds = ranges[index].sourceEndSeconds;
  }
  const globalContinuity = String(root.globalContinuity ?? root.consistency ?? '').trim();
  if (globalContinuity.length < 30) throw new Error('ChatGPT thiếu mô tả globalContinuity đủ chi tiết.');
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

export function parseAutoTopicPlan(text, { targetDuration, clipSeconds = DEFAULT_CLIP_SECONDS }) {
  const ranges = outputTimelineRanges(targetDuration, clipSeconds);
  const expected = ranges.length;
  let lastError;
  for (const candidate of jsonCandidates(text)) {
    let parsed;
    try { parsed = parseLenientJson(candidate); }
    catch (error) { lastError = error; continue; }
    try {
      const root = Array.isArray(parsed) ? { parts: parsed } : parsed;
      if (!Array.isArray(root.parts)) throw new Error('JSON ChatGPT thiếu mảng parts.');
      if (root.parts.length !== expected) throw new Error(`ChatGPT trả ${root.parts.length} part, cần đúng ${expected} part.`);
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
      if (summary.length < 20) throw new Error('ChatGPT thiếu summary đủ chi tiết.');
      const globalContinuity = String(root.globalContinuity ?? root.consistency ?? '').trim();
      if (globalContinuity.length < 30) throw new Error('ChatGPT thiếu mô tả globalContinuity đủ chi tiết.');
      const selectedTopic = String(root.selectedTopic ?? root.topic ?? '').trim();
      if (selectedTopic.length < 5) throw new Error('ChatGPT chưa nêu rõ chủ đề xu hướng đã chọn.');
      const trendRationale = String(root.trendRationale ?? root.rationale ?? '').trim();
      if (trendRationale.length < 20) throw new Error('ChatGPT chưa giải thích đủ căn cứ xu hướng hiện tại.');
      const sources = (Array.isArray(root.sources) ? root.sources : []).map(normalizeTrendSource).filter(Boolean);
      if (!sources.length) throw new Error('ChatGPT chưa cung cấp nguồn web hợp lệ cho chủ đề xu hướng.');
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
  throw new Error(`ChatGPT không trả JSON hợp lệ${lastError ? `: ${lastError.message}` : '.'}`);
}

export function buildAutoTopicRepairPrompt(error, { expectedParts, targetDuration, currentDate, clipSeconds = DEFAULT_CLIP_SECONDS }) {
  return [
    `Your previous trend storyboard could not be used: ${error.message}`,
    `Today is ${currentDate}. Return the complete corrected JSON object for the ${targetDuration}-second video.`,
    `It must contain exactly ${expectedParts} parts numbered 1 through ${expectedParts}, with one feasible self-contained ${clipLength(clipSeconds)}-second prompt per part.`,
    'It must also contain a non-empty selectedTopic, a factual trendRationale, summary, detailed globalContinuity, and at least one valid http(s) source URL actually consulted through web search.',
    'Do not invent a URL, citation, popularity metric, or claim. Use only the trend research already performed in this conversation.',
    JSON_CODE_BLOCK_RULE
  ].join('\n');
}

export function buildRepairPrompt(error, expectedParts) {
  return [
    `Your previous response could not be used: ${error.message}`,
    `Return a corrected JSON object only. It must contain exactly ${expectedParts} parts numbered 1 through ${expectedParts}.`,
    'Keep every prompt self-contained and keep globalContinuity detailed.',
    JSON_CODE_BLOCK_RULE
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
      'AUDIO REQUIREMENT: Full realistic audio with audible character voices, natural spoken dialogue with lip-sync delivery, Foley, and ambient background sound. The video must have rich sound and speech, not silent.',
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
      'AUDIO REQUIREMENT: Full realistic audio with audible character voices, natural spoken dialogue with lip-sync delivery, Foley, and ambient background sound. The video must have rich sound and speech, not silent.',
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
    ? 'Follow the exact spoken, narration, and intentional text language specified in this ChatGPT storyboard. Keep it unchanged across every part.'
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
      'AUDIO REQUIREMENT: Full realistic audio with audible character voices, natural spoken dialogue with lip-sync delivery, Foley, and ambient background sound. The video must have rich sound and speech, not silent.',
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
      'AUDIO REQUIREMENT: Full realistic audio with audible character voices, natural spoken dialogue with lip-sync delivery, Foley, and ambient background sound. The video must have rich sound and speech, not silent.',
      `LANGUAGE: ${languageRule}`,
      'No extra title, caption, logo, watermark, intro, or outro. Preserve the planned opening and ending transition for seamless concatenation.'
    ].filter(Boolean).join('\n\n')
  };
}

export { formatTimestamp };

