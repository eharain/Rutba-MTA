# Rutba MTA — Deployment & Operations Guide

This guide covers a production install: prerequisites, MySQL setup, environment configuration, bounce mailbox / VERP wiring, Docker deployment, monitoring, and day-2 operations.

---

## Prerequisites

| Component | Recommended |
|-----------|-------------|
| Node.js | 22.x LTS (≥18 supported) |
| MySQL | 8.0+ (5.7 works with caveats) |
| SMTP relay | Mailcow, Postfix, AWS SES, or any standard SMTP. Each registered sender brings their own. |
| Bounce mailbox | One IMAP mailbox at a domain you control (e.g. `bounces@bounce.example.com`) |
| Public hostname | A reachable HTTPS hostname for the service (action + unsubscribe links land here) |
| Reverse proxy | Caddy, nginx, or any TLS-terminating proxy in front of port 8025 |

A single Rutba MTA instance comfortably handles tens of thousands of messages per hour. For higher throughput, run multiple **send-worker** replicas — the atomic `claimSending` makes this safe. The **bounce poller** must remain a single instance.

---

## 1. Create the database

The database name is configurable via `MAILER_DB_NAME` (default suggestion: `mailers`):

```sql
CREATE DATABASE mailers CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'mailer'@'%' IDENTIFIED BY 'a-strong-password';
GRANT ALL PRIVILEGES ON mailers.* TO 'mailer'@'%';
FLUSH PRIVILEGES;
```

The application will create all tables on boot via `npm run migrate` (also called automatically by `npm start`).

---

## 2. Generate secrets

Two secrets are **mandatory** in production:

```bash
# HMAC secret for action + unsubscribe tokens
openssl rand -hex 32       # → MAILER_HMAC_SECRET

# AES-256 key for SMTP password encryption at rest
openssl rand -hex 32       # → MAILER_SMTP_ENC_KEY
```

⚠️ **Losing `MAILER_SMTP_ENC_KEY` makes all stored SMTP passwords unrecoverable.** Back it up like a database root password.

If you rotate `MAILER_HMAC_SECRET`, every outstanding action and unsubscribe link becomes invalid. Plan for that.

---

## 3. Configure environment

Copy `.env.example` to `.env` and fill in:

```env
NODE_ENV=production
MAILER_PORT=8025

MAILER_PUBLIC_URL=https://mta.example.com           # must be reachable

MAILER_HMAC_SECRET=<from step 2>
MAILER_SMTP_ENC_KEY=<from step 2>

MAILER_DB_HOST=mysql
MAILER_DB_NAME=mailers
MAILER_DB_USER=mailer
MAILER_DB_PASSWORD=<your password>

# Adaptive pacing
MAILER_WORKER_ENABLED=true
MAILER_DOMAIN_MAX_PER_MIN=600         # hard ceiling fallback per receiving domain
MAILER_WARMUP_MIN=20                  # samples before reputation score is trusted

# Bounce capture (enable AFTER step 4)
MAILER_BOUNCE_ENABLED=false
```

In production, missing secrets cause boot to abort with a clear message. In development they auto-generate ephemeral values with a warning.

---

## 4. Bounce mailbox / VERP setup

The mailer stamps every outbound message's envelope sender as:

```
bounce+<message-uuid>@<MAILER_BOUNCE_DOMAIN>
```

DSN bounces return there, and the IMAP poller correlates each back to its message.

1. **Pick a bounce domain.** E.g. `bounce.example.com`. It should not be the same as a normal sending domain.
2. **Add MX records** routing the bounce domain to an SMTP server that can receive (your Mailcow / Postfix is fine).
3. **Create the mailbox** (e.g. `bounces@bounce.example.com`) with IMAP access.
4. **Update `.env`**:

```env
MAILER_BOUNCE_ENABLED=true
MAILER_BOUNCE_DOMAIN=bounce.example.com
MAILER_BOUNCE_IMAP_HOST=mail.example.com
MAILER_BOUNCE_IMAP_PORT=993
MAILER_BOUNCE_IMAP_SECURE=true
MAILER_BOUNCE_IMAP_USER=bounces@bounce.example.com
MAILER_BOUNCE_IMAP_PASS=<password>
MAILER_BOUNCE_POLL_MS=60000
```

The poller marks processed messages `\Seen` and only reads unseen mail, so re-runs are safe.

---

## 5. Reverse proxy / TLS

Action and unsubscribe URLs must be served over HTTPS. Example Caddy config:

```caddy
mta.example.com {
    reverse_proxy 127.0.0.1:8025
}
```

Public endpoints requiring TLS:

- `/action/:token` — recipients click these from email
- `/unsubscribe/:token` — both `GET` (web) and `POST` (RFC 8058 one-click)
- `/health` — let your monitoring hit this; no auth required

Authenticated endpoints (`/v1/*`) typically only need to be reachable from your apps, so consider restricting them to your internal network.

---

## 6. Docker

A `Dockerfile` ships with the repo. Build and run:

```bash
docker build -t rutba-mta:latest .
docker run -d --name rutba-mta \
  --restart unless-stopped \
  -p 8025:8025 \
  --env-file .env \
  rutba-mta:latest
```

For docker-compose alongside an existing app stack:

```yaml
services:
  mta:
    image: rutba-mta:latest
    restart: unless-stopped
    env_file: .env
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8025/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 15s
      timeout: 5s
      retries: 10
      start_period: 20s
    networks: [internal, data]   # internal = your apps; data = MySQL
```

---

## 7. Bootstrap the first sender

The **first** `POST /v1/senders` on a fresh DB needs no auth and is automatically promoted to **admin**. Use this to seed the operator account:

```bash
curl -X POST https://mta.example.com/v1/senders \
  -H 'Content-Type: application/json' \
  -d '{
    "address": "admin@example.com",
    "smtp": {
      "host": "mail.example.com",
      "port": 587,
      "secure": false,
      "username": "admin@example.com",
      "password": "<smtp-pw>"
    }
  }'
```

⚠️ Store the returned `trustToken` securely — it is shown **once**. Use it to register all subsequent senders.

To register additional non-admin senders:

```bash
curl -X POST https://mta.example.com/v1/senders \
  -H 'Content-Type: application/json' \
  -H 'X-Trust-Token: <admin token>' \
  -d '{ "address": "no-reply@trustlist.uk", "smtp": { … } }'
```

---

## 8. Monitoring

### Health endpoint

`GET /health` returns `200 { "status": "ok" }` when the DB ping succeeds. Wire your uptime monitor (StatusCake, Pingdom, internal `curl` cron) to this.

### Key signals to alert on

| Signal | SQL / source | Threshold |
|--------|--------------|-----------|
| Queue backlog | `SELECT COUNT(*) FROM outbox WHERE status IN ('queued','deferred')` | sustained > 1000 |
| Failed-rate spike | `SELECT COUNT(*) FROM event WHERE type='failed' AND occurred_at > NOW() - INTERVAL 5 MINUTE` | > 50 / 5 min |
| Webhook delivery backlog | `SELECT COUNT(*) FROM webhook_delivery WHERE status='pending'` | sustained > 500 |
| Domain reputation collapse | `SELECT * FROM domain_reputation WHERE score < 50` | any new entry |
| Bounce poller silent | last `event.type='bounced'` older than 1 hour while messages are flowing | > 1 h |

### Logs

The service logs to stdout/stderr (one-line timestamped). In production capture via Docker / journald. Useful log markers:

- `[boot] …` — startup phases
- `[worker] …` — send loop
- `[bounce] …` — IMAP poller
- `[webhook-worker] …` — webhook delivery

Set `MAILER_DEBUG=1` for verbose debug output.

---

## 9. Day-2 operations

### Register a new sender
```bash
curl -X POST $MTA/v1/senders -H "X-Trust-Token: $ADMIN" -d '{ … }'
```

### Suppress an address globally
```bash
curl -X POST $MTA/v1/suppressions \
  -H "X-Trust-Token: $ADMIN" \
  -d '{ "address": "bad@example.com", "scope": "global", "reason": "manual_block" }'
```

### Pause sending to a problem domain
```bash
curl -X PUT $MTA/v1/domains/yahoo.com \
  -H "X-Trust-Token: $ADMIN" \
  -d '{ "scoreOverride": 0 }'        # delay tier = 6000 ms
```

To resume:
```bash
curl -X PUT $MTA/v1/domains/yahoo.com \
  -H "X-Trust-Token: $ADMIN" \
  -d '{ "scoreOverride": null }'     # back to computed score
```

### Reset a domain's counters after a known fix
```bash
curl -X POST $MTA/v1/domains/yahoo.com/reset \
  -H "X-Trust-Token: $ADMIN"
```

### Rotate a sender's trust token
```bash
curl -X POST $MTA/v1/senders/me/rotate-token \
  -H "X-Trust-Token: <current>"
```

### Inspect an in-flight batch
```bash
curl $MTA/v1/batches/<batch_uuid>/report -H "X-Trust-Token: $TOKEN"
```

### Scale send-worker replicas

Run additional instances of the container with `MAILER_WORKER_ENABLED=true` — `claimSending` is atomic, so two replicas will never both grab the same message. **Run only ONE instance of the bounce poller** (set `MAILER_BOUNCE_ENABLED=false` on extra replicas).

---

## 10. Backup & recovery

- **Database**: standard MySQL backup. The `outbox` and `event` tables grow indefinitely; consider archiving rows older than N months.
- **Secrets**: back up `MAILER_HMAC_SECRET` and `MAILER_SMTP_ENC_KEY` separately from the DB (KMS, password manager, or vault). Without `MAILER_SMTP_ENC_KEY`, every sender must re-register their SMTP credentials.
- **`.env`**: treat as a secret artefact.

---

## 11. Upgrading

```bash
git pull
npm ci                  # install matching deps
npm run migrate         # applies any new SQL files in migrations/
docker compose up -d    # rolling restart
```

Migrations are forward-only and tracked in the `_migrations` table; each file runs in a transaction and is applied exactly once. Re-running `npm run migrate` after an upgrade is always safe.

---

## 12. Troubleshooting

| Symptom | Likely cause | Action |
|---------|--------------|--------|
| Boot aborts: `MAILER_HMAC_SECRET is required in production` | Secret not set | Set the env var; see §2 |
| Every `/v1/*` returns 401 | Trust token missing or rotated | Verify `X-Trust-Token` header; rotate if lost |
| Messages stuck in `queued` | Worker disabled or DB pool exhausted | Check `MAILER_WORKER_ENABLED=true`; raise `MAILER_DB_POOL` |
| Marketing sends very slow | Recipient domain has poor reputation | `GET /v1/domains/<domain>` — score below 70 means automatic throttling. Investigate bounces. |
| Action links 404 | `MAILER_PUBLIC_URL` mismatch with the URL recipients see | Verify the value matches your reverse proxy hostname |
| Bounces not landing | VERP MX records or IMAP creds wrong | `MAILER_BOUNCE_ENABLED=true` + send a known-bad address; check `/v1/messages/:uuid` events |
| Webhook failing | Receiver returns non-2xx or times out | Inspect `webhook_delivery` table; check signature verification on receiver side |
| Boot crash on second `POST /v1/senders` | First sender bootstrap was lost (DB reset) | First sender call has no auth — works on a fresh DB. After bootstrap, admin token is required. |
