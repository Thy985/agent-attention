import * as crypto from 'crypto';

/** Dedup TTL in milliseconds — same event+message within this window is suppressed. */
const DEDUP_TTL_MS = 30_000;

/** In-memory set of recent notification keys. */
const seen = new Map<string, number>();

/**
 * Compute a hash key for deduplication: hash(agent:event:message).
 */
function makeKey(agent: string, event: string, message: string): string {
  return crypto.createHash('sha1').update(`${agent}:${event}:${message}`).digest('hex');
}

/**
 * Check whether a notification should be sent (dedup guard).
 * Returns true if this is a new notification, false if suppressed.
 * Cleans up expired entries on each call.
 */
export function shouldNotify(agent: string, event: string, message: string): boolean {
  // Cleanup expired entries
  const now = Date.now();
  for (const [key, ts] of seen) {
    if (now - ts > DEDUP_TTL_MS) {
      seen.delete(key);
    }
  }

  const key = makeKey(agent, event, message);
  if (seen.has(key)) {
    return false;
  }

  seen.set(key, now);
  return true;
}
