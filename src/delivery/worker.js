import {
  claimNextDeliveryJob,
  getDeliverySource,
  finishDelivery,
  failDelivery,
  renewDeliveryLease,
  recoverExpiredDeliveryJobs,
} from './repository.js';
import { classifyDeliverySendError } from './error-classifier.js';

async function notifyRequester(bot, userId, status) {
  const text = status === 'uncertain'
    ? 'FileStore: delivery outcome is uncertain. Please check your chat before requesting the file again.'
    : 'FileStore: delivery failed. Please check the bot status or retry later.';
  try { await bot.telegram.sendMessage(userId, text); } catch {}
}


export function createDeliveryWorker(bot, pool, logger, identity, workerOptions = {}) {
  let timer;
  let busy = false;
  let lastRecoveryAt = 0;

  async function poll() {
    if (busy) return;
    busy = true;
    try {
      if (Date.now() - lastRecoveryAt > 30_000) {
        await recoverExpiredDeliveryJobs(pool);
        lastRecoveryAt = Date.now();
      }
      const claim = await claimNextDeliveryJob(pool, identity, workerOptions);
      if (!claim) return;

      // Refresh the lease during slow Telegram operations to prevent other workers reclaiming it.
      const leaseTimer = setInterval(() => {
        void renewDeliveryLease(pool, claim.jobId, identity).then((renewed) => {
          if (!renewed) logger.warn({ jobId: claim.jobId, identity }, 'Delivery lease renewal rejected');
        }).catch((error) => logger.warn({ jobId: claim.jobId, error: error.message }, 'Delivery lease renewal failed'));
      }, 30_000);
      leaseTimer.unref?.();
      try {
      const source = await getDeliverySource(pool, claim.fileId);
      if (!source) {
        await failDelivery(pool, claim, 'failed', 'SOURCE_UNAVAILABLE', 'Indexed file has no enabled storage source.');
        await notifyRequester(bot, claim.requesterTelegramId, 'failed');
        return;
      }

      let sent;
      try {
        sent = await bot.telegram.copyMessage(claim.requesterTelegramId, source.storage_chat_id, source.telegram_message_id);
      } catch (error) {
        const status = classifyDeliverySendError(error);
        await failDelivery(pool, claim, status, error.response?.error_code ?? error.code ?? null, error.response?.description ?? error.message);
        await notifyRequester(bot, claim.requesterTelegramId, status);
        logger.warn({ jobId: claim.jobId, status, error: error.message }, 'Delivery send failed');
        return;
      }

      try {
        await finishDelivery(pool, claim, sent.message_id, identity);
        logger.info({ jobId: claim.jobId, fileCode: source.file_code, recipient: claim.requesterTelegramId }, 'File delivered');
      } catch (error) {
        // Telegram accepted the copy but the database confirmation failed: never retry blindly.
        try {
          await failDelivery(pool, claim, 'uncertain', 'DB_CONFIRMATION_FAILED', error.message);
          await notifyRequester(bot, claim.requesterTelegramId, 'uncertain');
        } catch (markError) {
          logger.error({ jobId: claim.jobId, error: markError.message }, 'Could not mark delivery outcome uncertain');
        }
        logger.error({ jobId: claim.jobId, error: error.message }, 'Delivery confirmation failed');
      }
    } catch (error) {
      logger.error({ error: error.message }, 'Delivery worker poll failed');
      } finally {
        clearInterval(leaseTimer);
      }
    } finally {
      busy = false;
    }
  }

  return {
    start() {
      if (timer) return;
      void poll();
      timer = setInterval(() => void poll(), 1_500);
      timer.unref?.();
      logger.info({ identity }, 'Delivery worker started');
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      logger.info({ identity }, 'Delivery worker stopped');
    },
  };
}
