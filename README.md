# Rutba MTA

**Open-source multi-tenant email relay middleware.**

Rutba MTA sits between your applications and their outbound SMTP servers, handling every cross-cutting email concern — suppression, adaptive reputation-based rate control, templated batch sends, action interception, bounce processing, unsubscribe, and delivery reporting — so that individual apps do not have to.

> **It is not an MTA in the direct-to-MX sense.** Final delivery is always done by the sender's own registered SMTP server. Rutba MTA owns the middleware concerns; your SMTP relay owns DKIM, IP reputation, and MX routing.

---

## Documentation

| Document | What's inside |
|----------|---------------|
| [FUNCTION.md](./FUNCTION.md) | Full functional specification — the source of truth |
| [API.md](./API.md) | Complete HTTP API reference with curl examples |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Production install, MySQL setup, ops runbook |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | How to file issues, code style, release process |
| [SECURITY.md](./SECURITY.md) | Vulnerability disclosure + threat model |
| [CHANGELOG.md](./CHANGELOG.md) | Version history |
| [LICENSE](./LICENSE) | Apache License 2.0 |

---

## Why Rutba MTA exists

Most applications eventually grow three email needs:
1. **Transactional mail** (password resets, receipts, notifications) — must go out *now*.
2. **Marketing / batch mail** (campaigns, invitations) — large fan-out, recipient-friendly pacing.
3. **Visibility** into what happened — bounces, complaints, unsubscribes, clicks.

Doing this well requires a suppression list, per-domain rate control, retry logic, bounce parsing, action / unsubscribe link interception, and webhooks. Building it inside each app means **N copies, N bugs, N separately-managed suppression lists**, and N shared sending IPs damaging each other's reputation.

Rutba MTA solves it once. Multiple apps register as **senders**, get a trust token, and POST through one HTTP API. Suppression and reputation are shared across all senders that route through the same instance.

---

## Key capabilities

- **Sender registration + trust tokens** — each app registers a sender address + its own SMTP credentials and receives a trust token for subsequent API calls. SMTP passwords are AES-256-GCM encrypted at rest.
- **Suppression gate** — hard bounces, complaints, manual blocks, and unsubscribes are checked before every send. Hard bounces and complaints become **global** (cross-sender) automatically.
- **Adaptive rate control** — per-receiving-domain reputation score (0–100) computed from live outcome ratios. Score drives inter-message delay automatically (0 ms / 500 / 1500 / 3000 / 6000). A warmup period treats new domains as score 80 until enough data lands. Admin overrides supported.
- **Priority queue** — `transactional` messages are always picked first by the worker; transactional bypasses pacing, marketing is rate-controlled.
- **Templated batch send** — submit a template + recipients array, get one personalised email per recipient grouped as a batch. Per-recipient suppression check before queuing.
- **Action interception** — embed CTAs, approvals, declines, confirms as `{{action_key}}` placeholders. Rutba MTA generates per-recipient signed tokens, intercepts clicks, records events, webhooks the client, then `302`s to the client's real URL. Business logic stays in the client app.
- **Relay via the sender's SMTP** — not direct MX. Each sender brings their own SMTP (Mailcow, Postfix, SES, anything standard).
- **Retry / backoff** — transient 4xx failures rescheduled exponentially: 1 m → 5 m → 15 m → 1 h → 3 h; permanent 5xx suppresses the address globally.
- **Bounce capture** — IMAP poller on the VERP return-path mailbox; parses DSN (RFC 3464) + ARF (RFC 5965); updates domain reputation; suppresses hard bounces / complaints; idempotent on partial-failure re-delivery.
- **Unsubscribe** — `List-Unsubscribe` header on marketing mail; RFC 8058 one-click POST; per-sender scope.
- **Delivery reporting** — per-message status API + signed webhooks; per-batch live aggregate report including action click counts and unsubscribes.

---

## Architecture

```
 client app ──X-Trust-Token──▶ POST /v1/send           (transactional)
                              ▶ POST /v1/send/batch    (marketing, template + recipients)
                                        │
                              suppression check → dropped | queued
                                        ▼
                                outbox (MySQL queue)
                                        │
                       SendWorker ◀─────┘
                       transactional first │ reputation delay for marketing
                       atomic tryReserveSlot (cross-replica safe)
                                        │
                         sender's registered SMTP ──▶ recipients
                                        │
                            VERP bounce+<uuid>@bounce-domain
                                        ▼
                         BouncePoller (IMAP) ──▶ event + suppression + domain score
                                        │
                       WebhookWorker (HMAC-signed) ──▶ client app


 recipient clicks {{accept_url}} in email
         ▼
 GET /action/:token  ──▶ verify HMAC ──▶ record + webhook ──▶ 302 client URL
```

Pure relay-layer logic (reputation scoring, backoff, DSN parsing, template rendering, HMAC tokens, AES-GCM crypto) lives in `src/lib/` and is unit-tested with no DB or SMTP needed.

---

## Quick start

```bash
cp .env.example .env    # fill MAILER_DB_*, secrets, MAILER_PUBLIC_URL
npm install
npm run migrate         # creates all tables in the configured DB
npm start               # API server + send worker + webhook worker + bounce poller
npm test                # pure-logic unit tests (no DB/SMTP needed)
```

The first `POST /v1/senders` on a fresh database needs no auth and bootstraps an admin sender. Save the returned `trustToken` — it's shown only once.

See [DEPLOYMENT.md](./DEPLOYMENT.md) for production setup including bounce mailbox / VERP wiring, Docker, monitoring, and operational runbooks.

---

## API summary

All `/v1/*` require `X-Trust-Token: <token>`. Public endpoints need no auth.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v1/senders` | Register sender + SMTP → trust token |
| `GET / PUT / DELETE` | `/v1/senders/me` | Manage own sender record |
| `POST` | `/v1/senders/me/rotate-token` | Rotate trust token |
| `POST` | `/v1/senders/me/rotate-webhook-secret` | Rotate webhook secret |
| `POST` | `/v1/send` | Single message (default: `transactional`) |
| `POST` | `/v1/send/batch` | Templated batch (default: `marketing`) |
| `GET` | `/v1/messages[/:uuid]` | List + detail with event history |
| `GET` | `/v1/batches[/:id[/report]]` | List, detail, live delivery report |
| `GET / POST / DELETE` | `/v1/suppressions[/:address]` | Suppression management |
| `GET / PUT` | `/v1/domains[/:domain]` | Reputation + rate config (admin) |
| `GET` | `/action/:token` | Action interception + 302 redirect |
| `GET / POST` | `/unsubscribe/:token` | Web confirm + RFC 8058 one-click |
| `GET` | `/health` | DB ping |

Full reference with request/response examples in [API.md](./API.md).

---

## Tech

- **Runtime**: Node.js ≥ 18 (22 LTS recommended)
- **Storage**: MySQL 8 (5.7 works with caveats)
- **Outbound SMTP**: any standard SMTP relay per sender (nodemailer-driven)
- **Bounce capture**: IMAP via [imapflow](https://www.npmjs.com/package/imapflow) + [mailparser](https://www.npmjs.com/package/mailparser)
- **Crypto**: AES-256-GCM (SMTP passwords), HMAC-SHA-256 (action / unsubscribe / webhook signing)
- **Test runner**: Node's built-in `node --test`

---

## License

Apache License 2.0 — see [LICENSE](./LICENSE).

Contributions welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for how to file issues, code style, and the release process.
