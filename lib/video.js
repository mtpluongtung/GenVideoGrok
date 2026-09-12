import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';

const supportedAspectRatios = [['16:9', 16 / 9], ['9:16', 9 / 16], ['1:1', 1], ['3:2', 3 / 2], ['2:3', 2 / 3]];
const aspectCanvas = {
  '1080p': {
    '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080],
    '3:2': [1620, 1080], '2:3': [1080, 1620]
  },
  '720p': {
    '16:9': [1280, 720], '9:16': [720, 1280], '1:1': [720, 720],
    '3:2': [1080, 720], '2:3': [720, 1080]
  }
};

export function inferAspectRatio(width, height) {
  if (!width || !height) return null;
  const ratio = width / height;
  return [...supportedAspectRatios]
    .sort((left, right) => Math.abs(Math.log(ratio / left[1])) - Math.abs(Math.log(ratio / right[1])))[0][0];
}

export function aspectRatioMatches(width, height, expected, tolerance = 0.06) {
  if (!width || !height || !expected) return false;
  const target = supportedAspectRatios.find(([name]) => name === expected)?.[1];
  if (!target) return false;
  return Math.abs((width / height) / target - 1) <= tolerance;
}

export function inferVideoResolution(width, height) {
  const shortEdge = Math.min(Number(width) || 0, Number(height) || 0);
  if (shortEdge >= 1000) return '1080p';
  if (shortEdge >= 700) return '720p';
  if (shortEdge >= 460) return '480p';
  return width && height ? `${width}x${height}` : null;
}

function run(args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || allowFailure) resolve(stderr);
      else reject(new Error(`FFmpeg thất bại (${code}): ${stderr.slice(-1200)}`));
    });
  });
}

export async function getDuration(file) {
  return (await getVideoMetadata(file)).duration;
}

export async function getVideoMetadata(file) {
  const stderr = await run(['-hide_banner', '-i', file], { allowFailure: true });
  const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) throw new Error('Không đọc được thời lượng video nguồn.');
  const videoLine = stderr.split(/\r?\n/).find((line) => /Stream .*Video:/i.test(line));
  const dimensions = videoLine?.match(/(?:^|[^\d])(\d{2,5})x(\d{2,5})(?:[^\d]|$)/);
  const frameRate = videoLine?.match(/(\d+(?:\.\d+)?)\s+fps\b/i);
  const rotationMatch = stderr.match(/rotation of\s+(-?\d+(?:\.\d+)?)\s+degrees/i);
  const rotation = rotationMatch ? Number(rotationMatch[1]) : 0;
  const codedWidth = dimensions ? Number(dimensions[1]) : null;
  const codedHeight = dimensions ? Number(dimensions[2]) : null;
  const rotatedSideways = Math.abs(Math.round(rotation / 90)) % 2 === 1;
  return {
    duration: Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]),
    width: rotatedSideways ? codedHeight : codedWidth,
    height: rotatedSideways ? codedWidth : codedHeight,
    codedWidth,
    codedHeight,
    rotation,
    frameRate: frameRate ? Number(frameRate[1]) : null,
    hasAudio: stderr.split(/\r?\n/).some((line) => /Stream .*Audio:/i.test(line))
  };
}

/**
 * Samples frames evenly across a video and tiles them into contact-sheet grids, for models that
 * accept images but not video. Returns each sheet with the time range it covers.
 */
export async function extractContactSheets(source, outputPrefix, {
  duration, secondsPerFrame = 2, minFrames = 6, maxFrames = 36, columns = 3, rows = 3, cellWidth = 720
} = {}) {
  const seconds = Number(duration);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('Không xác định được thời lượng video để trích khung hình.');
  }
  const perSheet = columns * rows;
  const frameCount = Math.min(maxFrames, Math.max(minFrames, Math.round(seconds / secondsPerFrame)));
  const sheetCount = Math.ceil(frameCount / perSheet);
  const fps = frameCount / seconds;
  await fs.mkdir(path.dirname(outputPrefix), { recursive: true });
  await run(['-y', '-i', source,
    '-vf', `fps=${fps.toFixed(6)},scale=${cellWidth}:-2,tile=${columns}x${rows}:padding=4:color=black`,
    '-frames:v', String(sheetCount), '-q:v', '3', `${outputPrefix}-%02d.jpg`]);

  const round = (value) => Math.round(value * 10) / 10;
  const sheets = [];
  for (let index = 0; index < sheetCount; index += 1) {
    const file = `${outputPrefix}-${String(index + 1).padStart(2, '0')}.jpg`;
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.size) break;
    const firstFrame = index * perSheet;
    const lastFrame = Math.min(frameCount, firstFrame + perSheet) - 1;
    sheets.push({
      path: file,
      frames: lastFrame - firstFrame + 1,
      startSeconds: round(firstFrame / fps),
      endSeconds: round(Math.min(seconds, (lastFrame + 1) / fps))
    });
  }
  if (!sheets.length) throw new Error(`Không trích được khung hình từ ${path.basename(source)}.`);
  return sheets;
}

export async function extractStoryKeyframes(source, outputPrefix, {
  duration = null, count = 3, maxLongEdge = 1280
} = {}) {
  const seconds = Number(duration) || (await getVideoMetadata(source)).duration;
  if (!seconds || seconds <= 0) return [];
  const frames = [];
  const step = seconds / (count + 1);
  await fs.mkdir(path.dirname(outputPrefix), { recursive: true });
  for (let i = 1; i <= count; i++) {
    const at = Math.min(seconds - 0.5, Math.max(0.5, i * step));
    const file = `${outputPrefix}-${String(i).padStart(2, '0')}.jpg`;
    try {
      await extractFrame(source, file, { atSeconds: at, maxLongEdge });
      frames.push({ path: file, atSeconds: at });
    } catch {
      // Ignore individual frame failure
    }
  }
  return frames;
}

export async function extractFrame(source, output, {
  atSeconds = null, fromEnd = false, maxLongEdge = 1280, minBytes = 256
} = {}) {
  const args = ['-y'];
  if (fromEnd) args.push('-sseof', '-0.2');
  else if (atSeconds != null) args.push('-ss', Math.max(0, Number(atSeconds) || 0).toFixed(3));
  args.push('-i', source, '-frames:v', '1', '-vf', `scale='min(${maxLongEdge},iw)':-2`, '-q:v', '3', output);
  await run(args);
  const stat = await fs.stat(output).catch(() => null);
  if (!stat || stat.size < minBytes) {
    throw new Error(`Không trích được ảnh tham chiếu từ ${path.basename(source)}.`);
  }
  return output;
}

export async function joinParts(parts, output, jobId, {
  aspectRatio = null, resolution = '1080p', targetWidth = null, targetHeight = null, fps = 30
} = {}) {
  if (!parts.length) throw new Error('Không có clip Grok nào để ghép.');
  if (parts.length === 1) {
    await fs.copyFile(parts[0], output);
    return output;
  }

  const metadata = await Promise.all(parts.map(getVideoMetadata));
  const targetAspect = aspectRatio || inferAspectRatio(metadata[0].width, metadata[0].height);
  const canvas = aspectCanvas[resolution]?.[targetAspect];
  const width = Number(targetWidth || canvas?.[0]);
  const height = Number(targetHeight || canvas?.[1]);
  if (!width || !height || width % 2 || height % 2) throw new Error('Kích thước ghép video phải là số chẵn hợp lệ.');
  if (aspectRatio && metadata.some((item) => !aspectRatioMatches(item.width, item.height, aspectRatio))) {
    throw new Error(`Có clip Grok không đúng tỷ lệ ${aspectRatio}; dừng ghép để tránh video bị méo.`);
  }

  const graph = [];
  const concatInputs = [];
  metadata.forEach((item, index) => {
    const duration = item.duration.toFixed(3);
    graph.push(
      `[${index}:v:0]settb=AVTB,setpts=PTS-STARTPTS,fps=${fps},` +
      `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p,` +
      `tpad=stop_mode=clone:stop_duration=${duration},trim=duration=${duration},setpts=PTS-STARTPTS[v${index}]`
    );
    graph.push(item.hasAudio
      ? `[${index}:a:0]asetpts=PTS-STARTPTS,aresample=48000:async=1:first_pts=0,` +
        `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,apad,` +
        `atrim=duration=${duration},asetpts=PTS-STARTPTS[a${index}]`
      : `anullsrc=r=48000:cl=stereo,atrim=duration=${duration},asetpts=PTS-STARTPTS[a${index}]`);
    concatInputs.push(`[v${index}][a${index}]`);
  });
  graph.push(`${concatInputs.join('')}concat=n=${parts.length}:v=1:a=1[vout][aout]`);

  const temporaryOutput = path.join(path.dirname(output), `${path.parse(output).name}.joining-${crypto.randomUUID()}.mp4`);
  try {
    await run(['-y', ...parts.flatMap((file) => ['-i', file]),
      '-filter_complex', graph.join(';'), '-map', '[vout]', '-map', '[aout]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-fps_mode', 'cfr',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-map_metadata', '-1',
      '-movflags', '+faststart', temporaryOutput
    ]);
    const outputMetadata = await getVideoMetadata(temporaryOutput);
    const expectedDuration = metadata.reduce((sum, item) => sum + item.duration, 0);
    if (outputMetadata.width !== width || outputMetadata.height !== height || !outputMetadata.hasAudio) {
      throw new Error(`FFmpeg tạo output không đồng nhất (${outputMetadata.width}x${outputMetadata.height}, audio=${outputMetadata.hasAudio}).`);
    }
    if (Math.abs(outputMetadata.duration - expectedDuration) > Math.max(1, parts.length * 0.15)) {
      throw new Error(`FFmpeg ghép sai thời lượng: nhận ${outputMetadata.duration.toFixed(2)}s, dự kiến ${expectedDuration.toFixed(2)}s.`);
    }
    await fs.copyFile(temporaryOutput, output);
    return output;
  } finally {
    await fs.rm(temporaryOutput, { force: true });
  }
}
