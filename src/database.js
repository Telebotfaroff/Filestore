import { MongoClient } from 'mongodb';
import { config } from './config.js';

const client = new MongoClient(config.mongoUri, {
  maxPoolSize: 10,
  serverSelectionTimeoutMS: 10000,
});

let database;

export async function connectDatabase() {
  await client.connect();
  database = client.db(config.mongoDbName);

  await Promise.all([
    database.collection('users').createIndex({ userId: 1 }, { unique: true }),
    database.collection('users').createIndex({ lastSeenAt: -1 }),
    database.collection('files').createIndex({ tokenHash: 1 }, { unique: true }),
    database.collection('files').createIndex({ ownerId: 1, createdAt: -1 }),
    database.collection('files').createIndex({ expiresAt: 1 }),
    database.collection('batches').createIndex({ tokenHash: 1 }, { unique: true }),
    database.collection('batches').createIndex({ ownerId: 1, createdAt: -1 }),
    database.collection('batches').createIndex({ expiresAt: 1 }),
    database.collection('posts').createIndex({ tokenHash: 1 }, { unique: true }),
    database.collection('posts').createIndex({ channelId: 1, createdAt: -1 }),
    database.collection('bans').createIndex({ userId: 1 }, { unique: true }),
    database.collection('settings').createIndex({ key: 1 }, { unique: true }),
    database.collection('payments').createIndex({ telegramPaymentChargeId: 1 }, { unique: true }),
    database.collection('verificationSessions').createIndex({ sessionId: 1 }, { unique: true }),
    database.collection('verificationSessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    database.collection('passwordAttempts').createIndex({ userId: 1, tokenHash: 1 }, { unique: true }),
    database.collection('passwordAttempts').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    database.collection('adminAccessLinks').createIndex({ tokenHash: 1 }, { unique: true }),
    database.collection('adminAccessLinks').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    database.collection('adminAccessLinks').createIndex({ userId: 1, expiresAt: -1 }),
    database.collection('adminSessions').createIndex({ tokenHash: 1 }, { unique: true }),
    database.collection('adminSessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    database.collection('adminSessions').createIndex({ userId: 1, expiresAt: -1 }),
    database.collection('adminAuditLogs').createIndex({ createdAt: -1 }),
    database.collection('adminAuditLogs').createIndex({ actorId: 1, createdAt: -1 }),
  ]);

  console.info(`[database] Connected to MongoDB database "${config.mongoDbName}"`);
  return database;
}

export function collection(name) {
  if (!database) throw new Error('Database is not connected');
  return database.collection(name);
}

export async function runInTransaction(work) {
  if (!database) throw new Error('Database is not connected');
  const session = client.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await work(session); });
    return result;
  } finally {
    await session.endSession();
  }
}

export async function closeDatabase() {
  await client.close();
}
