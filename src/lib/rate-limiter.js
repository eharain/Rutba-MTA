'use strict';

/**
 * Per-domain pacing + concurrency gate (drip). Time is injected (now ms) so the
 * decision logic is pure and unit-tested in test/rate-limiter.test.mjs.
 *
 * Two controls per receiving domain:
 *   - minInterval: minimum ms between two sends to the same domain (the "drip").
 *   - maxInflight: max concurrent in-flight sends to the same domain.
 * Plus a single global maxInflight across all domains (protects our own box).
 */

/** Earliest time a domain may send again given its last send. A domain that has
 *  never sent (lastSentAt null/undefined) is ready immediately (-Infinity). */
function nextAllowedAt(lastSentAt, minIntervalMs) {
  if (lastSentAt == null) return -Infinity;
  return Number(lastSentAt) + (Number(minIntervalMs) || 0);
}

function isIntervalReady(lastSentAt, minIntervalMs, now) {
  return now >= nextAllowedAt(lastSentAt, minIntervalMs);
}

class DomainLimiter {
  constructor({ globalMaxInflight = 20, defaultMinIntervalMs = 0, maxInflightPerDomain = 5 } = {}) {
    this.globalMaxInflight = globalMaxInflight;
    this.defaultMinIntervalMs = defaultMinIntervalMs;
    this.maxInflightPerDomain = maxInflightPerDomain;
    this.lastSentAt = new Map(); // domain -> ms
    this.inflight = new Map(); // domain -> count
    this.globalInflight = 0;
  }

  _inflightOf(domain) {
    return this.inflight.get(domain) || 0;
  }

  /**
   * Can we send to `domain` right now? `minIntervalMs` lets the caller pass a
   * reputation-derived per-message delay (overrides the default).
   */
  canSend(domain, now, minIntervalMs = this.defaultMinIntervalMs) {
    if (this.globalInflight >= this.globalMaxInflight) return false;
    if (this._inflightOf(domain) >= this.maxInflightPerDomain) return false;
    return isIntervalReady(this.lastSentAt.get(domain), minIntervalMs, now);
  }

  /** Reserve a slot (call right before sending). */
  acquire(domain, now) {
    this.inflight.set(domain, this._inflightOf(domain) + 1);
    this.globalInflight += 1;
    this.lastSentAt.set(domain, now);
  }

  /** Release a slot (call in finally after the send resolves/rejects). */
  release(domain) {
    this.inflight.set(domain, Math.max(0, this._inflightOf(domain) - 1));
    this.globalInflight = Math.max(0, this.globalInflight - 1);
  }
}

module.exports = { DomainLimiter, nextAllowedAt, isIntervalReady };
