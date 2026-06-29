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

### 3. Message class and queue priority

Every message has a **class** that governs its queue priority and pacing:

| Class | Default for | Queue priority | Domain rate pacing |
|-------|-------------|----------------|--------------------|
| `transactional` | single `POST /v1/send` | **Highest** — picked before all marketing messages regardless of queue age | Bypasses per-domain pacing; still subject to the hard ceiling |
| `marketing` | batch `POST /v1/send/batch` | Lower — sent after all pending transactional messages are clear | Fully paced through the per-domain rate limiter |

The worker always drains the transactional queue first. A sudden burst of transactional
messages (e.g. a wave of password-resets) will always jump ahead of any in-progress
marketing batch, ensuring user-facing emails are never delayed by bulk sends.

Callers may override the class explicitly on any send. The default is intentionally
conservative: a single send to one recipient is assumed transactional; a batch to
many recipients is assumed marketing.

### 4. Global per-domain rate limiting
The mailer tracks outgoing volume **per receiving domain** (e.g. `yahoo.com`,
`gmail.com`) **across all senders combined**.
If the global rate for a domain is at its ceiling, marketing messages destined for
that domain are held in the queue and sent as slots open — no sender can exceed the
shared envelope rate, preventing any one product from causing deliverability damage
on a domain that all products share.

Rate parameters (messages per minute, burst ceiling) are configurable per domain
and have a global fallback. Transactional messages are exempt from per-domain pacing
but are still counted against the hard ceiling.

### 5. Durable queue + worker
Every accepted message is written to the `outbox` table before acknowledgement
is returned to the caller. The caller gets a stable `uuid` immediately.

A background worker drains the queue:
1. Loads messages that are due (status `queued` or `deferred`, `next_attempt_at ≤ now`)
2. **Transactional messages are picked before marketing messages** at every tick
3. Checks domain rate — marketing messages wait if the domain ceiling is reached
4. Claims the message atomically (prevents double-send across worker replicas)
5. Relays via the **sender's registered SMTP server**
6. Records the outcome as an `event` row and updates message status

### 6. Templated batch send
The mailer accepts a **template + recipient data array** and generates one personalised
email per recipient, queuing all of them as a single **batch**.

The caller supplies:
- `template_html` — HTML body with `{{variable}}` placeholders
- `template_text` — plain-text body with `{{variable}}` placeholders (optional but recommended)
- `subject` — subject line, also supports `{{variable}}` placeholders
- `recipients` — array of `{ to: "email@example.com", data: { name: "…", … } }` objects
- `class` (optional) — defaults to `marketing`

The mailer:
1. Validates every recipient address format before accepting the batch
2. Checks every address against the suppression list; suppressed addresses are
   recorded as `dropped` immediately and excluded from the send queue
3. Expands the template once per recipient (substituting each recipient's `data`)
4. Writes one `outbox` row per recipient, all linked to the same `batch` row
5. Returns a `batch_uuid` and a count summary `{ total, queued, dropped }` immediately

Template placeholders use `{{key}}` syntax (Mustache-style). Callers are responsible
for sanitising values before passing them; the mailer performs substitution only,
not sanitisation.

### 7. Relay via sender's SMTP
The mailer opens an SMTP session to the **sender's own SMTP server** (the one
registered alongside the trust token) and sends the fully prepared message.
The sender's SMTP server is responsible for final delivery, DKIM, reputation,
and any MX routing.

The mailer sets:
- `From:` header to the registered sender address
- `Message-ID: <uuid@sender-domain>` for later correlation
- VERP envelope sender `bounce+<uuid>@<mailer-bounce-domain>` so that bounced
  DSNs return to the mailer's monitored inbox rather than the sender's inbox
- `List-Unsubscribe` (one-click) for `marketing` class messages

### 8. Retry / backoff for transient failures
If the sender's SMTP rejects with a 4xx (greylisting, temporary unavailability,
rate limit from the provider) the message is marked `deferred` and rescheduled
on an exponential back-off:
`1 min → 5 min → 15 min → 1 h → 3 h` (6 attempts total, then `failed`).

A 5.x.x permanent rejection suppresses the recipient address (global) and marks
the message `bounced` — no retry.

### 9. Bounce capture and correlation
The mailer monitors its own bounce mailbox (IMAP) for:
- **DSN / NDR** (RFC 3464 `message/delivery-status`) — hard (5.x.x) or soft (4.x.x)
- **ARF / FBL** (RFC 5965 `message/feedback-report`) — spam complaint

On receipt:
1. The `uuid` is extracted from the VERP envelope or `X-Mailer-Uuid` header
2. The matching outbox row is located and flipped to `bounced`
3. An `event` row is written with the full classification
4. Hard bounce or complaint → address added to global suppression
5. The sender app is notified (webhook POST or queryable via API)

### 10. Delivery report and status feedback

**Single message — sync poll:**
`GET /v1/messages/:uuid` returns current status + all events for that message.

**Single message — async webhook:**
If a webhook URL was registered with the sender, the mailer POSTs a status payload
whenever a message transitions to `sent`, `bounced`, `deferred`, or `failed`.

**Batch — delivery report:**
`GET /v1/batches/:id/report` returns an aggregate snapshot at any point:

```json
{
  "batch_uuid": "…",
  "class": "marketing",
  "total": 1000,
  "queued": 200,
  "sent": 750,
  "bounced_hard": 12,
  "bounced_soft": 8,
  "suppressed": 20,
  "failed": 3,
  "pending": 7,
  "complete": false
}
```

`complete` is `true` when every recipient has reached a terminal state
(`sent`, `bounced`, `suppressed`, `failed`).

**Batch — async webhook:**
When a batch reaches `complete = true`, the mailer POSTs the final delivery report
to the sender's registered webhook URL. Individual message status events are also
fired as they occur (same as single-message behaviour) — the batch webhook is a
convenience summary, not a replacement.

---

## What it is NOT responsible for

| Concern | Who owns it |
|---------|-------------|
| Direct MX delivery | Sender's SMTP server |
| DKIM signing | Sender's SMTP server / Mailcow |
| IP warm-up | Sender's sending IP / SMTP provider |
| User authentication | Caller app (mailer auth is trust-token only) |
| Reusable saved template library | Caller app (template is supplied inline per batch) |
| Click / open tracking beyond a pixel | Out of scope for now |

---

## Database: `mailers`

| Table | Purpose |
|-------|---------|
| `sender` | Registered sender email addresses, SMTP credentials (encrypted at rest), trust token hash, webhook URL, status |
| `batch` | One row per templated batch send: template, class, total count, completion state |
| `outbox` | Durable message queue + delivery log: one row per recipient; `batch_id` FK when part of a batch |
| `event` | Per-message delivery events: `sent`, `deferred`, `bounced`, `complaint`, `failed`, `dropped` |
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
| `POST` | `/v1/send` | Queue a single message (defaults to `transactional`) |
| `POST` | `/v1/send/batch` | Templated batch send — template + recipients array (defaults to `marketing`) |
| `GET` | `/v1/messages` | List own messages (filterable by status / recipient / class / date) |
| `GET` | `/v1/messages/:uuid` | Message detail + event history |
| `GET` | `/v1/batches` | List own batches |
| `GET` | `/v1/batches/:id` | Batch detail + per-message list |
| `GET` | `/v1/batches/:id/report` | Delivery report aggregate (live snapshot) |
| `GET` | `/v1/suppressions` | List suppressions visible to this sender |
| `POST` | `/v1/suppressions` | Manually add a suppression |
| `DELETE` | `/v1/suppressions/:address` | Remove a per-sender suppression (global only via admin) |
| `GET` | `/unsubscribe/:uuid` | One-click unsubscribe (public, no token) |
| `GET` | `/health` | Service health + DB ping (no auth) |

Admin callers (flag on the sender record) may additionally:
- Read all senders / all messages / all batches across all tenants
- Set global suppressions
- Adjust per-domain rate parameters

---

## Non-goals for this version

- Direct MX delivery (PowerMTA path — future)
- SMTP sink / inbound processing
- Multi-bounce-mailbox per sender (one shared VERP mailbox for now)
- Scheduled / drip campaigns
- Reusable template library (template is sent inline with each batch)
- Metrics dashboard / UI (API + logs only)
