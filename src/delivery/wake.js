const listeners = new Set();

export function wakeDeliveryWorkers(reason = 'job-created') {
  for (const listener of listeners) {
    try { listener(reason); } catch {}
  }
}

export function subscribeDeliveryWorkerWake(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
