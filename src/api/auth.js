'use strict';

/**
 * Trust-token auth middleware. Loads the sender record (or 401s) and attaches
 * it to req.sender. Admin-only routes additionally check sender.is_admin.
 */

const sendersSvc = require('../services/senders');

async function requireTrustToken(req, res, next) {
  try {
    const token = req.get('X-Trust-Token') || (req.query && req.query.token) || '';
    if (!token) return res.status(401).json({ error: 'missing trust token' });
    const sender = await sendersSvc.authenticate(token);
    if (!sender) return res.status(401).json({ error: 'invalid trust token' });
    req.sender = sender;
    next();
  } catch (e) {
    res.status(500).json({ error: 'auth failure', message: e.message });
  }
}

function requireAdmin(req, res, next) {
  if (!req.sender || !req.sender.isAdmin) {
    return res.status(403).json({ error: 'admin only' });
  }
  next();
}

module.exports = { requireTrustToken, requireAdmin };
