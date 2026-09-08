import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clipSecondsPreference,
  normalizeVideoLanguage,
  parseBooleanOption,
  parseTargetDuration,
  preferredClipSeconds,
  trendDateKey,
  videoLanguageInstruction,
  videoLanguageLabel
} from '../lib/job-options.js';

test('checkbox backend nhận các giá trị FormData phổ biến', () => {
  for (const value of [true, 'true', 'TRUE', '1', 'on', 'yes']) assert.equal(parseBooleanOption(value), true);
  for (const value of [false, undefined, null, '', 'false', '0', 'off']) assert.equal(parseBooleanOption(value), false);
});

test('thời lượng mặc định tương thích tác vụ cũ', () => {
  assert.equal(parseTargetDuration({ type: 'topic' }), 10);
  assert.equal(parseTargetDuration({ type: 'upload' }), null);
  assert.equal(parseTargetDuration({ type: 'youtube', durationMode: 'auto' }), null);
});

test('khóa ngày xu hướng dùng múi giờ cấu hình để cache không qua ngày', () => {
  const instant = new Date('2026-08-26T17:30:00.000Z');
  assert.equal(trendDateKey(instant, 'Asia/Ho_Chi_Minh'), '2026-08-27');
  assert.equal(trendDateKey(instant, 'UTC'), '2026-08-26');
});

test('chỉ nhận thời lượng tùy chỉnh theo part 10 giây', () => {
  assert.equal(parseTargetDuration({ type: 'topic', durationMode: 'custom', durationSeconds: '30' }), 30);
  assert.equal(parseTargetDuration({ type: 'upload', durationMode: 'custom', durationSeconds: '120' }), 120);
  assert.throws(() => parseTargetDuration({ type: 'topic', durationMode: 'auto' }), /cần chọn thời lượng cụ thể/);
  assert.throws(() => parseTargetDuration({ type: 'upload', durationMode: 'custom', durationSeconds: '15' }), /bội số 10/);
  assert.throws(() => parseTargetDuration({ type: 'upload', durationMode: 'custom', durationSeconds: '310', maxParts: 30 }), /giới hạn 300 giây/);
  assert.throws(() => parseTargetDuration({ type: 'upload', durationMode: 'custom', durationSeconds: 'NaN' }), /bội số 10/);
});

test('ngôn ngữ dùng allowlist và không tự ép thêm thoại', () => {
  assert.equal(normalizeVideoLanguage(), 'auto');
  assert.equal(videoLanguageLabel('vi'), 'Tiếng Việt');
  assert.match(videoLanguageInstruction('vi', { hasSource: true }), /Vietnamese/);
  assert.match(videoLanguageInstruction('vi', { hasSource: true }), /Do not add speech/);
  assert.match(videoLanguageInstruction('auto', { hasSource: true }), /Preserve the spoken language/);
  assert.match(videoLanguageInstruction('none'), /Do not add spoken dialogue/);
  assert.throws(() => normalizeVideoLanguage('xx-invalid'), /không hợp lệ/);
});

test('thứ tự ưu tiên độ dài clip mặc định là 15s rồi 10s', () => {
  assert.deepEqual(clipSecondsPreference(''), [15, 10]);
  assert.deepEqual(clipSecondsPreference(undefined), [15, 10]);
  assert.equal(preferredClipSeconds(''), 15);
});

test('GROK_CLIP_SECONDS ghi đè được thứ tự và bỏ giá trị Grok không có', () => {
  assert.deepEqual(clipSecondsPreference('10,15'), [10, 15]);
  assert.deepEqual(clipSecondsPreference('10s, 5s'), [10, 5]);
  assert.deepEqual(clipSecondsPreference('7,12'), [15, 10], 'giá trị lạ bị bỏ, quay về mặc định');
  assert.deepEqual(clipSecondsPreference('15,15,10'), [15, 10], 'không lặp giá trị');
  assert.equal(preferredClipSeconds('10'), 10);
});

test('thời lượng phải là bội số của độ dài clip đang dùng', () => {
  assert.equal(parseTargetDuration({ type: 'topic', durationSeconds: 60, clipSeconds: 15 }), 60);
  assert.equal(parseTargetDuration({ type: 'topic', durationSeconds: '', clipSeconds: 15 }), 15);
  assert.throws(
    () => parseTargetDuration({ type: 'topic', durationSeconds: 50, clipSeconds: 15 }),
    /bội số 15 giây/
  );
  assert.throws(
    () => parseTargetDuration({ type: 'topic', durationSeconds: 10, clipSeconds: 15 }),
    /không nhỏ hơn 15 giây/
  );
  // Giới hạn an toàn tính theo số part, không theo số giây cố định.
  assert.equal(parseTargetDuration({ type: 'topic', durationSeconds: 450, maxParts: 30, clipSeconds: 15 }), 450);
  assert.throws(
    () => parseTargetDuration({ type: 'topic', durationSeconds: 465, maxParts: 30, clipSeconds: 15 }),
    /vượt giới hạn 450 giây \(30 part\)/
  );
});
