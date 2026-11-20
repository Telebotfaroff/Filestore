import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMediaMetadata } from '../src/storage/media-metadata.js';

test('extracts video metadata and original filename', () => {
  const message = { video: { file_id: 'file-id', file_unique_id: 'uniq', file_name: 'movie.mp4', mime_type: 'video/mp4', file_size: 2048, duration: 80, width: 1280, height: 720 }, caption: 'caption' };
  const meta = extractMediaMetadata(message, 'ABCD');
  assert.equal(meta.fileType, 'video');
  assert.equal(meta.fileName, 'movie.mp4');
  assert.equal(meta.fileSize, 2048);
  assert.equal(meta.caption, 'caption');
});

test('photo uses highest resolution entry and fallback name', () => {
  const message = { photo: [{ file_id: 'small', file_unique_id: 's' }, { file_id: 'large', file_unique_id: 'l', width: 900, height: 900 }] };
  const meta = extractMediaMetadata(message, 'ZX90');
  assert.equal(meta.telegramFileId, 'large');
  assert.equal(meta.fileName, 'filestore_ZX90.jpg');
  assert.equal(meta.fileType, 'photo');
});

test('unsupported message returns null', () => {
  assert.equal(extractMediaMetadata({ text: 'hello' }, 'ABC'), null);
});
