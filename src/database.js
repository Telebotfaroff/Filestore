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
  ]);

  console.info(`[database] Connected to MongoDB database "${config.mongoDbName}"`);
  return database;
}

export function collection(name) {
  if (!database) throw new Error('Database is not connected');
  return database.collection(name);
}

export async function closeDatabase() {
  await client.close();
}
