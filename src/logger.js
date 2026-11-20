import pino from 'pino';

export function createLogger(config) {
  return pino({
    level: config.logLevel,
    redact: {
      paths: ['mainBotToken', 'databaseUrl', 'tokenEncryptionKey', '*.token', '*.apiKey', '*.secret', 'req.headers.authorization'],
      censor: '[REDACTED]',
    },
    base: { app: 'filestore', env: config.nodeEnv },
  });
}
