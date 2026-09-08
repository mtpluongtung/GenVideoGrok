import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGeminiAutoTopicPrompt,
  buildGeminiAutoTopicRepairPrompt,
  parseGeminiAutoTopicPlan
} from '../lib/prompt-plan.js';

const continuity = 'The same adult Vietnamese host, facial identity, cobalt shirt, warm studio lighting, clean wooden table, energetic camera language, and upbeat audio identity remain unchanged.';
const detailedPrompt = 'A cinematic vertical-friendly shot follows the same host demonstrating the central idea with precise action, camera movement, warm lighting, energetic pacing, natural Vietnamese narration, ambient audio, and a seamless transition.';

function validPlan(partCount, extras = {}) {
  return {
    ...extras,
    summary: 'A concise, original short-form video story based on a currently verified trend.',
    globalContinuity: continuity,
    parts: Array.from({ length: partCount }, (_item, index) => ({
      partNumber: index + 1,
      prompt: `${detailedPrompt} This is the distinct story beat for part ${index + 1}.`
    }))
  };
}

test('prompt auto-topic yêu cầu Gemini kiểm tra xu hướng hiện tại và nhận đủ thời lượng/ngôn ngữ', () => {
  const prompt = buildGeminiAutoTopicPrompt({
    targetDuration: 30,
    outputLanguage: 'vi',
    currentDate: '2026-08-26'
  });

  assert.match(prompt, /2026-08-26/);
  assert.match(prompt, /Google Search/i);
  assert.match(prompt, /(?:current|recent|viral|trending).*(?:trend|topic)|(?:trend|topic).*(?:current|recent|viral|trending)/i);
  assert.match(prompt, /(?:target|requested|final)[^\n]*30 seconds/i);
  assert.match(prompt, /exactly 3 (?:storyboard )?parts/i);
  assert.match(prompt, /10-second/i);
  assert.match(prompt, /Vietnamese/i);
  assert.match(prompt, /JSON/i);
  assert.match(prompt, /sources/i);
});

test('parser auto-topic chấp nhận và giữ metadata xu hướng tùy chọn', () => {
  const raw = `\`\`\`json\n${JSON.stringify(validPlan(2, {
    selectedTopic: 'A verified emerging home-cooking trend',
    trendRationale: 'Recent search results show strong short-form engagement this week.',
    sources: [
      { title: 'Current trend report', url: 'https://example.com/trend', publishedAt: '2026-08-25' }
    ]
  }))}\n\`\`\``;

  const plan = parseGeminiAutoTopicPlan(raw, { targetDuration: 20 });
  assert.equal(plan.parts.length, 2);
  assert.equal(plan.parts[0].partNumber, 1);
  assert.equal(plan.parts[1].partNumber, 2);
  assert.equal(plan.selectedTopic, 'A verified emerging home-cooking trend');
  assert.match(plan.trendRationale, /search results/i);
  assert.equal(plan.sources[0].url, 'https://example.com/trend');
});

test('parser bỏ qua JSON phụ sai schema và lấy storyboard hợp lệ phía sau', () => {
  const planData = validPlan(1, {
    selectedTopic: 'A verified current science topic',
    trendRationale: 'A recent source documents why this subject is timely this week.',
    sources: [{ title: 'Recent report', url: 'https://example.com/recent-report' }]
  });
  const plan = parseGeminiAutoTopicPlan(`Research metadata: {"query":"current trend"}\n${JSON.stringify(planData)}`, {
    targetDuration: 10
  });
  assert.equal(plan.selectedTopic, 'A verified current science topic');
  assert.equal(plan.parts.length, 1);
});

test('parser auto-topic bắt buộc chủ đề, căn cứ và ít nhất một nguồn web', () => {
  assert.throws(
    () => parseGeminiAutoTopicPlan(JSON.stringify(validPlan(1)), { targetDuration: 10 }),
    /chủ đề xu hướng/
  );
  assert.throws(
    () => parseGeminiAutoTopicPlan(JSON.stringify(validPlan(1, {
      selectedTopic: 'A current topic',
      trendRationale: 'A sufficiently detailed current trend rationale without a source.'
    })), { targetDuration: 10 }),
    /nguồn web hợp lệ/
  );
});

test('repair auto-topic nhắc lại thời lượng, part và nguồn Google Search', () => {
  const prompt = buildGeminiAutoTopicRepairPrompt(new Error('thiếu nguồn'), {
    expectedParts: 3,
    targetDuration: 30,
    currentDate: '2026-08-26'
  });
  assert.match(prompt, /30-second/i);
  assert.match(prompt, /exactly 3 parts/i);
  assert.match(prompt, /Google Search/i);
  assert.match(prompt, /source URL/i);
});

test('parser auto-topic từ chối số part không khớp thời lượng đích', () => {
  assert.throws(
    () => parseGeminiAutoTopicPlan(JSON.stringify(validPlan(2)), { targetDuration: 30 }),
    /(?:trả|contains|has) 2 part.*(?:cần|expected|requires) (?:đúng )?3 part/i
  );
});
