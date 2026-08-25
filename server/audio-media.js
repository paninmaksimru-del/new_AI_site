import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { extname, join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const DIRECT_MEDIA_TYPES = new Set(['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/webm', 'audio/flac', 'video/mp4', 'video/webm']);
const CONVERTIBLE_MEDIA_EXTENSIONS = new Set(['.3g2', '.3gp', '.aif', '.aiff', '.amr', '.avi', '.caf', '.flv', '.m4a', '.m4v', '.mka', '.mkv', '.mov', '.mts', '.m2ts', '.oga', '.opus', '.ra', '.rm', '.wma', '.wmv']);
export const MEDIA_COMPRESSION_THRESHOLD_BYTES = 50 * 1024 * 1024;
const MEDIA_COMPRESSION_TARGET_BYTES = 50 * 1024 * 1024;

export const MAX_AUDIO_UPLOAD_BYTES = 1000 * 1024 * 1024;

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function compressionBitrates() {
  const values = String(process.env.AUDIO_ASSISTANT_COMPRESSED_BITRATES || '32k,24k,16k')
    .split(',')
    .map(value => value.trim())
    .filter(value => /^\d+k$/i.test(value));
  return values.length ? values : ['32k', '24k', '16k'];
}

function externalFilename(value) {
  const stem = String(value || 'audio')
    .replace(/\.[^.]+$/, '')
    .replace(/[^\p{L}\p{N}._ -]+/gu, '_')
    .trim()
    .slice(0, 80) || 'audio';
  return `${stem}.mp3`;
}

export async function prepareMedia(file) {
  const sourceType = String(file.mimetype || 'application/octet-stream').toLowerCase();
  const extension = extname(file.originalname || '').toLowerCase() || '.bin';
  const isDirectMedia = DIRECT_MEDIA_TYPES.has(sourceType);
  const isMedia = sourceType.startsWith('audio/') || sourceType.startsWith('video/') || CONVERTIBLE_MEDIA_EXTENSIONS.has(extension);
  const compressionThreshold = positiveNumber(process.env.AUDIO_ASSISTANT_COMPRESSION_THRESHOLD_BYTES, MEDIA_COMPRESSION_THRESHOLD_BYTES);
  const compressionTarget = positiveNumber(process.env.AUDIO_ASSISTANT_COMPRESSION_TARGET_BYTES, MEDIA_COMPRESSION_TARGET_BYTES);
  const maxUploadBytes = positiveNumber(process.env.AUDIO_ASSISTANT_MAX_UPLOAD_BYTES, MAX_AUDIO_UPLOAD_BYTES);
  const needsCompression = file.size >= compressionThreshold;

  if (isDirectMedia && !needsCompression) {
    return {
      ...file,
      converted: false,
      compressed: false,
      compressionBitrate: null,
      compressionRatio: null,
      compressionTargetMet: null,
      preparationSteps: [],
      sourceType,
      sourceSize: file.size
    };
  }
  if (!isMedia) {
    const error = new Error('Файл не похож на поддерживаемое аудио или видео.');
    error.code = 'unsupported_media_format';
    error.status = 422;
    throw error;
  }

  const workDir = await mkdtemp(join(tmpdir(), 'audio-assistant-'));
  const inputPath = join(workDir, `input${extension}`);
  try {
    await writeFile(inputPath, file.buffer);
    const convertedBitrate = /^\d+k$/i.test(String(process.env.AUDIO_ASSISTANT_BITRATE || '64k')) ? process.env.AUDIO_ASSISTANT_BITRATE || '64k' : '64k';
    const bitrates = needsCompression ? compressionBitrates() : [convertedBitrate];
    let buffer = Buffer.alloc(0);
    let compressionBitrate = bitrates.at(-1);

    for (const [index, bitrate] of bitrates.entries()) {
      const outputPath = join(workDir, `output-${index}.mp3`);
      await execFileAsync(process.env.FFMPEG_PATH || 'ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', inputPath,
        '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000',
        '-codec:a', 'libmp3lame', '-b:a', bitrate, '-f', 'mp3', outputPath
      ], {
        timeout: positiveNumber(process.env.AUDIO_ASSISTANT_CONVERSION_TIMEOUT_MS, 600000),
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024
      });
      buffer = await readFile(outputPath);
      compressionBitrate = bitrate;
      if (buffer.length && (!needsCompression || buffer.length <= compressionTarget)) break;
    }

    if (!buffer.length) {
      const error = new Error('После подготовки получился пустой аудиофайл.');
      error.code = 'media_conversion_failed';
      error.status = 422;
      throw error;
    }
    if (buffer.length > maxUploadBytes) {
      const error = new Error('Подготовленный аудиофайл превышает допустимый размер.');
      error.code = 'payload_too_large';
      error.status = 413;
      throw error;
    }

    return {
      ...file,
      buffer,
      size: buffer.length,
      mimetype: 'audio/mpeg',
      originalname: externalFilename(file.originalname),
      converted: !isDirectMedia,
      compressed: true,
      compressionBitrate,
      compressionRatio: Number((buffer.length / file.size).toFixed(4)),
      compressionTargetMet: needsCompression ? buffer.length <= compressionTarget : null,
      preparationSteps: [!isDirectMedia ? 'convert' : null, 'compress'].filter(Boolean),
      sourceType,
      sourceSize: file.size
    };
  } catch (error) {
    if (error.status && error.code) throw error;
    const wrapped = new Error('Не удалось преобразовать медиафайл. Проверьте формат записи.');
    wrapped.code = error.code === 'ENOENT' ? 'ffmpeg_unavailable' : error.killed ? 'media_conversion_timeout' : 'media_conversion_failed';
    wrapped.status = error.code === 'ENOENT' ? 503 : error.killed ? 504 : 422;
    throw wrapped;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
