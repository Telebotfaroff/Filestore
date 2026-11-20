export function classifyDeliverySendError(error) {
  if (error?.response?.error_code) return 'failed';
  return 'uncertain';
}
