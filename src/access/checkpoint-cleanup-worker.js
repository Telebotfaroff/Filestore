import { expireCheckpointSessions } from './checkpoint-engine.js';

export function startCheckpointSessionCleanup(pool, logger, intervalMs = 10 * 60 * 1000) {
  let stopped = false;
  let running = false;
  async function sweep() {
    if (stopped || running) return;
    running = true;
    try {
      const count = await expireCheckpointSessions(pool);
      if (count) logger.info({ expiredSessions: count }, 'Expired checkpoint sessions cleaned');
    } catch (error) {
      logger.warn({ error: error.message }, 'Checkpoint session cleanup failed');
    } finally {
      running = false;
    }
  }
  void sweep();
  const timer = setInterval(() => void sweep(), intervalMs);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
