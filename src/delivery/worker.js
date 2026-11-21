import {
  claimNextDeliveryJob,
  getDeliverySource,
  finishDelivery,
  failDelivery,
  renewDeliveryLease,
  recoverExpiredDeliveryJobs,
} from './repository.js';
import { subscribeDeliveryWorkerWake } from './wake.js';
import { classifyDeliverySendError } from './error-classifier.js';

async function notifyRequester(bot, userId, status) {
  const text = status === 'uncertain'
    ? 'FileStore: delivery outcome is uncertain. Please check your chat before requesting the file again.'
    : 'FileStore: delivery failed. Please check the bot status or retry later.';
  try { await bot.telegram.sendMessage(userId, text); } catch {}
}

export function createDeliveryWorker(bot, pool, logger, identity, workerOptions = {}) {
  const RECOVERY_INTERVAL_MS = 60_000;
  let recoveryTimer;
  let unsubscribeWake;
  let busy = false;
  let pendingWake = false;
  let stopped = true;
  let lastRecoveryAt = 0;

  async function processClaim(claim) {
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
    } finally {
      clearInterval(leaseTimer);
    }
  }

  async function run() {
    if (stopped) return;
    if (busy) {
      pendingWake = true;
      return;
    }
    busy = true;
    pendingWake = false;
    try {
      // Recovery is now tied to the slow safety timer, not every queue check.
      if (Date.now() - lastRecoveryAt >= RECOVERY_INTERVAL_MS) {
        await recoverExpiredDeliveryJobs(pool);
        lastRecoveryAt = Date.now();
      }
      // Drain available jobs in one wake cycle. Signals arriving while processing
      // are coalesced and the queue is checked again before the worker sleeps.
      while (!stopped) {
        const claim = await claimNextDeliveryJob(pool, identity, workerOptions);
        if (!claim) break;
        await processClaim(claim);
      }
    } catch (error) {
      logger.error({ error: error.message, identity }, 'Delivery worker run failed');
    } finally {
      busy = false;
      if (!stopped && pendingWake) void run();
    }
  }

  function wake(reason = 'signal') {
    if (stopped) return;
    pendingWake = true;
    if (!busy) void run();
    logger.debug?.({ identity, reason }, 'Delivery worker woken');
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      unsubscribeWake = subscribeDeliveryWorkerWake(wake);
      // A single low-frequency safety scan catches missed in-process signals and
      // recovers abandoned leases. This replaces the old 1.5s constant polling.
      recoveryTimer = setInterval(() => wake('safety-scan'), RECOVERY_INTERVAL_MS);
      recoveryTimer.unref?.();
      void run(); // process jobs already pending after a restart
      logger.info({ identity, fallbackIntervalMs: RECOVERY_INTERVAL_MS }, 'Event-driven delivery worker started');
    },
    wake,
    stop() {
      stopped = true;
      if (recoveryTimer) clearInterval(recoveryTimer);
      recoveryTimer = undefined;
      unsubscribeWake?.();
      unsubscribeWake = undefined;
      logger.info({ identity }, 'Delivery worker stopped');
    },
  };
}
