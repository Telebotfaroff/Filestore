export function parseStorageIdentifier(input) {
  const value = String(input ?? '').trim();
  if (/^-?\d+$/.test(value)) {
    const id = Number(value);
    if (!Number.isSafeInteger(id)) throw new Error('Channel ID is outside the supported numeric range');
    return id;
  }
  if (/^@[A-Za-z0-9_]{5,32}$/.test(value)) return value;

  if (/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?:\+|joinchat\/)/i.test(value)) {
    throw new Error('Invite links (t.me/+...) cannot identify a channel. Add this bot as an administrator in your channel, then send its -100... channel ID, @username, or forward any post from the channel.');
  }

  const privatePostMatch = value.match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/c\/(\d+)(?:\/\d+)?\/?(?:\?.*)?$/i);
  if (privatePostMatch) {
    const id = -Number('100' + privatePostMatch[1]);
    if (!Number.isSafeInteger(id)) throw new Error('Channel ID is outside the supported numeric range');
    return id;
  }

  const publicLinkMatch = value.match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{5,32})(?:\/\d+)?\/?(?:\?.*)?$/i);
  if (publicLinkMatch) {
    return '@' + publicLinkMatch[1];
  }

  throw new Error('Enter a numeric channel ID (-100...), a @channelusername, or a t.me channel link');
}
