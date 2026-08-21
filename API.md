# Rutba MTA — HTTP API Reference

All `/v1/*` endpoints require `X-Trust-Token: <token>`.  
Public endpoints (`/action/:token`, `/unsubscribe/:token`, `/health`) need no auth.  
Request and response bodies are JSON unless noted.

---

## Table of contents

- [Conventions](#conventions)
- [Authentication](#authentication)
- [Senders](#senders)
- [Sending mail](#sending-mail)
- [Messages](#messages)
- [Batches](#batches)
- [Suppression](#suppression)
- [Domains (admin)](#domains-admin)
- [Action interception (public)](#action-interception-public)
- [Unsubscribe (public)](#unsubscribe-public)
- [Webhook payloads](#webhook-payloads)
- [Error format](#error-format)

---

## Conventions

| Item | Form |
|------|------|
| Trust token header | `X-Trust-Token: <token>` |
| Content type | `application/json` |
| Time | ISO-8601 UTC strings in responses |
| UUIDs | Lowercase canonical (`8-4-4-4-12`) |
| Status codes | 2xx success · 4xx caller error · 5xx server error |

The first POST to `/v1/senders` on a fresh install needs no auth and bootstraps the first sender as **admin**. Every later call needs an admin's trust token.

---

## Authentication

Every authenticated request must include the `X-Trust-Token` header:

```http
GET /v1/senders/me HTTP/1.1
Host: mta.example.com
X-Trust-Token: 8tQv...long-secret...XaB
```

Loss of the trust token requires rotation (`POST /v1/senders/me/rotate-token`) — it is not retrievable.

---

## Senders

### `POST /v1/senders` — register a sender

Bootstrap call (first sender) needs no auth and is automatically promoted to admin.  
Subsequent calls require an admin's `X-Trust-Token`.

```bash
curl -X POST https://mta.example.com/v1/senders \
  -H 'Content-Type: application/json' \
  -d '{
    "address": "no-reply@trustlist.uk",
    "displayName": "TrustList",
    "replyTo": "contact@trustlist.uk",
    "webhookUrl": "https://backend.trustlist.uk/api/mta/webhook",
    "smtp": {
      "host": "mail.trustlist.uk",
      "port": 587,
      "secure": false,
      "username": "no-reply@trustlist.uk",
      "password": "<smtp-password>"
    }
  }'
```

**Response 201**

```json
{
  "sender": {
    "uuid": "8c4c…",
    "address": "no-reply@trustlist.uk",
    "displayName": "TrustList",
    "smtp": { "host": "mail.trustlist.uk", "port": 587, "secure": false, "username": "no-reply@trustlist.uk" },
    "webhookUrl": "https://backend.trustlist.uk/api/mta/webhook",
    "isAdmin": true,
    "status": "active",
    "createdAt": "2026-06-29T15:55:00Z"
  },
  "trustToken": "Show-this-ONCE-then-store-it...",
  "webhookSecret": "Hmac-signing-secret-for-incoming-webhook-verification"
}
```

> ⚠️ `trustToken` and `webhookSecret` are returned **once**. Store them; they cannot be retrieved later.

### `GET /v1/senders/me`

Returns the sender record (SMTP credentials excluded).

### `PUT /v1/senders/me`

Update display name, reply-to, webhook URL, and / or SMTP config:

```json
{
  "displayName": "TrustList Marketing",
  "smtp": { "password": "new-smtp-password" }
}
```

### `DELETE /v1/senders/me`

Soft-deletes the sender (`status: "deleted"`). In-flight messages drain naturally; future sends are rejected.

### `POST /v1/senders/me/rotate-token`

Returns a new `trustToken`. The previous token is invalidated immediately.

---

## Sending mail

### `POST /v1/send` — single message

Default class: **`transactional`** (always picked first by the worker; bypasses per-domain reputation pacing).

```bash
curl -X POST https://mta.example.com/v1/send \
  -H 'Content-Type: application/json' \
  -H 'X-Trust-Token: <token>' \
  -d '{
    "to": "user@example.com",
    "subject": "Reset your password",
    "html": "<p>Hi {{name}}, <a href=\"{{reset_url}}\">reset here</a>.</p>",
    "text": "Hi {{name}}, reset at {{reset_url}}",
    "data": { "name": "Ada" },
    "actions": [
      { "key": "reset_url", "type": "confirm",
        "redirect": "https://app.example.com/reset?token=…",
        "expires_hours": 24 }
    ]
  }'
```

**Response 202**

```json
{ "status": "queued", "uuid": "f3a1…" }
```

If the recipient is suppressed, the response is `200 { "status": "dropped", "reason": "hard_bounce" }`.

Body fields:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `to` | string | yes | recipient email |
| `subject` | string | yes | supports `{{vars}}` if `data` is supplied |
| `html` | string | one of html/text | supports `{{vars}}` |
| `text` | string | one of html/text | supports `{{vars}}` |
| `data` | object | no | substitution data for `{{vars}}` |
| `actions` | array | no | see [actions schema](#action-definition) |
| `class` | `transactional`\|`marketing` | no | default `transactional` |
| `replyTo` | string | no | overrides sender default |
| `headers` | object | no | extra headers |
| `scheduledAt` | ISO timestamp | no | delay first attempt |

### `POST /v1/send/batch` — templated batch

Default class: **`marketing`**. One outbox row per recipient, suppression checked per address.

```bash
curl -X POST https://mta.example.com/v1/send/batch \
  -H 'Content-Type: application/json' \
  -H 'X-Trust-Token: <token>' \
  -d '{
    "subject": "{{first_name}}, your invitation",
    "html": "<p>Hello {{first_name}}.</p><p><a href=\"{{accept_url}}\">Accept</a> · <a href=\"{{decline_url}}\">Decline</a></p>",
    "text": "Hello {{first_name}}. Accept: {{accept_url}}  Decline: {{decline_url}}",
    "recipients": [
      { "to": "ada@example.com",   "data": { "first_name": "Ada" } },
      { "to": "grace@example.com", "data": { "first_name": "Grace" } }
    ],
    "actions": [
      { "key": "accept_url",  "type": "approval",
        "redirect": "https://app.example.com/invite/123/accept",
        "expires_hours": 72 },
      { "key": "decline_url", "type": "decline",
        "redirect": "https://app.example.com/invite/123/decline",
        "expires_hours": 72 }
    ]
  }'
```

**Response 202**

```json
{ "status": "queued", "batch_uuid": "b8a1…", "total": 2, "queued": 2, "dropped": 0 }
```

Per-recipient action tokens are generated automatically — each recipient sees their own `{{accept_url}}` value, so click events are attributed to the correct person.

#### Action definition

```json
{
  "key":           "accept_url",     // becomes {{accept_url}} in the template
  "type":          "approval",       // cta | approval | decline | confirm
  "label":         "Accept",         // optional, surfaced in webhook payloads
  "redirect":      "https://...",    // where the recipient lands after click
  "expires_hours": 72                // optional; default 72
}
```

---

## Messages

### `GET /v1/messages?status=&to=&class=&limit=&offset=`

List own messages. Filterable by `status` (`queued`/`sending`/`sent`/`deferred`/`bounced`/`failed`/`dropped`), recipient `to`, `class`, `limit` (≤500, default 50), `offset`.

### `GET /v1/messages/:idOrUuid`

Returns the message + full event history.

```json
{
  "message": { "id": 42, "uuid": "f3a1…", "to_addr": "user@example.com", "status": "sent", "sent_at": "…", … },
  "events": [
    { "type": "queued",  "occurred_at": "…" },
    { "type": "sending", "occurred_at": "…" },
    { "type": "sent",    "occurred_at": "…" }
  ]
}
```

Returns `403` if the message belongs to a different sender (unless caller is admin).

---

## Batches

### `GET /v1/batches?limit=&offset=`

List own batches.

### `GET /v1/batches/:idOrUuid`

Batch metadata.

### `GET /v1/batches/:idOrUuid/report`

Live aggregate delivery report:

```json
{
  "batch_uuid":      "b8a1…",
  "class":           "marketing",
  "total":           1000,
  "queued":          200,
  "sent":            750,
  "bounced_hard":    12,
  "bounced_soft":    8,
  "suppressed":      20,
  "failed":          3,
  "pending":         7,
  "actions_clicked": { "accept_url": 43, "decline_url": 12 },
  "unsubscribed":    5,
  "complete":        false
}
```

`complete` becomes `true` when every recipient has reached a terminal state (`sent`/`bounced`/`failed`/`dropped`).

---

## Suppression

### `GET /v1/suppressions?address=&limit=&offset=`

Lists active suppressions visible to this sender: global plus their own per-sender unsubscribes.

### `POST /v1/suppressions`

```json
{ "address": "test@example.com", "reason": "manual_block", "note": "spamtrap" }
```

By default scope is the sender's own UUID. To suppress globally (cross-sender), set `"scope": "global"` — admin only.

### `DELETE /v1/suppressions/:address?scope=`

Clears a suppression. `scope=global` is admin-only; otherwise defaults to the calling sender's scope.

---

## Domains (admin)

### `GET /v1/domains?limit=&offset=`

Per-domain reputation and counters:

```json
{
  "domains": [
    { "domain": "gmail.com", "sent": 12450, "delivered": 12380,
      "bounced": 41, "complained": 0, "deferred": 29,
      "score": 99, "score_override": null, "max_per_minute": null,
      "last_sent_at": "…" }
  ]
}
```

### `GET /v1/domains/:domain`

Single-domain detail (creates an empty row if not yet seen).

### `PUT /v1/domains/:domain`

Override reputation behaviour:

```json
{
  "scoreOverride": 100,
  "maxPerMinute": 60,
  "notes": "Trusted corporate relay"
}
```

Pass `null` for any field to clear an override.

### `POST /v1/domains/:domain/reset`

Zeros the domain's counters (useful after a known data-quality fix).

---

## Action interception (public)

### `GET /action/:token`

Recipients click links generated from the `actions` array (see send endpoints). The mailer:

1. Verifies the HMAC token
2. Records a `action_clicked` event on the parent message
3. Enqueues an `action_clicked` webhook to the sender
4. `302` redirects to the registered `redirect` URL

Expired tokens return `410 Gone`. Invalid tokens return `400`.

---

## Unsubscribe (public)

Every `marketing` class message includes a `List-Unsubscribe` header pointing to `/unsubscribe/:token`.

### `GET /unsubscribe/:token`

Renders a confirmation page; suppresses the recipient for this sender only.

### `POST /unsubscribe/:token`

RFC 8058 one-click (used by Gmail / Apple Mail). Performs the same suppression and returns `200 { "status": "unsubscribed" }`.

---

## Webhook payloads

Webhooks are signed with the sender's `webhookSecret`:

```http
POST /your/webhook/endpoint HTTP/1.1
Content-Type: application/json
User-Agent: MTA/1
X-Mailer-Event: sent
X-Mailer-Delivery: 12345
X-Mailer-Signature: sha256=<hmac-sha256-hex-of-body>

{ "event": "sent", "message_uuid": "…", "to": "…", "class": "transactional",
  "providerMessageId": "<…@…>", "occurred_at": "2026-06-29T15:55:00Z" }
```

Verify by computing `sha256=HMAC_SHA256(webhookSecret, raw_body)` and `timingSafeEqual` against the header.

| `event` | When |
|---------|------|
| `sent` | SMTP relay accepted the message |
| `deferred` | transient failure, will retry |
| `bounced` | hard or soft bounce (see `bounceType`) |
| `complained` | recipient reported the mail as spam |
| `failed` | permanent non-recipient error or attempts exhausted |
| `action_clicked` | recipient clicked an action link |
| `unsubscribed` | recipient unsubscribed |

A non-2xx response triggers exponential-backoff retry (1m → 5m → 15m → 1h → 3h, 6 total attempts) before the delivery is marked `failed`.

---

## Error format

All errors return JSON:

```json
{ "error": "short_machine_readable_reason", "message": "Human-readable detail (optional)" }
```

Common codes:

| Status | Meaning |
|--------|---------|
| `400` | Missing/invalid input or bad token |
| `401` | Missing or invalid trust token |
| `403` | Admin-only route or cross-tenant access denied |
| `404` | Resource not found |
| `410` | Action / unsubscribe token expired |
| `500` | Server failure (check logs) |
