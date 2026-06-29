# Rutba MTA

Open-source multi-tenant email relay middleware.
Part of the [Rutba](https://github.com/rutba) product line.

Rutba MTA sits between your applications and their outbound SMTP servers, handling
every cross-cutting email concern — suppression, adaptive reputation-based rate
control, templated batch sends, action interception, bounce processing, unsubscribe,
and delivery reporting — so that individual apps do not have to.

See [FUNCTION.md](./FUNCTION.md) for the full functional specification.

---

## Key capabilities

- **Sender registration + trust tokens** — each app registers a sender address and its own SMTP; receives a trust token for subsequent API calls
- **Suppression gate** — hard bounces, complaints, manual blocks, and unsubscribes checked before every send (global cross-tenant suppression)
- **Adaptive rate control** — per-receiving-domain reputation score (0–100) computed from live outcome ratios; score drives inter-message delay automatically; warmup period for new domains; manual override per domain
- **Priority queue** — `transactional` messages always ahead of `marketing`; transactional bypasses pacing, marketing is rate-controlled
- **Templated batch send** — submit a template + recipients array; one personalised email per recipient, grouped as a batch; suppression checked per address before queuing
- **Action interception** — embed CTAs, approvals, and acceptances as `{{action_key}}` placeholders; Rutba MTA generates per-recipient signed tokens, intercepts clicks, records events, webhooks the client, and redirects — business logic stays in the client app
- **Relay via sender's SMTP** — not a direct MTA; final delivery is always through the sender's own registered SMTP server (DKIM, IP reputation, MX routing stay there)
- **Retry / backoff** — transient 4xx failures rescheduled: 1 m → 5 m → 15 m → 1 h → 3 h, then `failed`; permanent 5xx suppresses the address
- **Bounce capture** — IMAP poller on the VERP return-path mailbox; parses DSN (RFC 3464) + ARF (RFC 5965); updates domain reputation; suppresses hard bounces / complaints globally
- **Unsubscribe** — `List-Unsubscribe` header + footer link on marketing mail; RFC 8058 one-click POST; per-sender scope
- **Delivery reporting** — per-message status API + webhooks; per-batch live aggregate report including action click counts and unsubscribes

---

## Architecture

```
 client app ──X-Trust-Token──▶ POST /v1/send  (transactional)
                              ▶ POST /v1/send/batch  (marketing, template + recipients)
                                        │
                              suppression check → dropped | queued
                                        ▼
                                outbox (MySQL queue)
                                        │
                       SendWorker ◀─────┘
                       transactional first │ reputation delay for marketing
                                        │
                         sender's registered SMTP ──▶ recipients
                                        │
                            VERP bounce+<uuid>@bounce-domain
                                        ▼
                         BouncePoller (IMAP) ──▶ event + suppression + domain score
                                        │
                              webhook ──▶ client app


 recipient clicks {{approve_url}} in email
         ▼
 GET /action/:token  ──▶ record event ──▶ webhook ──▶ 302 client URL
```

Pure relay-layer logic (reputation scoring, backoff, DSN parsing, error classification)
lives in `src/lib/` and is unit-tested with no DB or SMTP needed: `npm test`.

---

## Quick start

```bash
cp .env.example .env    # fill MAILER_DB_*, bounce mailbox, MAILER_PUBLIC_URL
npm install
npm run migrate         # creates tables in the configured DB
npm start               # API server + send worker + bounce poller
npm test                # pure-logic unit tests (no DB/SMTP needed)
```

---

## API summary

All `/v1/*` require `X-Trust-Token: <token>`. Public endpoints need no auth.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v1/senders` | Register sender + SMTP → trust token |
| `GET/PUT/DELETE` | `/v1/senders/me` | Manage own sender record |
| `POST` | `/v1/send` | Single message (default: `transactional`) |
| `POST` | `/v1/send/batch` | Templated batch (default: `marketing`) |
| `GET` | `/v1/messages` | List messages |
| `GET` | `/v1/messages/:uuid` | Message + event history |
| `GET` | `/v1/batches` | List batches |
| `GET` | `/v1/batches/:id/report` | Live delivery report |
| `GET/POST/DELETE` | `/v1/suppressions[/:address]` | Suppression management |
| `GET/PUT` | `/v1/domains[/:domain]` | Domain reputation + rate config (admin) |
| `GET` | `/action/:token` | Action interception + redirect (public) |
| `GET/POST` | `/unsubscribe/:token` | Unsubscribe (public) |
| `GET` | `/health` | DB ping + worker status |

Full API spec in [FUNCTION.md](./FUNCTION.md).

---

## Notes / deferred

- Current code predates this spec — a rebuild against FUNCTION.md is in progress
- Bounce poller should run as a single instance (send workers can be replicated safely)
- **TODO**: in-body unsubscribe footer for marketing emails (`src/smtp/transport.js`)
- Direct MX delivery (PowerMTA evolution) is a future milestone
