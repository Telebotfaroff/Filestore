import test from 'node:test';
import assert from 'node:assert/strict';
import { createFileCode } from '../src/storage/file-code.js';

test('generates uppercase ten-character hexadecimal codes', () => {
  const code = createFileCode();
  assert.match(code, /^[A-F0-9]{10}$/);
});
