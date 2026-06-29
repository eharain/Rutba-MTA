'use strict';

const crypto = require('crypto');
const config = require('../config');

/**
 * API-key auth. Each product sends `X-Api-Key: <key>`; the key maps to an `app`
 * (tenant). Apps listed in MAILER_ADMIN_APPS may do global suppression and
 * cross-tenant reads. Comparison is constant-time to avoid timing leaks.
 */
function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function resolveApp(presentedKey) {
  for (const [key, app] of config.apiKeys.entries()) {
    if (timingSafeEqualStr(key, presentedKey)) return app;
  }
  return null;
}

function requireApiKey(req, res, next) {
  const presented = req.get('X-Api-Key') || '';
  if (!presented) return res.status(401).json({ error: 'missing_api_key' });
  const app = resolveApp(presented);
  if (!app) return res.status(401).json({ error: 'invalid_api_key' });
  req.tenant = app; // NB: not req.app (that is the Express app)
  req.isAdmin = config.adminApps.has(app);
  next();
}

module.exports = { requireApiKey, resolveApp };
