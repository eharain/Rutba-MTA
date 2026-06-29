# Security Policy

## Reporting a vulnerability

If you find a security issue in Rutba MTA — anything that could compromise message confidentiality, allow forged action / unsubscribe clicks, leak SMTP credentials, bypass tenant isolation, or otherwise harm users of the service — **please do not file a public GitHub issue**.

Instead, email a brief report to **eharain@gmail.com** with:

- A description of the issue and its impact
- Steps to reproduce (ideally a minimal proof-of-concept)
- Your name / handle if you want credit in the changelog

You will receive an acknowledgement within 7 days. We aim to ship a fix within 30 days for high-impact issues; lower-impact issues are batched into the next minor release.

## Supported versions

Only the latest released version on the `main` branch receives security fixes.

## Threat model — what Rutba MTA tries to defend against

- **Action token forgery** — action and unsubscribe URLs are HMAC-signed; tokens are kind-namespaced so an unsubscribe link cannot be replayed as an action click.
- **SMTP credential exposure at rest** — sender SMTP passwords are encrypted with AES-256-GCM keyed by `MAILER_SMTP_ENC_KEY` before insertion.
- **Trust token theft from the DB** — trust tokens are stored only as SHA-256 hashes; the raw token is shown to the operator once at registration and never persisted.
- **Cross-tenant data access** — every per-sender API route enforces ownership before returning records. Admin senders (`is_admin = true`) may cross tenants.
- **Webhook receiver impersonation** — outbound webhook payloads are signed with the per-sender webhook secret (`X-Mailer-Signature: sha256=…`); receivers verify with timing-safe HMAC comparison.

## Out of scope

- DDoS at the HTTP layer — front the service with a reverse proxy that handles rate limiting / WAF concerns.
- Compromise of the host or MySQL — Rutba MTA assumes the trust boundary is at the API edge.
- Email content security (SPF / DKIM / DMARC) — the sender's own SMTP relay is responsible for signing; Rutba MTA does not perform DKIM signing itself.
- Long-term archival of message bodies — `outbox.html` / `body_text` rows remain forever unless the operator prunes them. If you need PII-aware retention, schedule a periodic purge job.

## Best practices for operators

- Generate `MAILER_HMAC_SECRET` and `MAILER_SMTP_ENC_KEY` with `openssl rand -hex 32` and store backups separately from the database.
- Restrict `/v1/*` access to your internal network where possible; only `/action/:token`, `/unsubscribe/:token`, and `/health` need to be publicly reachable.
- Rotate trust tokens (`POST /v1/senders/me/rotate-token`) whenever a deploy artefact may have been exposed.
- Rotate webhook secrets (`POST /v1/senders/me/rotate-webhook-secret`) on the same trigger.
- Monitor the `failed` and `bounced` event rates; an unexpected spike often precedes account-reputation damage.
