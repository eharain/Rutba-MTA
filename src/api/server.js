'use strict';

const express = require('express');
const config = require('../config');
const log = require('../logger');
const db = require('../db');
const { requireApiKey } = require('./auth');
const messages = require('../services/messages');
const suppression = require('../services/suppression');
const { isValidEmail, normalizeAddress } = require('../lib/addresses');
const { normalizeClass } = require('../lib/msgclass');

// 1x1 transparent GIF for the open-tracking pixel.
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function buildApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '5mb' }));

  // ---- Health (no auth) ----
  app.get('/health', async (_req, res) => {
    try {
      await db.ping();
      res.json({ ok: true, service: 'mailer', env: config.env });
    } catch (e) {
      res.status(503).json({ ok: false, error: e.message });
    }
  });

  // ---- Public: one-click unsubscribe (no auth; identified by message uuid) ----
  app.get('/unsubscribe/:uuid', async (req, res) => {
    try {
      const msg = await messages.findByUuid(req.params.uuid);
      if (msg) {
        // Per-tenant unsubscribe: opt out of THIS product's mail, not others'.
        await suppression.suppress({ address: msg.to_addr, scope: msg.app, reason: 'unsubscribe', sourceUuid: msg.uuid });
        await messages.addEvent({ messageId: msg.id, messageUuid: msg.uuid, type: 'unsubscribed' });
      }
      res.set('Content-Type', 'text/html').send(
        '<!doctype html><meta charset="utf-8"><title>Unsubscribed</title>' +
          '<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;text-align:center">' +
          '<h1>You have been unsubscribed</h1><p>You will no longer receive these emails.</p></body>'
      );
    } catch (e) {
      log.error('[api] unsubscribe failed:', e.message);
      res.status(500).send('Error processing unsubscribe.');
    }
  });

  // POST form (RFC 8058 one-click) maps to the same handler.
  app.post('/unsubscribe/:uuid', express.urlencoded({ extended: false }), async (req, res) => {
    try {
      const msg = await messages.findByUuid(req.params.uuid);
      if (msg) {
        await suppression.suppress({ address: msg.to_addr, scope: msg.app, reason: 'unsubscribe', sourceUuid: msg.uuid });
        await messages.addEvent({ messageId: msg.id, messageUuid: msg.uuid, type: 'unsubscribed' });
      }
      res.status(200).end();
    } catch (e) {
      res.status(500).end();
    }
  });

  // ---- Public: open-tracking pixel ----
  app.get('/o/:uuid.gif', async (req, res) => {
    try {
      const msg = await messages.findByUuid(req.params.uuid);
      if (msg) await messages.addEvent({ messageId: msg.id, messageUuid: msg.uuid, type: 'opened' });
    } catch (_) { /* ignore — always serve the pixel */ }
    res.set('Content-Type', 'image/gif').set('Cache-Control', 'no-store, must-revalidate').send(PIXEL);
  });

  // ---- Authenticated API ----
  const api = express.Router();
  api.use(requireApiKey);

  // Send (enqueue). Suppressed recipients are dropped + logged, never sent.
  api.post('/send', async (req, res) => {
    const body = req.body || {};
    const to = normalizeAddress(body.to);
    if (!isValidEmail(to)) return res.status(400).json({ error: 'invalid_to' });
    if (!body.subject && !body.html && !body.text) return res.status(400).json({ error: 'empty_message' });

    const input = {
      app: req.tenant,
      to,
      from: body.from || config.smtp.from,
      replyTo: body.replyTo || null,
      subject: body.subject || '',
      html: body.html || null,
      text: body.text || null,
      headers: body.headers || null,
      templateSlug: body.templateSlug || null,
      msgClass: normalizeClass(body.class),
      scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
    };

    try {
      if (await suppression.isSuppressed(req.tenant, to)) {
        const dropped = await messages.createDropped(input, 'suppressed');
        return res.status(200).json({ status: 'dropped', id: dropped.id, uuid: dropped.uuid });
      }
      const { id, uuid } = await messages.createQueued(input);
      return res.status(202).json({ status: 'queued', id, uuid });
    } catch (e) {
      log.error('[api] send failed:', e.message);
      return res.status(500).json({ error: 'send_failed', detail: e.message });
    }
  });

  api.get('/messages', async (req, res) => {
    try {
      const rows = await messages.listMessages({
        app: req.tenant,
        admin: req.isAdmin && req.query.all === '1',
        status: req.query.status,
        to: req.query.to,
        limit: Math.min(200, Number(req.query.limit) || 50),
        offset: Number(req.query.offset) || 0,
      });
      res.json({ data: rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  api.get('/messages/:idOrUuid', async (req, res) => {
    try {
      const row = await messages.getMessageWithEvents({ app: req.tenant, idOrUuid: req.params.idOrUuid, admin: req.isAdmin });
      if (!row) return res.status(404).json({ error: 'not_found' });
      res.json({ data: row });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  api.get('/suppressions', async (req, res) => {
    try {
      const rows = await suppression.list({
        app: req.tenant,
        limit: Math.min(500, Number(req.query.limit) || 100),
        offset: Number(req.query.offset) || 0,
      });
      res.json({ data: rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Manual block. Default scope is the caller's app; only admin apps may set 'global'.
  api.post('/suppressions', async (req, res) => {
    const address = normalizeAddress((req.body || {}).address);
    if (!isValidEmail(address)) return res.status(400).json({ error: 'invalid_address' });
    let scope = (req.body || {}).scope || req.tenant;
    if (scope === 'global' && !req.isAdmin) scope = req.tenant;
    try {
      const out = await suppression.suppress({ address, scope, reason: (req.body || {}).reason || 'manual_block', note: (req.body || {}).note || null });
      res.status(201).json({ status: 'suppressed', ...out });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  api.delete('/suppressions/:address', async (req, res) => {
    let scope = req.query.scope || req.tenant;
    if (scope === 'global' && !req.isAdmin) return res.status(403).json({ error: 'forbidden_global_unsuppress' });
    try {
      const ok = await suppression.unsuppress(req.params.address, scope);
      res.json({ status: ok ? 'unsuppressed' : 'not_found' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.use('/v1', api);

  // 404 + error fallthrough
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    log.error('[api] unhandled:', err.message);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

module.exports = { buildApp };
