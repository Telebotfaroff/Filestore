import test from 'node:test';
import assert from 'node:assert/strict';
import { formatFileSize } from '../src/storage/file-query.js';

test('formats file sizes with sensible units', () => {
  assert.equal(formatFileSize(0), '0 B');
  assert.equal(formatFileSize(1024), '1.0 KB');
  assert.equal(formatFileSize(1024 * 1024), '1.0 MB');
  assert.equal(formatFileSize(null), 'Unknown size');
});
