import 'dotenv/config';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optionalInteger(name, fallback = 0) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

const ownerId = optionalInteger('OWNER_ID');
const dbChannelId = optionalInteger('DB_CHANNEL_ID');

export const config = Object.freeze({
  botToken: required('BOT_TOKEN'),
  ownerId,
  dbChannelId,
  mongoUri: required('MONGODB_URI'),
  mongoDbName: process.env.MONGODB_DB_NAME?.trim() || 'filestore',
  forceSubChannel: process.env.FORCE_SUB_CHANNEL?.trim() || '',
  forceSubUrl: process.env.FORCE_SUB_URL?.trim() || '',
  updatesUrl: process.env.UPDATES_URL?.trim() || '',
  supportUrl: process.env.SUPPORT_URL?.trim() || '',
  port: optionalInteger('PORT', 3000),
  logLevel: process.env.LOG_LEVEL?.trim() || 'info',
  privateUploadsEnabled: (process.env.PRIVATE_UPLOADS_ENABLED || 'true').toLowerCase() !== 'false',
});

if (!Number.isSafeInteger(config.ownerId) || config.ownerId <= 0) {
  throw new Error('OWNER_ID must be your positive numeric Telegram user ID');
}
if (!Number.isSafeInteger(config.dbChannelId) || config.dbChannelId >= 0) {
  throw new Error('DB_CHANNEL_ID must be a negative Telegram channel ID, usually starting with -100');
}
