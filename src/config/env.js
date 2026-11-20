import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  MAIN_BOT_TOKEN: z.string().trim().min(1, 'MAIN_BOT_TOKEN is required'),
  DELIVERY_BOT_TOKEN: z.string().trim().optional().default(''),
  DATABASE_URL: z.string().trim().min(1, 'DATABASE_URL is required'),
  TOKEN_ENCRYPTION_KEY: z.string().trim().optional().default(''),
  ADMIN_IDS: z.string().trim().optional().default(''),
});

function parseAdminIds(value) {
  if (!value) return [];
  const parsed = value.split(',').map((item) => item.trim()).filter(Boolean).map((id) => {
    if (!/^\d+$/.test(id)) throw new Error('ADMIN_IDS must be comma-separated numeric Telegram user IDs');
    const n = Number(id);
    if (!Number.isSafeInteger(n)) throw new Error('ADMIN_IDS contains an invalid Telegram user ID');
    return n;
  });
  return [...new Set(parsed)];
}

export function loadConfig(source = process.env) {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `- ${issue.path.join('.') || 'config'}: ${issue.message}`).join('\n');
    throw new Error(`Invalid FileStore configuration:\n${details}`);
  }
  const value = result.data;
  const adminIds = parseAdminIds(value.ADMIN_IDS);
  if (adminIds.length === 0) throw new Error('ADMIN_IDS must contain at least one Telegram administrator ID');
  return Object.freeze({
    nodeEnv: value.NODE_ENV,
    logLevel: value.LOG_LEVEL,
    mainBotToken: value.MAIN_BOT_TOKEN,
    deliveryBotToken: value.DELIVERY_BOT_TOKEN,
    databaseUrl: value.DATABASE_URL,
    tokenEncryptionKey: value.TOKEN_ENCRYPTION_KEY,
    adminIds: Object.freeze(adminIds),
  });
}

const databaseOnlySchema = z.object({
  DATABASE_URL: z.string().trim().min(1, 'DATABASE_URL is required'),
});

export function loadDatabaseConfig(source = process.env) {
  const result = databaseOnlySchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `- ${issue.path.join('.') || 'config'}: ${issue.message}`).join('\n');
    throw new Error(`Invalid FileStore database configuration:\n${details}`);
  }
  return Object.freeze({ databaseUrl: result.data.DATABASE_URL });
}

export function loadRuntimeConfig(source = process.env) {
  const port = Number(source.FILESTORE_PORT) || 3000;
  try {
    const strict = loadConfig(source);
    return Object.freeze({ ...strict, port, previewMode: false, missingEnv: Object.freeze([]) });
  } catch {
    const missingEnv = [];
    if (!String(source.MAIN_BOT_TOKEN ?? '').trim()) missingEnv.push('MAIN_BOT_TOKEN');
    if (!String(source.DATABASE_URL ?? '').trim()) missingEnv.push('DATABASE_URL');
    if (!String(source.ADMIN_IDS ?? '').trim()) missingEnv.push('ADMIN_IDS');
    const nodeEnv = ['development', 'test', 'production'].includes(source.NODE_ENV) ? source.NODE_ENV : 'development';
    const logLevel = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(source.LOG_LEVEL) ? source.LOG_LEVEL : 'info';
    let adminIds = [];
    try { adminIds = parseAdminIds(String(source.ADMIN_IDS ?? '').trim()); } catch {}
    return Object.freeze({
      nodeEnv,
      logLevel,
      port,
      mainBotToken: String(source.MAIN_BOT_TOKEN ?? '').trim(),
      deliveryBotToken: String(source.DELIVERY_BOT_TOKEN ?? '').trim(),
      databaseUrl: String(source.DATABASE_URL ?? '').trim(),
      tokenEncryptionKey: String(source.TOKEN_ENCRYPTION_KEY ?? '').trim(),
      adminIds: Object.freeze(adminIds),
      previewMode: true,
      missingEnv: Object.freeze(missingEnv),
    });
  }
}
