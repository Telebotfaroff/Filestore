import { claimDueDeletion, finishScheduledDeletion, failScheduledDeletion } from './auto-delete-repository.js';

export function createAutoDeleteWorker(bot, pool, logger, identity) {
  let timer;
  let busy = false;

  async function poll() {
    if (busy) return;
    busy = true;
    try {
      const claim = await claimDueDeletion(pool, identity);
      if (!claim) return;
      try {
        await bot.telegram.deleteMessage(claim.chatId, claim.messageId);
        await finishScheduledDeletion(pool, claim.id);
      } catch (error) {
        // Telegram returns "message to delete not found" when the user deleted it
        // manually or a previous attempt already succeeded; treat that as complete.
        const description = error.response?.description ?? error.message ?? '';
        if (/message to delete not found||/i.test(description)) {
          await finishScheduledDeletion(pool, claim.id);
        } else {
          await failScheduledDeletion(pool, claim.id, description);
          logger.warn({ deletionId: claim.id, error: description }, 'Auto-delete failed');
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
