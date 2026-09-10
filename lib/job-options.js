export const VIDEO_LANGUAGES = Object.freeze({
  auto: 'Tự động',
  vi: 'Tiếng Việt',
  en: 'Tiếng Anh',
  zh: 'Tiếng Trung',
  ja: 'Tiếng Nhật',
  ko: 'Tiếng Hàn',
  th: 'Tiếng Thái',
  id: 'Tiếng Indonesia',
  es: 'Tiếng Tây Ban Nha',
  fr: 'Tiếng Pháp',
  de: 'Tiếng Đức',
  pt: 'Tiếng Bồ Đào Nha',
  ru: 'Tiếng Nga',
  none: 'Không thoại'
});

const GENERATION_LANGUAGE_NAMES = Object.freeze({
  vi: 'Vietnamese',
  en: 'English',
  zh: 'Mandarin Chinese',
  ja: 'Japanese',
  ko: 'Korean',
  th: 'Thai',
  id: 'Indonesian',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  pt: 'Portuguese',
  ru: 'Russian'
});

export function normalizeVideoLanguage(value = 'auto') {
  const language = String(value || 'auto').trim().toLowerCase();
  if (!Object.hasOwn(VIDEO_LANGUAGES, language)) {
    throw new Error('Ngôn ngữ video không hợp lệ.');
  }
  return language;
}

export function parseBooleanOption(value) {
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'on', 'yes'].includes(String(value ?? '').trim().toLowerCase());
}

export function videoLanguageLabel(value = 'auto') {
  return VIDEO_LANGUAGES[normalizeVideoLanguage(value)];
}

export function videoLanguageInstruction(value = 'auto', { hasSource = false } = {}) {
  const language = normalizeVideoLanguage(value);
  if (language === 'none') {
    return 'Do not add spoken dialogue, narration, or voice-over. Use only natural ambience, sound effects, and music when appropriate.';
  }
  if (language === 'auto') {
    return hasSource
      ? 'Preserve the spoken language of the source. Do not translate it and do not add speech where the source has none.'
      : 'Use the language naturally implied by the user concept. Do not add dialogue or narration unless the concept calls for it.';
  }
  const name = GENERATION_LANGUAGE_NAMES[language];
  return `If the video contains dialogue, narration, voice-over, or readable on-screen wording, use ${name}. ` +
    `${hasSource ? `Translate the source speech faithfully into ${name} while preserving its meaning and timing. ` : ''}` +
    'Do not add speech or text when the requested scene does not need it.';
}

// Grok's composer offers 5s, 10s and 15s. The clip length is not just a menu choice:
// it fixes how many parts a job costs, the storyboard ranges ChatGPT plans against, and
// the duration window every downloaded clip is validated in.
export const SUPPORTED_CLIP_SECONDS = Object.freeze([5, 10, 15]);
export const DEFAULT_CLIP_PREFERENCE = Object.freeze([15, 10]);

export function clipSecondsPreference(value = process.env.GROK_CLIP_SECONDS) {
  const requested = String(value ?? '').trim()
    .split(',')
    .map((item) => Number(String(item).trim().replace(/s$/i, '')))
    .filter((seconds) => SUPPORTED_CLIP_SECONDS.includes(seconds));
  const unique = [...new Set(requested)];
  return unique.length ? unique : [...DEFAULT_CLIP_PREFERENCE];
}

export function preferredClipSeconds(value) {
  return clipSecondsPreference(value)[0];
}

export function normalizeClipSeconds(value) {
  const seconds = Number(value);
  return SUPPORTED_CLIP_SECONDS.includes(seconds) ? seconds : null;
}

export function parseTargetDuration({ type, durationMode, durationSeconds, maxParts = 30, clipSeconds = 10 }) {
  const step = normalizeClipSeconds(clipSeconds) ?? 10;
  const defaultMode = type === 'topic' ? 'custom' : 'auto';
  const mode = String(durationMode || defaultMode).trim().toLowerCase();
  if (!['auto', 'custom'].includes(mode)) throw new Error('Chế độ thời lượng không hợp lệ.');
  if (mode === 'auto') {
    if (type === 'topic') throw new Error('Chế độ Chủ đề cần chọn thời lượng cụ thể.');
    return null;
  }

  const fallback = type === 'topic' && (durationSeconds == null || durationSeconds === '') ? step : durationSeconds;
  const seconds = Number(fallback);
  const maximum = Math.max(1, Number(maxParts) || 30) * step;
  if (!Number.isInteger(seconds) || seconds < step || seconds % step !== 0) {
    throw new Error(`Thời lượng phải là bội số ${step} giây và không nhỏ hơn ${step} giây.`);
  }
  if (seconds > maximum) {
    throw new Error(`Thời lượng vượt giới hạn ${maximum} giây (${Math.floor(maximum / step)} part).`);
  }
  return seconds;
}

export function trendDateKey(date = new Date(), timeZone = process.env.TREND_TIMEZONE || 'Asia/Ho_Chi_Minh') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
