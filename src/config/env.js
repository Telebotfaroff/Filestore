import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  MAIN_BOT_TOKEN: z.string().trim().min(1, 'MAIN_BOT_TOKEN is required'),
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
  return Object.freeze({
    nodeEnv: value.NODE_ENV,
    logLevel: value.LOG_LEVEL,
    mainBotToken: value.MAIN_BOT_TOKEN,
    databaseUrl: value.DATABASE_URL,
    tokenEncryptionKey: value.TOKEN_ENCRYPTION_KEY,
    adminIds: Object.freeze(parseAdminIds(value.ADMIN_IDS)),
  });
}
