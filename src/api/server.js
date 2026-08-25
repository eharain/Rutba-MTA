'use strict';

const express = require('express');
const log = require('../logger');

function buildApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '4mb' }));

  // Request logger.
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      log.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms`);
    });
    next();
  });

  // Public (no auth).
  app.use('/', require('./routes/public'));

  // /v1/*
  app.use('/v1/senders', require('./routes/senders'));
  app.use('/v1', require('./routes/send'));            // /v1/send + /v1/send/batch
  app.use('/v1/messages', require('./routes/messages'));
  app.use('/v1/batches', require('./routes/batches'));
  app.use('/v1/suppressions', require('./routes/suppressions'));
  app.use('/v1/domains', require('./routes/domains'));
  app.use('/v1/dns', require('./routes/dns'));         // sending-domain DNS gate state

  // 404 + error handler.
  app.use((req, res) => res.status(404).json({ error: 'not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    log.error('[api]', err.message);
    res.status(500).json({ error: 'internal', message: err.message });
  });

  return app;
}

module.exports = { buildApp };
