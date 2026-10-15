import { randomBytes } from 'node:crypto';
import { collection, runInTransaction } from './database.js';
import { config } from './config.js';

const now = () => new Date();
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export function shortenerEnabled() {
  return Boolean(config.shortenerUrlTemplate && config.shortenerCallbackSecret);
}

export async function needsVerification(userId) {
  if (!shortenerEnabled()) return false;
  const user = await collection('users').findOne({ userId }, { projection: { verifiedUntil: 1, premiumUntil: 1 } });
  const current = now();
  if (user?.premiumUntil && user.premiumUntil > current) return false;
  return !(user?.verifiedUntil && user.verifiedUntil > current);
}

export async function createShortenerLink(userId, destinationUrl) {
  if (!shortenerEnabled()) return null;
  const sessionId = randomBytes(24).toString('base64url');
  const createdAt = now();
  await collection('verificationSessions').insertOne({
    sessionId,
    userId,
    status: 'pending',
    createdAt,
    expiresAt: new Date(createdAt.getTime() + 30 * 60 * 1000),
  });

  const encodedUrl = encodeURIComponent(destinationUrl);
  const url = config.shortenerUrlTemplate
    .replaceAll('{url}', encodedUrl)
    .replaceAll('{click_id}', encodeURIComponent(sessionId));
  if (url === config.shortenerUrlTemplate || !url.startsWith('https://')) {
    await collection('verificationSessions').deleteOne({ sessionId });
    throw new Error('SHORTENER_URL_TEMPLATE must be an HTTPS URL template containing {url} and preferably {click_id}.');
  }
  return url;
}

export async function acceptShortenerCallback(sessionId, signature, verifySignature) {
  if (!shortenerEnabled() || !sessionId || !verifySignature(sessionId, signature, config.shortenerCallbackSecret)) {
    return false;
  }
  const session = await collection('verificationSessions').findOne({
    sessionId,
    status: 'pending',
    expiresAt: { $gt: now() },
  });
  if (!session) return false;

  return runInTransaction(async (transactionSession) => {
    const result = await collection('verificationSessions').updateOne(
      { _id: session._id, status: 'pending', expiresAt: { $gt: now() } },
      { $set: { status: 'completed', completedAt: now() } },
      { session: transactionSession },
    );
    if (!result.modifiedCount) return false;
    await collection('users').updateOne(
      { userId: session.userId },
      { $set: { verifiedUntil: new Date(Date.now() + SIX_HOURS_MS) } },
      { upsert: true, session: transactionSession },
    );
    return true;
  });
}
