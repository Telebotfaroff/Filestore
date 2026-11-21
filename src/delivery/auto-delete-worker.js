import { randomUUID } from 'node:crypto';
import {
  claimDueDeletion,
  finishScheduledDeletion,
  failScheduledDeletion,
  getNextScheduledDeletionDelay,
} from './auto-delete-repository.js';

export function isTelegramDeletionAlreadyComplete(error) {
  const description = String(error?.response?.description ?? error?.message ?? '');
  return /message to delete not found|message not found/i.test(description);
}

export function createAutoDeleteWorker(bot, pool, logger, identity) {
  const leaseOwner = randomUUID();
  const MAX_IDLE_DELAY_MS = 60_000;
  const MIN_IDLE_DELAY_MS = 1_000;
  let timer;
  let stopped = true;
  let busy = false;
  let idleDelay = MIN_IDLE_DELAY_MS;

  function schedule(delay) {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void poll(), delay);
    timer.unref?.();
  }

  async function poll() {
    if (stopped || busy) return;
    busy = true;
    let processed = 0;
    try {
      // Drain due work per wake instead of claiming only one item per tick.
      while (!stopped) {
        const claim = await claimDueDeletion(pool, identity, leaseOwner);
        if (!claim) break;
        processed++;
        try {
          await bot.telegram.deleteMessage(claim.chatId, claim.messageId);
          const completed = await finishScheduledDeletion(pool, claim.id, claim.leaseOwner);
          if (!completed) logger.warn({ deletionId: claim.id }, 'Auto-delete lease lost before completion');
        } catch (error) {
          const description = error.response?.description ?? error.message ?? '';
          if (isTelegramDeletionAlreadyComplete(error)) {
            const completed = await finishScheduledDeletion(pool, claim.id, claim.leaseOwner);
            if (!completed) logger.warn({ deletionId: claim.id }, 'Auto-delete lease lost before completion');
          } else {
            const marked = await failScheduledDeletion(pool, claim.id, claim.leaseOwner, description);
            if (marked) logger.warn({ deletionId: claim.id, error: description }, 'Auto-delete failed');
            else logger.warn({ deletionId: claim.id }, 'Auto-delete lease lost before failure update');
          }
        }
      }

      idleDelay = processed > 0 ? MIN_IDLE_DELAY_MS : Math.min(MAX_IDLE_DELAY_MS, idleDelay * 2);
      const nextDueDelay = await getNextScheduledDeletionDelay(pool, identity, MAX_IDLE_DELAY_MS);
      // Schedule closer to known due work, while retaining bounded fallback checks.
      const delay = processed > 0 ? MIN_IDLE_DELAY_MS : Math.max(idleDelay, nextDueDelay);
      schedule(Math.min(MAX_IDLE_DELAY_MS, delay));
    } catch (error) {
      logger.error({ error: error.message }, 'Auto-delete worker poll failed');
      idleDelay = Math.min(MAX_IDLE_DELAY_MS, idleDelay * 2);
      schedule(idleDelay);
    } finally {
      busy = false;
    }
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      idleDelay = MIN_IDLE_DELAY_MS;
      void poll();
      logger.info({ identity, maxIdleDelayMs: MAX_IDLE_DELAY_MS }, 'Auto-delete adaptive worker started');
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
