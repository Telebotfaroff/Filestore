import { createHash } from 'node:crypto';

export function normalizeSecret(value) {
  return String(value ?? '').trim().replace(/^['"]+|['"]+$/g, '').trim();
}

export function normalizeUpperCode(code) {
  return String(code ?? '').trim().toUpperCase();
}

export function hashUpperCode(code) {
  return createHash('sha256').update(normalizeUpperCode(code)).digest('hex');
}

export function parsePositiveInt(value, label = 'ID') {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return id;
}

export function parseTelegramUserId(value, label = 'Telegram user ID') {
  if (!/^\d{1,20}$/.test(String(value ?? ''))) {
    throw new Error(`${label} must be numeric.`);
  }
  const id = BigInt(value);
  if (id <= 0n || id > 9223372036854775807n) {
    throw new Error(`${label} out of range.`);
  }
  return id.toString();
}

export function parseMinorAmount(value, { allowZero = false, label = 'Price' } = {}) {
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(String(value ?? ''))) {
    throw new Error(`${label} must be numeric with up to 2 decimals.`);
  }
  const minor = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(minor) || (!allowZero && minor < 1)) {
    throw new Error(`${label} must be greater than zero.`);
  }
  return minor;
}

export function parseCurrencyCode(value) {
  const code = String(value ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new Error('Currency must be a 3-letter code.');
  }
  return code;
}

export function parseOptionalExpiryDays(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new Error('Expiry days must be 1–3650.');
  }
  return new Date(Date.now() + days * 86400000);
}

export function formatMoney(minor, currency) {
  return `${(Number(minor ?? 0) / 100).toFixed(2)} ${currency}`;
}

export function formatRevenueSummary(revenueByCurrency) {
  return Object.entries(revenueByCurrency ?? {})
    .map(([currency, minor]) => formatMoney(minor, currency))
    .join(' · ') || 'none';
}
