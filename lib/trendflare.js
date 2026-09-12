import fs from 'node:fs/promises';
import path from 'node:path';

export function trendflareConfig(env = process.env) {
  return {
    apiUrl: String(env.TRENDFLARE_API_URL || 'https://report.trendflare.biz/api').trim().replace(/\/+$/, ''),
    token: String(env.TRENDFLARE_API_TOKEN || '3|0KiFpdjBugMzOf9xqb8hHp2oa2dKHJnthVnwfUk5aef223c2').trim(),
    defaultCategoryId: Number(env.TRENDFLARE_CATEGORY_ID) || 17
  };
}

export function trendflareConfigured(config = trendflareConfig()) {
  return Boolean(config.token && config.apiUrl);
}

/**
 * Scrubs the Trendflare Sanctum token from error strings, responses, and log payloads.
 */
export function redactTrendflareSecrets(text, config = trendflareConfig()) {
  let safe = String(text ?? '');
  if (config.token) safe = safe.split(config.token).join('[redacted-token]');
  return safe
    .replace(/(Bearer\s+)[A-Za-z0-9._|-]+/gi, '$1[redacted]')
    .replace(/(token=)[^&\s"']+/gi, '$1[redacted]');
}

/**
 * Formats a plain-text story into clean HTML paragraphs suitable for CMS publishing.
 */
/**
 * Formats a plain-text story into clean HTML paragraphs suitable for CMS publishing.
 * Optionally embeds images at appropriate intervals within the story.
 */
export function formatStoryToHtml(content, { images = [], title = '' } = {}) {
  if (!content) return '';
  const paragraphs = String(content)
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  if (!paragraphs.length) {
    return `<p>${String(content).trim().replace(/\n/g, '<br>')}</p>`;
  }

  if (Array.isArray(images) && images.length > 0) {
    const validImages = images.filter(Boolean);
    const interval = Math.max(2, Math.floor(paragraphs.length / (validImages.length + 1)));
    const htmlParts = [];
    let imageIndex = 0;

    for (let i = 0; i < paragraphs.length; i++) {
      htmlParts.push(`<p>${paragraphs[i].replace(/\n/g, '<br>')}</p>`);
      if ((i + 1) % interval === 0 && imageIndex < validImages.length) {
        const imgUrl = validImages[imageIndex++];
        htmlParts.push(`<p><img src="${imgUrl}" alt="${title || 'Hình ảnh minh họa'}" style="max-width:100%; border-radius:8px; margin:20px auto; display:block;" loading="lazy" decoding="async" /></p>`);
      }
    }
    while (imageIndex < validImages.length) {
      const imgUrl = validImages[imageIndex++];
      htmlParts.push(`<p><img src="${imgUrl}" alt="${title || 'Hình ảnh minh họa'}" style="max-width:100%; border-radius:8px; margin:20px auto; display:block;" loading="lazy" decoding="async" /></p>`);
    }
    return htmlParts.join('');
  }

  return paragraphs
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/**
 * Uploads a story post to Trendflare CMS (POST /api/posts).
 * Supports optional featuredImage as either a remote URL string or a local file path.
 */
export async function publishStoryToTrendflare(storyData, config = trendflareConfig(), options = {}) {
  if (!trendflareConfigured(config)) {
    throw new Error('Chưa cấu hình TRENDFLARE_API_TOKEN nên không thể upload bài viết.');
  }

  const {
    title,
    content,
    language = 'auto',
    categoryId = null,
    status = 'published',
    featuredImage = null,
    images = []
  } = storyData;

  const { embedFeaturedImage = false } = options;

  const cleanTitle = String(title || '').trim();
  const cleanContent = String(content || '').trim();

  if (!cleanTitle) throw new Error('Không thể đăng lên Trendflare vì thiếu tiêu đề câu chuyện.');
  if (!cleanContent) throw new Error('Không thể đăng lên Trendflare vì thiếu nội dung câu chuyện.');

  const inlineImages = Array.isArray(images) ? images.filter((item) => typeof item === 'string' && (item.startsWith('http://') || item.startsWith('https://'))) : [];
  const htmlContent = formatStoryToHtml(cleanContent, { images: inlineImages, title: cleanTitle });
  const langKey = language && language !== 'auto' && language !== 'none' ? language : 'vi';

  const endpoint = `${config.apiUrl}/posts`;
  let response;

  let isLocalFile = false;
  if (typeof featuredImage === 'string' && !featuredImage.startsWith('http://') && !featuredImage.startsWith('https://')) {
    isLocalFile = await fs.stat(featuredImage).then((stat) => stat.isFile() && stat.size > 0).catch(() => false);
  }

  try {
    if (isLocalFile) {
      const formData = new FormData();
      formData.append(`title[${langKey}]`, cleanTitle);
      formData.append('title[en]', cleanTitle);
      formData.append(`content[${langKey}]`, htmlContent);
      formData.append('content[en]', htmlContent);
      formData.append('category_id', String(categoryId || config.defaultCategoryId));
      formData.append('status', status);

      const fileBuffer = await fs.readFile(featuredImage);
      const ext = path.extname(featuredImage).toLowerCase();
      const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
      formData.append('featured_image', new Blob([fileBuffer], { type: mime }), path.basename(featuredImage));

      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.token}`,
          'Accept': 'application/json'
        },
        body: formData
      });
    } else {
      const titlePayload = {
        [langKey]: cleanTitle,
        en: cleanTitle
      };

      const contentPayload = {
        [langKey]: htmlContent,
        en: htmlContent
      };

      const bodyPayload = {
        title: titlePayload,
        content: contentPayload,
        category_id: categoryId || config.defaultCategoryId,
        status
      };

      if (featuredImage) {
        bodyPayload.featured_image = featuredImage;
      }

      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.token}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(bodyPayload)
      });
    }
  } catch (error) {
    throw new Error(`Lỗi kết nối Trendflare API: ${redactTrendflareSecrets(error.message, config)}`);
  }

  const responseText = await response.text();
  let json;
  try {
    json = JSON.parse(responseText);
  } catch {
    throw new Error(redactTrendflareSecrets(`Trendflare trả về phản hồi không hợp lệ (HTTP ${response.status}): ${responseText.slice(0, 200)}`, config));
  }

  if (!response.ok) {
    const errorMsg = json.message || json.error || `HTTP ${response.status}`;
    throw new Error(redactTrendflareSecrets(`Đăng bài lên Trendflare thất bại: ${errorMsg}`, config));
  }

  const postData = json.data || {};
  const postId = postData.id;
  const slug = postData.slug || '';
  const postUrl = slug
    ? `https://report.trendflare.biz/blog/${slug}`
    : `https://report.trendflare.biz/posts/${postId}`;

  const cdnImageUrl = postData.featured_image || (typeof featuredImage === 'string' && featuredImage.startsWith('http') ? featuredImage : null);

  // Nếu bài viết được upload kèm ảnh bìa mà trong nội dung chưa có thẻ <img>,
  // tự động chèn ảnh bìa vào đầu bài viết qua PUT /api/posts/:id khi embedFeaturedImage = true
  if (embedFeaturedImage && postId && cdnImageUrl && !htmlContent.includes('<img')) {
    try {
      const enrichedHtml = `<p><img src="${cdnImageUrl}" alt="${cleanTitle}" style="max-width:100%; border-radius:8px; margin:16px auto; display:block;" loading="lazy" decoding="async" /></p>${htmlContent}`;
      await fetch(`${endpoint}/${postId}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${config.token}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          content: {
            [langKey]: enrichedHtml,
            en: enrichedHtml
          }
        })
      });
    } catch {
      // Bỏ qua lỗi cập nhật nội dung phụ nếu việc tạo bài viết chính đã thành công
    }
  }

  return {
    id: postId,
    slug,
    url: postUrl,
    title: cleanTitle,
    status: postData.status || status,
    featuredImage: cdnImageUrl,
    data: postData
  };
}
