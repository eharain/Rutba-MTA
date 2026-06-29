'use strict';

/**
 * Retry/backoff schedule for transient send failures (greylisting, 4xx, network).
 * Pure — unit-tested in test/backoff.test.mjs.
 *
 * Gaps are the delays BETWEEN attempts. With the default 5 gaps a message is
 * attempted at most 6 times before it is marked `failed`:
 *   attempt1 --60s--> attempt2 --5m--> attempt3 --15m--> attempt4 --1h--> attempt5 --3h--> attempt6
 */

const DEFAULT_GAPS_SECONDS = [60, 300, 900, 3600, 10800];

/**
 * Seconds to wait before the next attempt given how many attempts have already
 * failed. Returns null when the schedule is exhausted (give up → failed).
 */
function nextDelaySeconds(attemptsMade, gaps = DEFAULT_GAPS_SECONDS) {
  const n = Number(attemptsMade);
  if (!Number.isFinite(n) || n < 1) return gaps[0];
  if (n > gaps.length) return null;
  return gaps[n - 1];
}

/** Total attempts allowed before giving up (gaps + 1). */
function maxAttempts(gaps = DEFAULT_GAPS_SECONDS) {
  return gaps.length + 1;
}

module.exports = { nextDelaySeconds, maxAttempts, DEFAULT_GAPS_SECONDS };
