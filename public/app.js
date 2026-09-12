const $ = (selector) => document.querySelector(selector);
let type = 'topic';
let clipSeconds = 10;
let currentFilter = 'all';
let cachedJobs = [];
const prompt = $('#form [name=prompt]');
const clipSecondsSelect = $('#form [name=clipSeconds]');
const durationMode = $('#form [name=durationMode]');
const durationSeconds = $('#form [name=durationSeconds]');
const language = $('#form [name=language]');
const writeStory = $('#form [name=writeStory]');
const useReferenceFrames = $('#form [name=useReferenceFrames]');
const referenceImages = $('#form [name=referenceImages]');
const postToReels = $('#form [name=postToReels]');
const autoStoryUpload = $('#form [name=autoStoryUpload]');
const autoDurationOption = durationMode.querySelector('option[value=auto]');
const autoLanguageOption = language.querySelector('option[value=auto]');
const optionState = {
  topic: { durationMode: 'custom', durationSeconds: '10', clipSeconds: '10', language: 'auto', prompt: '', writeStory: false, useReferenceFrames: true, postToReels: false, autoStoryUpload: false },
  youtube: { durationMode: 'auto', durationSeconds: '10', clipSeconds: '10', language: 'auto', prompt: '', writeStory: false, useReferenceFrames: true, postToReels: false, autoStoryUpload: false },
  upload: { durationMode: 'auto', durationSeconds: '10', clipSeconds: '10', language: 'auto', prompt: '', writeStory: false, useReferenceFrames: true, postToReels: false, autoStoryUpload: false }
};

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  setTimeout(() => element.classList.remove('show'), 2800);
}

function saveOptionState() {
  optionState[type] = {
    durationMode: durationMode.value,
    durationSeconds: durationSeconds.value || String(clipSeconds),
    clipSeconds: clipSecondsSelect ? clipSecondsSelect.value : String(clipSeconds),
    language: language.value,
    prompt: prompt.value,
    writeStory: type === 'upload' && writeStory.checked,
    useReferenceFrames: useReferenceFrames.checked,
    postToReels: postToReels.checked,
    autoStoryUpload: Boolean(autoStoryUpload?.checked)
  };
}

function updateOptions() {
  const isTopic = type === 'topic';
  autoDurationOption.disabled = isTopic;
  autoDurationOption.textContent = 'Theo video nguồn';
  if (isTopic && durationMode.value === 'auto') durationMode.value = 'custom';
  durationSeconds.disabled = durationMode.value === 'auto';
  durationSeconds.required = durationMode.value === 'custom';
  autoLanguageOption.textContent = isTopic ? 'Theo nội dung chủ đề' : 'Giữ ngôn ngữ video gốc';

  const seconds = Number(durationSeconds.value);
  const maximum = Number(durationSeconds.max) || 300;
  const validCustom = Number.isInteger(seconds) && seconds >= clipSeconds && seconds <= maximum && seconds % clipSeconds === 0;
  $('#durationHelp').textContent = durationMode.value === 'auto'
    ? `Tự động theo video nguồn; mỗi part Grok dài ${clipSeconds} giây.`
    : validCustom
      ? `${seconds / clipSeconds} part × ${clipSeconds} giây. Thực tế có thể chênh một phần giây.`
      : `Nhập thời lượng là bội số ${clipSeconds} giây, từ ${clipSeconds} đến ${maximum} giây.`;

  const languageName = language.selectedOptions[0]?.textContent || 'Tự động';
  const qualityNote = 'Ưu tiên 1080p, tự động 720p nếu không có';
  const workflow = durationMode.value === 'auto'
    ? `Theo thời lượng nguồn · ${qualityNote} · ${languageName}`
    : `${validCustom ? `${seconds / clipSeconds} part × ${clipSeconds} giây` : 'Thời lượng tùy chỉnh'} · ${qualityNote} · ${languageName}`;
  const storyNote = type === 'upload' && writeStory.checked ? ' · Viết thêm câu chuyện (.txt)' : '';
  const uploadedReferenceCount = referenceImages.files?.length || 0;
  const autoReferenceNote = useReferenceFrames.checked
    ? isTopic ? ' · Nối frame cuối đoạn trước' : ' · Frame nguồn + nối đoạn trước'
    : '';
  const referenceNote = `${autoReferenceNote}${uploadedReferenceCount ? ` · ${uploadedReferenceCount} ảnh của bạn` : ''}`;
  $('#referenceHelp').textContent = isTopic
    ? 'Chế độ Chủ đề không có video nguồn, nên chỉ gửi frame cuối của đoạn trước để các đoạn nối nhau liền mạch.'
    : 'Gửi kèm cho Grok một frame cắt từ video nguồn cho đúng đoạn đó, và frame cuối của đoạn trước để nối tiếp liền mạch.';
  const trendflareNote = autoStoryUpload?.checked ? ' · Tự viết truyện & upload Trendflare' : '';
  const reelsNote = postToReels.checked ? ' · Tự đăng Facebook Reels (9:16, ≤ 90s)' : '';
  const workflowSummary = `${workflow}${storyNote}${referenceNote}${trendflareNote}${reelsNote}.`;
  $('#workflowNote').textContent = type === 'topic' && !prompt.value.trim()
    ? `Để trống: ChatGPT tìm xu hướng và viết kịch bản · ${workflowSummary}`
    : workflowSummary;
  saveOptionState();
}

function restoreOptionState() {
  const state = optionState[type];
  if (clipSecondsSelect && state.clipSeconds) {
    clipSecondsSelect.value = state.clipSeconds;
    clipSeconds = Number(state.clipSeconds) || 10;
    durationSeconds.min = String(clipSeconds);
    durationSeconds.step = String(clipSeconds);
  }
  durationMode.value = state.durationMode;
  durationSeconds.value = state.durationSeconds;
  language.value = state.language;
  prompt.value = state.prompt;
  writeStory.checked = type === 'upload' && Boolean(state.writeStory);
  useReferenceFrames.checked = state.useReferenceFrames !== false;
  postToReels.checked = Boolean(state.postToReels);
  if (autoStoryUpload) autoStoryUpload.checked = Boolean(state.autoStoryUpload);
  updateOptions();
}

function selectType(button) {
  saveOptionState();
  type = button.dataset.type;
  document.querySelectorAll('.tabs button').forEach((item) => item.classList.toggle('active', item === button));
  $('#form [name=type]').value = type;
  $('#youtubeField').hidden = type !== 'youtube';
  $('#uploadField').hidden = type !== 'upload';
  $('#storyField').hidden = type !== 'upload';
  writeStory.disabled = type !== 'upload';
  prompt.required = false;
  $('#form [name=youtubeUrl]').required = type === 'youtube';
  $('#form [name=video]').required = type === 'upload';
  $('#promptLabel').textContent = type === 'topic' ? 'Chủ đề (không bắt buộc)' : 'Chỉ dẫn bổ sung (không bắt buộc)';
  prompt.placeholder = type === 'topic'
    ? 'Để trống để ChatGPT tìm xu hướng đang nổi và tự viết kịch bản, hoặc nhập chủ đề của bạn...'
    : 'Ví dụ: Giữ nhịp dựng nhanh hơn, không thêm chữ. Để trống nếu muốn bám sát video nguồn.';
  $('#promptHelp').textContent = type === 'topic'
    ? 'Để trống: ChatGPT tìm xu hướng hiện tại, chọn ý tưởng và chia kịch bản theo đúng thời lượng.'
    : 'ChatGPT sẽ phân tích video nguồn; chỉ dẫn này dùng để điều chỉnh kết quả nếu cần.';
  restoreOptionState();
}

document.querySelectorAll('.tabs button').forEach((button) => { button.onclick = () => selectType(button); });
if (clipSecondsSelect) {
  clipSecondsSelect.onchange = () => {
    clipSeconds = Number(clipSecondsSelect.value) || 10;
    durationSeconds.min = String(clipSeconds);
    durationSeconds.step = String(clipSeconds);
    const maxVal = clipSeconds * 30;
    durationSeconds.max = String(maxVal);
    const current = Number(durationSeconds.value);
    if (!Number.isInteger(current) || current < clipSeconds || current % clipSeconds !== 0) {
      durationSeconds.value = String(clipSeconds);
    }
    updateOptions();
  };
}
durationMode.onchange = updateOptions;
durationSeconds.oninput = updateOptions;
language.onchange = updateOptions;
prompt.oninput = updateOptions;
writeStory.onchange = updateOptions;
useReferenceFrames.onchange = updateOptions;
referenceImages.onchange = updateOptions;
postToReels.onchange = updateOptions;
if (autoStoryUpload) autoStoryUpload.onchange = updateOptions;
updateOptions();

// Bộ lọc trạng thái
document.querySelectorAll('.filter-pill').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.filter-pill').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    renderJobsList(cachedJobs);
  };
});

async function loadConfig() {
  try {
    const response = await fetch('/api/config');
    if (!response.ok) return;
    const config = await response.json();
    clipSeconds = Number(config.clipSeconds) || clipSeconds;
    if (clipSecondsSelect) clipSecondsSelect.value = String(clipSeconds);
    durationSeconds.min = String(clipSeconds);
    durationSeconds.step = String(clipSeconds);
    durationSeconds.max = String(clipSeconds * (Number(config.maxParts) || 30));
    for (const key of Object.keys(optionState)) {
      optionState[key].clipSeconds = String(clipSeconds);
      const current = Number(optionState[key].durationSeconds);
      if (!Number.isInteger(current) || current % clipSeconds !== 0) optionState[key].durationSeconds = String(clipSeconds);
    }
    if (Number(durationSeconds.value) % clipSeconds !== 0) durationSeconds.value = String(clipSeconds);
    $('#reelsField').hidden = !config.facebookConfigured;
    if (!config.facebookConfigured) postToReels.checked = false;
    $('#referenceUploadHelp').textContent = `Tối đa ${config.maxReferenceImages} ảnh, mỗi ảnh dưới 20 MB. Ảnh này được gửi kèm cho mọi đoạn để giữ nhân vật và phong cách theo ý bạn.`;
    updateOptions();
  } catch { /* giữ mặc định khi chưa gọi được cấu hình */ }
}
loadConfig();

async function login(service) {
  try {
    const response = await fetch(`/api/login/${service}`, { method: 'POST' });
    const data = await response.json();
    toast(data.message || data.error);
  } catch {
    toast('Không kết nối được với ứng dụng');
  }
}

$('#loginGrok').onclick = () => login('grok');
$('#loginChatGPT').onclick = () => login('chatgpt');

$('#form').onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = event.submitter;
  button.disabled = true;
  button.textContent = 'Đang thêm…';
  saveOptionState();
  try {
    const response = await fetch('/api/jobs', { method: 'POST', body: new FormData(form) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    form.reset();
    form.querySelector('[name=type]').value = type;
    optionState[type].prompt = '';
    restoreOptionState();
    toast('Đã thêm vào hàng đợi');
    await refresh();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Thêm vào hàng đợi →';
  }
};

const labels = { queued: 'Đang chờ', running: 'Đang chạy', done: 'Hoàn tất', failed: 'Lỗi', cancelled: 'Đã hủy' };
let refreshing = false;

const reelLabels = {
  pending: 'Chờ đăng Reels',
  publishing: 'Đang đăng Reels…',
  published: 'Đã đăng Reels',
  failed: 'Đăng Reels lỗi',
  rejected: 'Không hợp lệ cho Reels',
  skipped: 'Bỏ qua Reels'
};

function jobTitle(job) {
  if (job.prompt) return job.prompt;
  if (job.generatedTopic) return `ChatGPT chọn: ${job.generatedTopic}`;
  if (job.autoTopic) return 'ChatGPT đang tìm chủ đề xu hướng…';
  return 'Tạo theo video nguồn';
}

function storyUrl(job) {
  return job.storyUrl || '';
}

function renderJobCard(job) {
  const duration = job.durationMode === 'auto'
    ? job.sourceDuration ? `Nguồn ${Number(job.sourceDuration).toFixed(1)}s` : 'Theo thời lượng nguồn'
    : `Mục tiêu ${Number(job.targetDuration || job.clipSeconds || 10).toFixed(0)}s`;
  const languageName = job.languageLabel || 'Tự động';

  return `
    <article class="job" data-id="${job.id}" data-status="${job.status}">
      <div class="job-head">
        <div class="job-main">
          <div class="job-title" title="${escapeHtml(jobTitle(job))}">${escapeHtml(jobTitle(job))}</div>
        </div>
        <span class="status ${job.status}">${escapeHtml(labels[job.status] || job.status)}</span>
      </div>

      <div class="meta">
        <div class="meta-chip-row">
          <span class="chip chip-accent">${job.type.toUpperCase()}</span>
          <span class="chip">${escapeHtml(duration)}</span>
          <span class="chip">${escapeHtml(languageName)}</span>
          ${job.outputResolution ? `<span class="chip chip-info">${escapeHtml(job.outputResolution)}</span>` : ''}
          ${job.autoTopic ? `<span class="chip">ChatGPT tự viết kịch bản</span>` : ''}
          ${job.writeStory ? `<span class="chip chip-accent">Viết thêm câu chuyện</span>` : ''}
          ${job.useReferenceFrames ? `<span class="chip">Ảnh tham chiếu tự động</span>` : ''}
          ${job.referenceImageCount ? `<span class="chip chip-info">${job.referenceImageCount} ảnh của bạn</span>` : ''}
          ${job.segmentCount > 1 ? `<span class="chip">${job.segmentCount} đoạn đã ghép</span>` : ''}
          ${job.outputDuration ? `<span class="chip">Kết quả ${Number(job.outputDuration).toFixed(1)}s</span>` : ''}
          ${job.reelStatus ? `<span class="chip chip-info">${escapeHtml(reelLabels[job.reelStatus] || job.reelStatus)}</span>` : ''}
          ${job.autoStoryUpload ? `<span class="chip chip-accent">Tự viết truyện & upload Trendflare</span>` : ''}
          ${job.trendflarePostSlug ? `<span class="chip chip-info" title="Slug: ${escapeHtml(job.trendflarePostSlug)}">Slug: ${escapeHtml(job.trendflarePostSlug)}</span>` : ''}
          ${job.trendflareStatus === 'published' ? `<span class="chip chip-info">Đã đăng Trendflare</span>` : ''}
        </div>

        <div class="meta-detail-text">
          ${escapeHtml(job.message)}
        </div>

        ${job.thumbnailUrl ? `
          <div class="job-thumb-preview">
            <img src="${escapeHtml(job.thumbnailUrl)}" alt="Thumbnail" loading="lazy" />
          </div>
        ` : ''}

        ${job.error ? `<div class="meta-error-box">⚠️ ${escapeHtml(job.error)}</div>` : ''}
        ${job.reelError && job.reelStatus !== 'published' ? `<div class="meta-error-box">⚠️ Reels: ${escapeHtml(job.reelError)}</div>` : ''}
        ${job.trendflareError && job.trendflareStatus !== 'published' ? `<div class="meta-error-box">⚠️ Trendflare: ${escapeHtml(job.trendflareError)}</div>` : ''}
      </div>

      <div class="job-actions">
        ${job.outputUrl ? `<a href="${job.outputUrl}" download class="btn-download">Tải video ↓</a>` : ''}
        ${job.trendflarePostUrl ? `<a href="${escapeHtml(job.trendflarePostUrl)}" target="_blank" rel="noopener" class="btn-trendflare">Xem bài viết Trendflare ↗</a>` : ''}
        ${job.reelUrl ? `<a href="${escapeHtml(job.reelUrl)}" target="_blank" rel="noopener" class="btn-reel">Xem Reels ↗</a>` : ''}
        ${storyUrl(job) ? `<a href="${escapeHtml(storyUrl(job))}" download class="btn-link">Tải câu chuyện ↓</a>` : ''}
        ${job.aiPlanUrl ? `<a href="${job.aiPlanUrl}" target="_blank" class="btn-link">Kịch bản ChatGPT</a>` : ''}
        ${job.logUrl ? `<a href="${job.logUrl}" target="_blank" class="btn-link">Log</a>` : ''}
        ${['queued', 'running'].includes(job.status) ? `<button class="btn-cancel-job" data-cancel="${job.id}"${job.cancelRequested ? ' disabled' : ''}>${job.cancelRequested ? 'Đang hủy…' : '⨯ Hủy'}</button>` : ''}
        ${['failed', 'cancelled'].includes(job.status) ? `<button class="retry" data-retry="${job.id}" title="Tiếp tục từ đoạn còn dở, tái dùng clip đã có">Thử lại</button>` : ''}
        ${['done', 'failed', 'cancelled'].includes(job.status) ? `<button class="retry" data-rerun="${job.id}" title="Giữ kịch bản ChatGPT, xóa clip cũ và dựng lại video">Tạo lại video</button>` : ''}
        ${job.status !== 'running' ? `<button class="btn-delete-job" data-delete="${job.id}" title="Xóa tác vụ">✕ Xóa</button>` : ''}
      </div>
    </article>
  `;
}

function renderJobsList(jobs) {
  const filtered = jobs.filter((job) => {
    if (currentFilter === 'running') return job.status === 'running' || job.status === 'queued';
    if (currentFilter === 'done') return job.status === 'done';
    if (currentFilter === 'failed') return job.status === 'failed' || job.status === 'cancelled';
    return true;
  });

  if (!filtered.length) {
    const emptyMsg = jobs.length
      ? 'Không có tác vụ nào khớp với bộ lọc.'
      : 'Chưa có tác vụ. Có thể nhập chủ đề hoặc để trống để ChatGPT tìm xu hướng.';
    $('#jobs').innerHTML = `<div class="empty">${emptyMsg}</div>`;
    return;
  }

  $('#jobs').innerHTML = filtered.map(renderJobCard).join('');

  document.querySelectorAll('[data-cancel]').forEach((button) => {
    button.onclick = async () => {
      button.disabled = true;
      button.textContent = 'Đang hủy…';
      try {
        const response = await fetch(`/api/jobs/${button.dataset.cancel}/cancel`, { method: 'POST' });
        const data = await response.json();
        toast(response.ok
          ? (data.status === 'cancelled' ? 'Đã hủy tác vụ' : 'Đang dừng tác vụ…')
          : (data.error || 'Lỗi khi hủy tác vụ'));
      } catch {
        toast('Không kết nối được với ứng dụng');
      } finally {
        await refresh();
      }
    };
  });
  document.querySelectorAll('[data-retry]').forEach((button) => {
    button.onclick = async () => {
      button.disabled = true;
      const response = await fetch(`/api/jobs/${button.dataset.retry}/retry`, { method: 'POST' });
      const data = await response.json();
      toast(response.ok ? 'Đã tiếp tục tác vụ' : data.error);
      await refresh();
    };
  });

  document.querySelectorAll('[data-rerun]').forEach((button) => {
    button.onclick = async () => {
      button.disabled = true;
      const response = await fetch(`/api/jobs/${button.dataset.rerun}/rerun`, { method: 'POST' });
      const data = await response.json();
      toast(response.ok ? 'Đã thêm lượt tạo lại' : data.error);
      await refresh();
    };
  });

  document.querySelectorAll('[data-delete]').forEach((button) => {
    button.onclick = async () => {
      button.disabled = true;
      try {
        const response = await fetch(`/api/jobs/${button.dataset.delete}`, { method: 'DELETE' });
        const data = await response.json();
        toast(response.ok ? 'Đã xóa tác vụ' : (data.error || 'Lỗi khi xóa'));
        await refresh();
      } catch {
        toast('Không kết nối được với ứng dụng');
      }
    };
  });
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const response = await fetch('/api/jobs');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const jobs = await response.json();
    cachedJobs = jobs;
    $('#count').textContent = `${jobs.length} tác vụ`;
    renderJobsList(jobs);
  } catch {
    $('#count').textContent = 'Mất kết nối — đang thử lại…';
  } finally {
    refreshing = false;
  }
}

function escapeHtml(value = '') {
  const element = document.createElement('div');
  element.textContent = value;
  return element.innerHTML;
}

refresh();
setInterval(refresh, 3000);
