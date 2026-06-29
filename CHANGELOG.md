# Changelog

All notable changes to Rutba MTA are documented here.
This project follows [Semantic Versioning](https://semver.org/) and [Keep a Changelog](https://keepachangelog.com/) conventions.

---

## [0.1.0] — 2026-06-29

Initial public release.

### Added

**Core service**
- Multi-tenant sender registration with per-sender trust tokens (SHA-256 hashed at rest)
- Per-sender SMTP credentials, AES-256-GCM encrypted at rest with `MAILER_SMTP_ENC_KEY`
- Per-sender webhook URL with HMAC-signed payloads (`X-Mailer-Signature: sha256=…`)

**Sending**
- `POST /v1/send` — single message, default class `transactional`
- `POST /v1/send/batch` — templated batch send with `{{variable}}` substitution, default class `marketing`
- Per-recipient suppression check before queuing (dropped silently with reason)
- Dot-path template lookup (`{{user.name}}`), double-brace HTML-escapes, triple-brace bypasses

**Queue + worker**
- Durable MySQL outbox queue
- Send worker with transactional-first priority (transactional always picked before marketing)
- Atomic `claimSending` for safe multi-replica operation
- Exponential backoff retry schedule: 1m → 5m → 15m → 1h → 3h (6 attempts)

**Adaptive rate control**
- Per-receiving-domain reputation score (0–100) computed from live outcome ratios:
  `score = 100 − (bounce_rate·300 + complaint_rate·1000 + defer_rate·50)`
- Score → inter-message delay tier (0 / 500 / 1500 / 3000 / 6000 ms)
- Warmup period (default 20 samples) treats new domains as score 80
- Hard per-domain ceiling (default 600 / minute, configurable per-domain)
- Admin score override and counter-reset endpoints

**Action interception**
- Per-recipient HMAC-signed action tokens for CTAs, approvals, declines, confirmations
- Template variables `{{action_key}}` resolve to per-recipient redirect URLs
- `GET /action/:token` — records click, webhook to sender, 302 to client app
- Configurable expiry (default 72 hours)

**Suppression**
- Global suppression (cross-sender) for hard bounces, complaints, manual blocks
- Per-sender suppression for unsubscribes
- Admin-only global scope writes

**Unsubscribe**
- `List-Unsubscribe` header on all marketing-class mail
- `GET /unsubscribe/:token` — confirmation page
- `POST /unsubscribe/:token` — RFC 8058 one-click

**Bounce processing**
- IMAP bounce mailbox poller (VERP envelope sender pattern)
- DSN (RFC 3464) and ARF (RFC 5965) feedback report parsing
- Automatic global suppression on hard bounce / complaint
- Reputation-counter updates feed back into adaptive pacing

**Delivery reporting**
- `GET /v1/messages/:uuid` — single message status + event history
- `GET /v1/batches/:id/report` — live aggregate report with action click counts and unsubscribes
- Webhook events: `sent`, `deferred`, `bounced`, `complained`, `failed`, `action_clicked`, `unsubscribed`
- Webhook retry with exponential backoff; `webhook_delivery` audit table

**Operations**
- `GET /health` for monitoring
- Forward-only SQL migrator
- Production fail-fast on missing required secrets (`MAILER_HMAC_SECRET`, `MAILER_SMTP_ENC_KEY`, `MAILER_PUBLIC_URL`)
- Configurable DB name (`MAILER_DB_NAME`, default suggestion `mailers`)
- Graceful shutdown on SIGTERM / SIGINT

### Tests

- 58 unit tests covering address normalisation, backoff, error classification, DSN parsing, rate-limiter, reputation tiers, message class, template rendering, HMAC tokens, AES-GCM crypto

### Known limitations / non-goals (planned for future)

- Direct MX delivery (PowerMTA-style) — currently relays via each sender's registered SMTP
- Reusable persistent template library — templates are inline per send
- Click-wrapping for arbitrary links — only action tokens are intercepted
- Metrics dashboard — API + logs only
- Open / read tracking — pixel only; full open-rate analytics out of scope
