import { config } from './config.js';
import { collection } from './database.js';

const now = () => new Date();
let timer;
let running = false;

export async function getAutoDeleteSeconds() {
  const setting = await collection('settings').findOne({ key: 'autoDeleteSeconds' });
  return Number.isSafeInteger(setting?.value) && setting.value >= 0
    ? setting.value
    : config.autoDeleteSeconds;
}

export async function startMaintenance(bot) {
  if (timer) return;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const current = now();
      const expiredBatches = collection('batches').find({ expiresAt: { $lte: current } }).limit(100);
      for await (const batch of expiredBatches) {
        await collection('batches').deleteOne({ _id: batch._id });
      }

      const expiredFiles = collection('files').find({ expiresAt: { $lte: current } }).limit(100);
      for await (const file of expiredFiles) {
        try {
          await bot.telegram.deleteMessage(config.dbChannelId, file.storageMessageId);
        } catch (error) {
          // A post may already have been deleted manually; the metadata must still expire.
          if (![400, 404].includes(error?.response?.error_code)) {
            console.error('[maintenance] Telegram deletion failed:', error.message);
            continue;
          }
        }
        await collection('files').deleteOne({ _id: file._id });
        await collection('batches').updateMany({}, { $pull: { fileIds: file._id } });
      }
    } catch (error) {
      console.error('[maintenance] Expiry sweep failed:', error);
    } finally {
      running = false;
    }
  };
  await run();
  timer = setInterval(run, 60_000);
  timer.unref?.();
}

export function stopMaintenance() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
