# mailer — shared email gateway (Feature 37 Phase B)

A standalone, MTA-aware email **sending gateway**. Deliberately outside Strapi so it
can serve multiple products (**TrustList, Rutba ERP, future offerings**) from one
place, with **one suppression list + one reputation view** across the shared
sending IP/domain. Own MySQL database. Modeled on RightApp's `RIGHTMTA` /
`RSMTPREST` / `RMAILX` stack.

See `docs/todo/37-email-deliverability-logging-and-suppression.md` for the why.

## What it does

- **REST API** (`/v1/send`, …) authenticated per-product by API key → tenant `app`.
- **Suppression before send** — a recipient on the active blocklist (hard bounce,
  complaint, manual block, or per-tenant unsubscribe) is dropped + logged, never sent.
- **Durable queue + worker** — every send is persisted (`email_message`) and drained
  by a worker with **drip/bleed pacing**: per-receiving-domain reputation score →
  per-message delay, plus per-domain and global concurrency caps. Transactional mail
  bypasses pacing; bulk mail is paced.
- **Retry/backoff** — transient failures (greylisting, 4xx, network) are deferred and
  retried on an exponential schedule (1m→5m→15m→1h→3h, then `failed`).
- **Hard-reject suppression** — a 5.x.x recipient rejection at send time suppresses
  the address (global).
- **Bounce capture** — an IMAP poller reads the VERP/return-path mailbox, parses DSN
  (RFC 3464) + ARF complaints, records an `email_event`, flips the message to
  `bounced`, and suppresses hard bounces/complaints globally.
- **Receiver/receiving-server care** — pooled SMTP connections (capped), per-domain
  rate limiting, VERP envelope sender, `List-Unsubscribe` (one-click), Message-ID for
  bounce correlation.
- **Per-product unsubscribe** — `GET /unsubscribe/:uuid` suppresses for that product
  only (transactional mail from other products is unaffected).

## Architecture

```
 product (TrustList/Rutba/…) ──X-Api-Key──▶ POST /v1/send
                                              │  suppression check → drop|queue
                                              ▼
                                       email_message (MySQL queue+log)
                                              │
                              SendWorker ◀────┘  drip/bleed + retry/backoff
                                  │ nodemailer (pooled, VERP from)
                                  ▼
                               Mailcow SMTP ──▶ recipients
                                  │ DSN bounces → bounces@ mailbox
                                  ▼
                              BouncePoller (IMAP) → email_event + suppression
```

Pure MTA decision logic (pacing, backoff, reputation, DSN parse, error
classification) lives in `src/lib/` and is unit-tested in `test/` with no DB/SMTP
needed: `npm test`.

## API

All `/v1/*` require `X-Api-Key: <key>`. The key maps to the tenant `app`.

| Method | Path | Body / notes |
|--------|------|--------------|
| `GET`  | `/health` | DB ping (no auth) |
| `POST` | `/v1/send` | `{ to, subject, html?, text?, from?, replyTo?, class?, templateSlug?, headers?, scheduledAt? }` → `202 {status:'queued',uuid}` or `200 {status:'dropped'}` |
| `GET`  | `/v1/messages` | `?status=&to=&limit=&offset=` (admin: `&all=1`) |
| `GET`  | `/v1/messages/:idOrUuid` | message + its events |
| `GET`  | `/v1/suppressions` | global + this app's suppressions |
| `POST` | `/v1/suppressions` | `{ address, reason?, scope?, note? }` (only admin apps may set `scope=global`) |
| `DELETE` | `/v1/suppressions/:address` | `?scope=` (default this app) |
| `GET`  | `/unsubscribe/:uuid` | public one-click unsubscribe (per-product) |
| `GET`  | `/o/:uuid.gif` | public open-tracking pixel |

`class` is `transactional` (default, bypasses pacing) or `bulk` (paced + per-tenant
unsubscribe applies).

## Run locally

```bash
cd mailer
cp .env.example .env          # fill DB + SMTP + MAILER_API_KEYS
npm install
npm run migrate               # create tables in the mailer DB
npm start                     # API + worker + (optional) bounce poller
npm test                      # pure-logic unit tests (no DB needed)
```

## Production (docker-compose)

The `mailer` service is wired in the root `docker-compose.yml` (joins the shared
`data` MySQL network + the `internal` app network). To activate:

1. **Create the database + user** on the shared MySQL:
   ```sql
   CREATE DATABASE trustlist_mailer CHARACTER SET utf8mb4;
   CREATE USER 'mailer'@'%' IDENTIFIED BY '<pw>';
   GRANT ALL PRIVILEGES ON trustlist_mailer.* TO 'mailer'@'%';
   ```
2. **Set env** in `deploy` `.env`: `MAILER_DB_USER`, `MAILER_DB_PASSWORD`,
   `MAILER_TRUSTLIST_API_KEY` (a long random key), `MAILER_PUBLIC_URL`, and the
   `SMTP_*` you already use.
3. **Turn on bounce capture** once the mailbox exists (see below):
   `MAILER_BOUNCE_ENABLED=true` + `MAILER_BOUNCE_IMAP_USER/PASS`.
4. **Activate in TrustList**: setting `MAILER_TRUSTLIST_API_KEY` makes
   `trustlist_strapi` route all mail through the gateway (the helper falls back to
   direct send if the gateway is ever unreachable, so transactional mail is safe).

### Bounce mailbox / VERP setup (Mailcow)

- Create `bounces@trustlist.uk` (or reuse `no-reply@`) and an IMAP login for it.
- The gateway stamps the envelope sender as `bounce+<uuid>@${MAILER_BOUNCE_DOMAIN}`.
  Point that domain's MX (or an alias) at the bounce mailbox so DSNs land there.
- The poller marks processed messages `\Seen`; it only reads unseen mail.

## Notes / deferred

- Reputation is a simple delivered/bounce/complaint ratio per domain → delay tier
  (RightApp 0–100 model). Warmup (<20 sends) assumes healthy.
- `provider_message_id` is the SMTP Message-ID returned by nodemailer.
- Open/click tracking is minimal (a pixel); full click-wrapping is out of scope.
- **TODO: in-body unsubscribe footer** — bulk messages should include a visible opt-out link in the HTML/text body (the `unsubscribeUrl` is already set on each message; just append a footer in `src/smtp/transport.js`). Required for recipients on webmail/mobile who don't see the `List-Unsubscribe` header.
- Multiple gateway replicas are safe (claim is an atomic DB transition), but the
  bounce poller should run as a single instance.
