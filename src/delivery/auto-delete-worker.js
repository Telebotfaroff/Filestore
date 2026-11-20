import { randomUUID } from 'node:crypto';
import { claimDueDeletion, finishScheduledDeletion, failScheduledDeletion } from './auto-delete-repository.js';

export function isTelegramDeletionAlreadyComplete(error) {
  const description = String(error?.response?.description ?? error?.message ?? '');
  return /message to delete not found|message not found/i.test(description);
}

export function createAutoDeleteWorker(bot, pool, logger, identity) {
  const leaseOwner = randomUUID();
  let timer;
  let busy = false;

  async function poll() {
    if (busy) return;
    busy = true;
    try {
      const claim = await claimDueDeletion(pool, identity, leaseOwner);
      if (!claim) return;
      try {
        await bot.telegram.deleteMessage(claim.chatId, claim.messageId);
        const completed = await finishScheduledDeletion(pool, claim.id, claim.leaseOwner);
        if (!completed) logger.warn({ deletionId: claim.id }, 'Auto-delete lease lost before completion');
      } catch (error) {
        // Telegram reports "message to delete not found" if deletion already occurred.
        const description = error.response?.description ?? error.message ?? '';
        if (isTelegramDeletionAlreadyComplete(error)) {
          const completed = await finishScheduledDeletion(pool, claim.id, claim.leaseOwner);
          if (!completed) logger.warn({ deletionId: claim.id }, 'Auto-delete lease lost before completion');
        } else {
          const failed = await failScheduledDeletion(pool, claim.id, claim.leaseOwner, description);
          if (failed) logger.warn({ deletionId: claim.id, error: description }, 'Auto-delete failed');
          else logger.warn({ deletionId: claim.id }, 'Auto-delete lease lost before failure update');
        }
      }
    } catch (error) {
      logger.error({ error: error.message }, 'Auto-delete worker poll failed');
    } finally {
      busy = false;
    }
  }

  return {
    start() {
      if (timer) return;
      void poll();
      timer = setInterval(() => void poll(), 5_000);
      timer.unref?.();
      logger.info({ identity }, 'Auto-delete worker started');
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
