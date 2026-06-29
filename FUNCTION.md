# Mailer — Functional Definition

## What it is

A **multi-tenant email relay middleware service**.
It sits between sender applications and their outbound SMTP servers, handling every
cross-cutting email concern — suppression, intelligent rate control, bounce processing,
unsubscribe, and email action interception — so that individual apps do not have to.

It is **not** a mail transfer agent (MTA). It does not connect to recipient MX records.
Final delivery is always done by the sender's own registered SMTP server.

---

## Core responsibilities

### 1. Sender registration
A client application registers one or more sender email addresses with the mailer.
Each registration supplies:
- The sender email address (e.g. `no-reply@trustlist.uk`)
- The SMTP server credentials that own that address (host / port / TLS / user / pass)
- An optional webhook URL to receive async event callbacks
- An optional display name

On registration the mailer returns a **trust token** — a long random secret the app
presents on every subsequent API call. The trust token is permanently linked to that
sender address; rotating it invalidates the old one.

### 2. Suppression — address quality gate
Before any message is queued the recipient address is checked against the suppression
list. Suppressed addresses are **dropped silently** (no send attempt, no retry);
the caller receives a `dropped` response with the reason.

| Reason | Scope | Who adds it |
|--------|-------|-------------|
| `hard_bounce` | global | mailer — automatic on 5.x.x SMTP rejection or DSN |
| `complaint` | global | mailer — automatic on ARF feedback report |
| `manual_block` | global | admin API call |
| `unsubscribe` | per-sender | mailer — via unsubscribe link click (see §10) |

Global suppression is cross-sender: an address hard-bounced by TrustList will not
be attempted by Rutba either, and vice-versa.

### 3. Message class and queue priority

Every message carries a **class** that determines its queue priority and whether
domain-rate pacing applies:

| Class | Default for | Queue priority | Domain-rate pacing |
|-------|-------------|----------------|--------------------|
| `transactional` | single `POST /v1/send` | **Highest** — always picked before marketing, regardless of queue age | Bypasses reputation-based delay; still subject to the hard per-domain ceiling |
| `marketing` | batch `POST /v1/send/batch` | Lower — processed after all pending transactional messages | Fully paced by the adaptive reputation model (§4) |

The worker always drains transactional messages first. A burst of password-reset
emails will jump ahead of any in-progress marketing batch without configuration.

Callers may override the class explicitly on any send request.

### 4. Adaptive per-domain reputation and rate control

The mailer tracks delivery outcomes **per receiving domain** (e.g. `yahoo.com`,
`gmail.com`) **across all senders combined** and uses those outcomes to
**automatically adjust the send pace** — no manual tuning required for normal
operation.

#### How the reputation score works

After every delivery event (sent, bounced, complained, deferred) the domain's
running counters are updated and a **reputation score (0–100)** is recomputed:

```
score = 100 − ( bounce_rate × 300
              + complaint_rate × 1000
              + defer_rate × 50 )
```

Clamped to [0, 100]. A clean domain scores 100; a domain with even a 0.1 %
complaint rate drops below 0.

#### Score → inter-message delay (marketing sends only)

| Score | Delay between sends to this domain |
|-------|------------------------------------|
| 96–100 | 0 ms — full speed |
| 86–95 | 500 ms |
| 71–85 | 1 500 ms |
| 51–70 | 3 000 ms |
| 0–50 | 6 000 ms |

As the domain's health improves (fewer bounces / defers over time) the score rises
and the delay automatically decreases. No human intervention needed.

#### Warmup period

For any domain where fewer than **N sends** (default: 20, configurable) have been
recorded, the system has insufficient data to compute a reliable score. During
warmup the domain is treated as **score 80** (86–95 tier, 500 ms delay) —
conservative but not overly restrictive.

#### Hard ceiling

Every receiving domain has a **maximum messages per minute** ceiling (configurable
per domain, with a global fallback). This ceiling applies to **all classes** including
transactional. It protects against a single-burst flood regardless of reputation.

#### Manual overrides

Administrators may:
- Pin a domain to a fixed score (e.g. force score 100 for a known corporate relay,
  or force score 0 to pause sends to a problem domain)
- Set a custom hard ceiling per domain
- Reset a domain's counters (e.g. after a known data-quality fix)

Overrides are stored in `domain_reputation` alongside the computed values.

### 5. Durable queue + worker
Every accepted message is written to the `outbox` table before acknowledgement
is returned to the caller. The caller gets a stable `uuid` immediately.

A background worker drains the queue:
1. Loads messages due (status `queued` or `deferred`, `next_attempt_at ≤ now`)
2. Picks **transactional** messages before **marketing** at every tick
3. For marketing messages: checks domain reputation delay — waits if the
   inter-message interval for this domain has not yet elapsed
4. Claims the message atomically (prevents double-send across replicas)
5. Resolves action placeholder URLs (§8) into final `/action/:token` links
6. Relays via the **sender's registered SMTP server**
7. Records the outcome, updates `domain_reputation` counters, recomputes score

### 6. Templated batch send
The mailer accepts a **template + recipient data array** and generates one
personalised email per recipient, grouped as a single **batch**.

The caller supplies:
- `template_html` — HTML body with `{{variable}}` placeholders
- `template_text` — plain-text fallback with the same placeholders (recommended)
- `subject` — subject line, also supports `{{variable}}` placeholders
- `recipients` — array of `{ to, data }` objects; `data` supplies per-recipient values
- `actions` (optional) — shared action definitions; per-recipient tokens are generated
  automatically (see §8)
- `class` (optional) — defaults to `marketing`

Processing:
1. Every recipient address is validated for format
2. Every address is checked against suppression; suppressed addresses are immediately
   recorded as `dropped` and excluded from the queue
3. Action tokens are generated per recipient per action (unique per person)
4. The template is expanded once per recipient (data substitution + action URL injection)
5. One `outbox` row is written per recipient, all linked to the same `batch` row
6. Returns `{ batch_uuid, total, queued, dropped }` immediately

Template placeholders use `{{key}}` syntax. Callers are responsible for sanitising
values; the mailer performs substitution only.

### 7. Relay via sender's SMTP
The mailer opens an SMTP session to the **sender's own registered SMTP server** and
relays the fully prepared message. The sender's SMTP server handles final delivery,
DKIM signing, and MX routing.

The mailer sets:
- `From:` header — registered sender address
- `Message-ID: <uuid@sender-domain>` — for bounce correlation
- VERP envelope sender `bounce+<uuid>@<bounce-domain>` — DSNs return to the
  mailer's monitored bounce mailbox, not the sender's inbox
- `List-Unsubscribe` and `List-Unsubscribe-Post` headers — for `marketing` class,
  pointing to the mailer's `/unsubscribe/:token` endpoint

### 8. Email action interception (CTAs, approvals, acceptances)

Emails frequently contain links that trigger a business action — approving a claim,
accepting an offer, confirming an account, or declining an invitation. The mailer acts
as an **intermediary** for these links: it intercepts the click, records it, and
redirects the recipient to the client application's actual URL. Business logic always
stays in the client app; the mailer is the relay only.

#### How it works

When submitting a send (single or batch), the caller includes an `actions` array:

```json
"actions": [
  {
    "key":      "approve_url",
    "label":    "Approve",
    "type":     "approval",
    "redirect": "https://app.example.com/offers/123/accept",
    "expires_hours": 72
  },
  {
    "key":      "decline_url",
    "label":    "Decline",
    "type":     "decline",
    "redirect": "https://app.example.com/offers/123/decline",
    "expires_hours": 72
  }
]
```

The mailer:
1. Generates a unique signed token per action **per recipient** (so in a batch of 500,
   each person gets their own `approve_url` token — click events are attributed
   to the correct recipient)
2. Makes the token URLs available as template variables under the same `key` names
   (e.g. `{{approve_url}}` in the template resolves to `/action/<token>`)
3. Stores each token → redirect mapping in `message_action`

#### On click (`GET /action/:token`)

1. Verify the token is valid and not expired
2. Record an `action_clicked` event on the parent message (timestamp, IP, user-agent)
3. POST to the sender's webhook (if registered): event type, action type, message uuid,
   recipient address, and the original redirect URL — the client app can react
   immediately (e.g. mark an offer as accepted in its own DB)
4. `302` redirect to the registered `redirect` URL

The client app then handles the actual business logic at its own URL. The mailer does
not interpret the action or alter any state beyond recording the click.

#### Action types (informational — shapes webhook payload)

| Type | Meaning |
|------|---------|
| `cta` | General call to action (default) |
| `approval` | Approving / accepting something |
| `decline` | Rejecting / declining |
| `confirm` | Confirming an account, email, or intent |

#### Expiry

Tokens expire after the caller-specified `expires_hours` (default: 72 h). Clicks on
expired tokens receive a `410 Gone` response with a configurable expired-message page.
Expired tokens are never redirected.

### 9. Bounce processing
The mailer monitors its bounce mailbox (IMAP) for inbound delivery failure reports:
- **DSN / NDR** (RFC 3464 `message/delivery-status`) — hard (5.x.x) or soft (4.x.x)
- **ARF / FBL** (RFC 5965 `message/feedback-report`) — spam complaint

On receipt:
1. Extract `uuid` from VERP envelope sender or `X-Mailer-Uuid` header
2. Locate the matching `outbox` row; flip status to `bounced`
3. Write an `event` row with full classification (type, SMTP code, bounce class,
   raw diagnostic)
4. Update the sending domain's `domain_reputation` counters; recompute score
5. Hard bounce or complaint → add recipient to global suppression
6. Notify the sender app (webhook + queryable via API)

The domain reputation score update (step 4) is the mechanism by which the adaptive
rate control (§4) learns from bounces automatically.

### 10. Unsubscribe processing
Every `marketing` class message includes a `List-Unsubscribe` header and a visible
footer link, both pointing to `/unsubscribe/:token`.

On visit (`GET /unsubscribe/:token`):
1. Identify the sender and recipient from the token
2. Add the recipient address to suppression with scope `per-sender` (unsubscribing
   from TrustList marketing does not suppress Rutba transactional)
3. Record an `unsubscribed` event on the message
4. Notify the sender app via webhook (the app can update its own contact preferences)
5. Render a confirmation page ("You have been unsubscribed")

`POST /unsubscribe/:token` (RFC 8058 one-click, triggered by mail clients) performs
the same suppression without the confirmation page.

Unsubscribes are scoped **per sender** by default. An admin may promote a specific
unsubscribe to global scope via the API.

### 11. Delivery report and status feedback

**Single message — sync:**
`GET /v1/messages/:uuid` returns status + full event history.

**Single message — async webhook:**
The mailer POSTs to the sender's webhook on every status transition:
`sent`, `bounced`, `deferred`, `failed`, `action_clicked`, `unsubscribed`.

**Batch — live report:**
`GET /v1/batches/:id/report` returns a live aggregate snapshot:

```json
{
  "batch_uuid": "…",
  "class":        "marketing",
  "total":        1000,
  "queued":       200,
  "sent":         750,
  "bounced_hard": 12,
  "bounced_soft": 8,
  "suppressed":   20,
  "failed":       3,
  "pending":      7,
  "actions_clicked": { "approve_url": 43, "decline_url": 12 },
  "unsubscribed": 5,
  "complete":     false
}
```

`complete` is `true` when every recipient has reached a terminal state.

**Batch — async webhook:**
When `complete` is reached, the mailer POSTs the final delivery report to the
sender's webhook. Individual events still fire throughout.

---

## What it is NOT responsible for

| Concern | Who owns it |
|---------|-------------|
| Direct MX delivery | Sender's SMTP server |
| DKIM signing | Sender's SMTP server / Mailcow |
| IP warm-up | Sender's sending IP / SMTP provider |
| User authentication / session | Caller app |
| Action business logic | Caller app (mailer intercepts and redirects only) |
| Reusable saved template library | Caller app (template supplied inline per batch) |
| Click / open tracking beyond pixel + action tokens | Out of scope for now |

---

## Database

The database name is **configurable** via `MAILER_DB_NAME`. `mailers` is the
recommended default; nothing is hardcoded.

| Table | Purpose |
|-------|---------|
| `sender` | Registered sender addresses, SMTP credentials (encrypted), trust token hash, webhook URL |
| `batch` | One row per templated batch: template, class, total count, completion state |
| `outbox` | Queue + delivery log: one row per recipient; `batch_id` FK when part of a batch |
| `event` | Per-message events: `sent`, `deferred`, `bounced`, `complaint`, `action_clicked`, `unsubscribed`, `failed`, `dropped` |
| `message_action` | Per-recipient action tokens: key, type, label, redirect URL, expiry, clicked_at |
| `suppression` | Global and per-sender bad-address registry |
| `domain_reputation` | Per-domain counters (sent/bounced/complained/deferred), computed score (0–100), manual override, warmup flag |

---

## API surface (intended)

All `/v1/*` endpoints require `X-Trust-Token: <token>`.
Public endpoints (`/action/:token`, `/unsubscribe/:token`, `/health`) require no auth.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v1/senders` | Register sender address + SMTP config → trust token |
| `GET` | `/v1/senders/me` | Inspect own sender record (credentials excluded) |
| `PUT` | `/v1/senders/me` | Update SMTP credentials, webhook URL, display name |
| `DELETE` | `/v1/senders/me` | Deregister (soft-delete; in-flight messages drained) |
| `POST` | `/v1/send` | Queue single message (default class: `transactional`) |
| `POST` | `/v1/send/batch` | Templated batch send (default class: `marketing`) |
| `GET` | `/v1/messages` | List own messages (filter: status / recipient / class / date) |
| `GET` | `/v1/messages/:uuid` | Message detail + event history |
| `GET` | `/v1/batches` | List own batches |
| `GET` | `/v1/batches/:id` | Batch detail + per-message list |
| `GET` | `/v1/batches/:id/report` | Live delivery report aggregate |
| `GET` | `/v1/suppressions` | List suppressions for this sender |
| `POST` | `/v1/suppressions` | Manually add suppression |
| `DELETE` | `/v1/suppressions/:address` | Remove per-sender suppression (global: admin only) |
| `GET` | `/v1/domains` | Per-domain reputation scores and rate config (admin) |
| `PUT` | `/v1/domains/:domain` | Set manual score override or custom rate ceiling (admin) |
| `GET` | `/action/:token` | Action interception — log click, webhook, redirect (public) |
| `GET` | `/unsubscribe/:token` | Unsubscribe confirmation page (public) |
| `POST` | `/unsubscribe/:token` | RFC 8058 one-click unsubscribe (public) |
| `GET` | `/health` | DB ping + worker status (no auth) |

Admin callers (flag on sender record) additionally see all senders, messages, batches,
domain reputation data, and may set global suppressions and domain overrides.

---

## Non-goals for this version

- Direct MX delivery (PowerMTA path — future)
- SMTP sink / inbound mail processing
- Multi-bounce-mailbox per sender (one shared VERP mailbox)
- Scheduled / drip campaigns
- Reusable persistent template library
- Metrics dashboard / UI (API + logs only)
- Action state machine (mailer records the click; client owns the outcome)
