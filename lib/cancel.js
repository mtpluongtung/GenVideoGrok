/**
 * Cancellation is cooperative: the queue cannot kill a Playwright call mid-flight, so the
 * long polling loops in lib/grok.js and lib/chatgpt.js check this between polls and bail out.
 * That means a cancel lands within a couple of seconds while waiting on ChatGPT or Grok, but
 * can take until the current `locator.waitFor` timeout when stuck inside one.
 */
export class JobCancelledError extends Error {
  constructor(message = 'Đã hủy tác vụ theo yêu cầu.') {
    super(message);
    this.name = 'JobCancelledError';
    this.cancelled = true;
  }
}

export function isCancellation(error) {
  return Boolean(error?.cancelled);
}

export function cancelRequested(isCancelled) {
  return typeof isCancelled === 'function' && Boolean(isCancelled());
}

export function throwIfCancelled(isCancelled, message) {
  if (cancelRequested(isCancelled)) throw new JobCancelledError(message);
}
