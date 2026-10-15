import 'dotenv/config';

function optionalInteger(name, fallback = 0) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const ownerId = optionalInteger('OWNER_ID');
const adminIds = (process.env.ADMIN_IDS || '').split(',').map((value) => value.trim()).filter(Boolean).map(Number);
if (adminIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
  throw new Error('ADMIN_IDS must be a comma-separated list of positive numeric Telegram user IDs');
}
const dbChannelId = optionalInteger('DB_CHANNEL_ID');
const shortenerUrlTemplate = process.env.SHORTENER_URL_TEMPLATE?.trim() || '';
const shortenerCallbackSecret = process.env.SHORTENER_CALLBACK_SECRET?.trim() || '';

if (Boolean(shortenerUrlTemplate) !== Boolean(shortenerCallbackSecret)) {
  throw new Error('SHORTENER_URL_TEMPLATE and SHORTENER_CALLBACK_SECRET must both be set to enable shortener verification.');
}
if (shortenerUrlTemplate && (!shortenerUrlTemplate.startsWith('https://') || !shortenerUrlTemplate.includes('{url}') || !shortenerUrlTemplate.includes('{click_id}'))) {
  throw new Error('SHORTENER_URL_TEMPLATE must be HTTPS and contain both {url} and {click_id} placeholders.');
}

export const config = Object.freeze({
  botToken: required('BOT_TOKEN'),
  ownerId,
  adminIds: [...new Set([ownerId, ...adminIds])],
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
  autoDeleteSeconds: optionalInteger('AUTO_DELETE_SECONDS', 0),
  starsPrice: optionalInteger('STARS_PRICE', 100),
  starsDays: optionalInteger('STARS_DAYS', 30),
  shortenerUrlTemplate,
  shortenerCallbackSecret,
});

if (!Number.isSafeInteger(config.ownerId) || config.ownerId <= 0) {
  throw new Error('OWNER_ID must be your positive numeric Telegram user ID');
}
if (!Number.isSafeInteger(config.dbChannelId) || config.dbChannelId >= 0) {
  throw new Error('DB_CHANNEL_ID must be a negative Telegram channel ID, usually starting with -100');
}
if (config.autoDeleteSeconds < 0 || config.starsPrice < 1 || config.starsDays < 1) {
  throw new Error('AUTO_DELETE_SECONDS must be >= 0; STARS_PRICE and STARS_DAYS must be positive integers.');
}
