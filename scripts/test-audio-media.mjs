import assert from 'node:assert/strict';
import { prepareMedia } from '../server/audio-media.js';

function makeWave({ durationSeconds = 2, frequency = 880, sampleRate = 16000 } = {}) {
  const samples = durationSeconds * sampleRate;
  const dataBytes = samples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples; index += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 12000);
    buffer.writeInt16LE(sample, 44 + index * 2);
  }
  return buffer;
}

const source = makeWave();
const sourceFile = { buffer: source, size: source.length, mimetype: 'audio/wav', originalname: 'test.wav' };

process.env.AUDIO_ASSISTANT_COMPRESSION_TARGET_BYTES = '5000';
const compressed = await prepareMedia(sourceFile);
assert.equal(compressed.mimetype, 'audio/mpeg');
assert.equal(compressed.compressed, true);
assert.equal(compressed.converted, false);
assert.equal(compressed.compressionBitrate, '16k');
assert.ok(compressed.size > 0 && compressed.size < source.length);
assert.equal(compressed.compressionTargetMet, true);

process.env.AUDIO_ASSISTANT_COMPRESSION_TARGET_BYTES = '999999999';
const alwaysCompressed = await prepareMedia(sourceFile);
assert.equal(alwaysCompressed.compressed, true);
assert.equal(alwaysCompressed.mimetype, 'audio/mpeg');
assert.equal(alwaysCompressed.compressionBitrate, '32k');
assert.notEqual(alwaysCompressed.buffer, source);

const converted = await prepareMedia({ ...sourceFile, mimetype: 'application/octet-stream', originalname: 'тест (видео).avi' });
assert.equal(converted.converted, true);
assert.equal(converted.compressed, true);
assert.equal(converted.mimetype, 'audio/mpeg');
assert.equal(converted.originalname, 'тест _видео_.mp3');

await assert.rejects(
  () => prepareMedia({ buffer: Buffer.from('bad'), size: 3, mimetype: 'application/octet-stream', originalname: 'test.txt' }),
  error => error.code === 'unsupported_media_format'
);

console.log(JSON.stringify({
  source_bytes: source.length,
  compressed_bytes: compressed.size,
  bitrate: compressed.compressionBitrate,
  compression_ratio: compressed.compressionRatio,
  target_met: compressed.compressionTargetMet
}, null, 2));
