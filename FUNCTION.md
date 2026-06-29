# Mailer — Functional Definition

## What it is

A **multi-tenant email relay middleware service**.  
It sits between sender applications and their outbound SMTP servers,  
handling every cross-cutting email concern so that individual apps do not have to.

It is **not** a mail transfer agent (MTA). It does not connect to recipient MX records.  
Final delivery is always done by the sender's own registered SMTP server.

---

## Core responsibilities

### 1. Sender registration
A client application registers one or more sender email addresses with the mailer.  
Each registration supplies:
- The sender email address (e.g. `no-reply@trustlist.uk`)
- The SMTP server credentials that own that address (host / port / TLS / user / pass)
- An optional webhook URL to receive async delivery status callbacks
- An optional display name

On registration the mailer returns a **trust token** — a long random secret the app  
presents on every subsequent API call. The trust token is permanently linked to that  
sender address; rotating it invalidates the old one.

### 2. Suppression — address quality gate
Before any message is queued the recipient address is checked against the global  
suppression list. Suppressed addresses are **dropped silently** (no send attempt,  
no retry); the caller receives a `dropped` response with the reason.

Suppression reasons:
| Reason | Scope | Who adds it |
|--------|-------|-------------|
| `hard_bounce` | global | mailer (automatic, on 5.x.x SMTP rejection or DSN) |
| `complaint` | global | mailer (automatic, on ARF feedback report) |
| `manual_block` | global | admin API call |
| `unsubscribe` | per-sender | one-click unsubscribe link in outgoing mail |

Global suppression is cross-sender: an address hard-bounced by TrustList will not  
be attempted by Rutba either, and vice-versa.

### 3. Global per-domain rate limiting
The mailer tracks outgoing volume **per receiving domain** (e.g. `yahoo.com`,  
`gmail.com`) **across all senders combined**.  
If the global rate for a domain is at its ceiling, messages destined for that  
domain are held in the queue and sent as slots open — no sender can exceed the  
shared envelope rate, preventing any one product from causing deliverability  
damage on a domain shared by everyone.

Rate parameters are configurable per domain (and have a global fallback).  
Transactional messages (password-reset, receipts) may be granted a higher priority  
tier that bypasses bulk pacing but not the hard ceiling.

### 4. Durable queue + worker
Every accepted message is written to the `outbox` table before acknowledgement  
is returned to the caller. The caller gets a stable `uuid` immediately.

A background worker drains the queue:
1. Loads messages that are due (status `queued` or `deferred`, `next_attempt_at ≤ now`)
2. Checks domain rate — waits if the domain ceiling is reached
3. Claims the message atomically (prevents double-send across replicas)
4. Relays via the **sender's registered SMTP server**
5. Records the outcome as an `event` row and updates message status

### 5. Relay via sender's SMTP
The mailer opens an SMTP session to the **sender's own SMTP server** (the one  
registered alongside the trust token) and sends the fully prepared message.  
The sender's SMTP server is responsible for final delivery, DKIM, reputation,  
and any MX routing.

The mailer sets:
- `From:` header to the registered sender address
- `Message-ID: <uuid@sender-domain>` for later correlation
- `VERP envelope sender` `bounce+<uuid>@<mailer-bounce-domain>` so that bounced  
  DSNs return to the mailer's monitored inbox rather than the sender's inbox
- `List-Unsubscribe` (one-click) for bulk class messages

### 6. Retry / backoff for transient failures
If the sender's SMTP rejects with a 4xx (greylisting, temporary unavailability,  
rate limit from the provider) the message is marked `deferred` and rescheduled  
on an exponential back-off:  
`1 min → 5 min → 15 min → 1 h → 3 h` (6 attempts total, then `failed`).

A 5.x.x permanent rejection suppresses the recipient address (global) and marks  
the message `bounced` — no retry.

### 7. Bounce capture and correlation
The mailer monitors its own bounce mailbox (IMAP) for:
- **DSN / NDR** (RFC 3464 `message/delivery-status`) — hard (5.x.x) or soft (4.x.x)
- **ARF / FBL** (RFC 5965 `message/feedback-report`) — spam complaint

On receipt:
1. The `uuid` is extracted from the VERP envelope or `X-Mailer-Uuid` header
2. The matching outbox row is located and flipped to `bounced`
3. An `event` row is written with the full classification
4. Hard bounce or complaint → address added to global suppression
5. The **sender app is notified** (webhook POST or queryable via API)

### 8. Status reporting back to the sender
The sender can learn the fate of any message two ways:

**Sync (poll):**  
`GET /v1/messages/:uuid` — returns current status + all events for that message.

**Async (webhook):**  
If a webhook URL was registered with the sender record, the mailer POSTs a  
status payload whenever a message transitions to `sent`, `bounced`, `deferred`,  
or `failed`. The sender app can use this to update its own records, trigger  
retry logic, or surface delivery errors to users.

---

## What it is NOT responsible for

| Concern | Who owns it |
|---------|-------------|
| Direct MX delivery | Sender's SMTP server |
| DKIM signing | Sender's SMTP server / Mailcow |
| IP warm-up | Sender's sending IP / SMTP provider |
| Email template rendering | Caller app (sends pre-rendered HTML) |
| User authentication | Caller app (mailer auth is trust-token only) |
| Click / open tracking beyond a pixel | Out of scope for now |

---

## Database: `mailers`

| Table | Purpose |
|-------|---------|
| `sender` | Registered sender email addresses, SMTP credentials (encrypted at rest), trust token hash, webhook URL, status |
| `outbox` | Durable message queue + delivery log: one row per send attempt |
| `event` | Per-message delivery events: `sent`, `deferred`, `bounced`, `complaint`, `failed` |
| `suppression` | Global (and per-sender) bad-address registry |
| `domain_rate` | Per-receiving-domain sliding-window rate state (global across all senders) |

---

## API surface (intended)

All endpoints require `X-Trust-Token: <token>` (tied to a registered sender).

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v1/senders` | Register a sender address + SMTP config → returns trust token |
| `GET` | `/v1/senders/me` | Inspect own sender record (no SMTP credentials in response) |
| `PUT` | `/v1/senders/me` | Update SMTP credentials, webhook URL, display name |
| `DELETE` | `/v1/senders/me` | Deregister (soft-delete; in-flight messages are drained) |
| `POST` | `/v1/send` | Queue a message for relay |
| `GET` | `/v1/messages` | List own messages (filterable by status / recipient / date) |
| `GET` | `/v1/messages/:uuid` | Message detail + event history |
| `GET` | `/v1/suppressions` | List suppressions visible to this sender |
| `POST` | `/v1/suppressions` | Manually add a suppression |
| `DELETE` | `/v1/suppressions/:address` | Remove a per-sender suppression (global only via admin) |
| `GET` | `/unsubscribe/:uuid` | One-click unsubscribe (public, no token) |
| `GET` | `/health` | Service health + DB ping (no auth) |

Admin callers (flag on the sender record) may additionally:
- Read all senders / all messages across all tenants
- Set global suppressions
- Adjust domain rate parameters

---

## Non-goals for this version

- Direct MX delivery (PowerMTA path — future)
- SMTP sink / inbound processing
- Multi-bounce-mailbox per sender (one shared VERP mailbox for now)
- Scheduled / drip campaigns
- Template storage (caller sends pre-rendered HTML)
- Metrics dashboard / UI (API + logs only)
