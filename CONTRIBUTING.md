# Contributing to Rutba MTA

Thank you for considering a contribution! Rutba MTA is open source under Apache 2.0 — patches, bug reports, and feature ideas are all welcome.

---

## Quick start for contributors

```bash
git clone https://github.com/<your-fork>/rutba-mta.git
cd rutba-mta
npm install
npm test                    # 58 pure-logic unit tests — should pass with no setup
```

For end-to-end testing you'll need MySQL and a reachable SMTP server. See [DEPLOYMENT.md](./DEPLOYMENT.md).

---

## Project layout

```
rutba-mta/
├── FUNCTION.md            ← Functional specification (start here)
├── README.md              ← Overview + quick links
├── API.md                 ← Full HTTP API reference
├── DEPLOYMENT.md          ← Production install + ops
├── migrations/            ← Forward-only SQL migrations
├── src/
│   ├── lib/               ← Pure logic: reputation, tokens, template, crypto, …
│   ├── services/          ← DB-backed domain services
│   ├── smtp/              ← Per-sender pooled nodemailer transport
│   ├── worker/            ← Send loop + webhook delivery loop
│   ├── bounce/            ← IMAP bounce poller
│   ├── api/               ← Express routes + auth middleware
│   ├── config.js          ← Env-var central config
│   ├── db.js              ← MySQL pool + transactions
│   └── index.js           ← Boot
└── test/                  ← Unit tests for pure libs (no DB needed)
```

`src/lib/` modules are **pure** (no DB, no network) and are the most heavily tested. New behavioural rules belong here whenever possible.

---

## How to file an issue

Open an issue on GitHub and include:

1. What you tried, what you expected, what happened.
2. Versions: Node, MySQL, OS.
3. Relevant log lines (with `MAILER_DEBUG=1` if applicable).
4. Minimal reproduction if you can.

For security issues, please email the maintainer privately rather than opening a public issue.

---

## How to submit a change

1. **Open an issue first** for anything non-trivial — saves rework if the direction needs alignment.
2. **Fork + branch:** branch off `main` with a short descriptive name (e.g. `fix-bounce-uuid-extraction`).
3. **Keep changes focused:** one logical change per PR. Bug fixes shouldn't drag in refactors.
4. **Add or update tests.** Pure-logic changes must have unit tests under `test/`. Changes that touch the DB / API should describe the manual verification you did.
5. **Match the existing style.** No formatter is enforced; just keep it readable and consistent with the surrounding code. Single quotes, two-space indent, no trailing semicolons inside template literals, JSDoc only where the comment adds something the code doesn't already say.
6. **Document user-facing changes** in `API.md`, `DEPLOYMENT.md`, or `README.md` as appropriate.
7. **Update `CHANGELOG.md`** under an `## Unreleased` section.

---

## Coding guidelines

### Database
- All write operations on cross-row state go through `db.withTransaction`.
- Worker-pickup paths use atomic claim updates — never trust that a `SELECT` row is still claimable.
- LIMIT / OFFSET values are coerced with `Number(x) || default` before string-interpolation. Never let raw query strings reach SQL.

### Security
- Recipient suppression checks happen **at both** queue time (API) and send time (worker). Never skip the worker check.
- HMAC tokens (`src/lib/tokens.js`) verify with `timingSafeEqual`. Don't add new token paths that compare strings directly.
- SMTP passwords go through `src/lib/crypto.js` for at-rest encryption. Never persist them in plaintext.
- Trust tokens are returned once at registration and stored as SHA-256 hashes only.

### Logging
- Use the leveled logger in `src/logger.js`. Don't `console.log` directly.
- Never log secrets, passwords, or token values.
- Log enough context (message UUID, sender UUID, error message) to triage from logs alone.

### Backwards compatibility
- API responses are public contracts. Don't remove or rename fields without a deprecation note.
- DB migrations are forward-only. To remove a column, add a new migration that drops it; never edit a previously-applied migration file.

---

## Adding a new lifecycle event

Events are tracked in the `event` table's enum. To add one (e.g. `clicked` for click-through tracking):

1. New migration: `ALTER TABLE event MODIFY COLUMN type ENUM(…, 'clicked');`
2. Emit it: `messages.logEvent({ ..., type: 'clicked' })`.
3. Webhook payload: include it in the webhook dispatcher's event types.
4. Document it in `API.md` under webhook payloads.

---

## Adding a new action type

Action types are validated in `src/services/actions.js`'s `ACTION_TYPES` set. To add one (e.g. `'rsvp'`):

1. Add to `ACTION_TYPES` and to the `action_type` enum in a new migration.
2. Document in `API.md` under [Action definition](./API.md#action-definition).

---

## Tests

```bash
npm test
```

The suite uses Node's built-in test runner. Add `*.test.mjs` files under `test/`. Pure-logic tests should not import anything from `src/db.js`, `src/api/`, `src/smtp/`, `src/worker/`, or `src/bounce/`.

Coverage is intentionally focused on the pure-logic layer (where bugs cause silent data corruption) rather than the I/O layer (where bugs typically surface loudly in integration).

---

## Release process

1. Bump `version` in `package.json`.
2. Move `## Unreleased` entries in `CHANGELOG.md` under a new `## [x.y.z] - YYYY-MM-DD` heading.
3. Commit, tag (`git tag vX.Y.Z`), push (`git push --tags`).
4. Build & publish the Docker image as `rutba-mta:X.Y.Z` and update `:latest`.

---

## Code of conduct

Be respectful. Disagree on technical merit, not on people. The maintainer reserves the right to remove contributions or block participants whose conduct is harmful to others.

---

## License

By contributing to Rutba MTA, you agree that your contributions will be licensed under the same Apache License 2.0 as the rest of the project. See [LICENSE](./LICENSE).
