import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDeliverySendError } from '../src/delivery/error-classifier.js';

test('classifies Telegram API responses as definitive failures', () => {
  assert.equal(classifyDeliverySendError({ response: { error_code: 403 } }), 'failed');
});
test('classifies transport errors as uncertain', () => {
  assert.equal(classifyDeliverySendError({ code: 'ETIMEDOUT' }), 'uncertain');
  assert.equal(classifyDeliverySendError(new Error('network timeout')), 'uncertain');
});
