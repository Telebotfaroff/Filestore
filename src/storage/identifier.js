export function parseStorageIdentifier(input) {
  const value = String(input ?? '').trim();
  if (/^-?\d+$/.test(value)) {
    const id = Number(value);
    if (!Number.isSafeInteger(id)) throw new Error('Channel ID is outside the supported numeric range');
    return id;
  }
  if (/^@[A-Za-z0-9_]{5,32}$/.test(value)) return value;
  throw new Error('Enter a numeric channel ID or a valid @channelusername');
}
