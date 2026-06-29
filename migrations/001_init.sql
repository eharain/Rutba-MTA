-- Rutba MTA initial schema (database name is configurable via MAILER_DB_NAME).
-- See FUNCTION.md for the design that informs each table.

-- Registered sender: an external app's outbound identity. Each sender owns its
-- own SMTP credentials (encrypted at rest) and an optional webhook URL. The
-- trust_token_hash is the SHA-256 of the secret we returned to the app at
-- registration; clients present the secret via `X-Trust-Token`.
CREATE TABLE IF NOT EXISTS sender (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  address VARCHAR(320) NOT NULL,
  display_name VARCHAR(190) NULL,
  reply_to VARCHAR(320) NULL,
  smtp_host VARCHAR(255) NOT NULL,
  smtp_port INT UNSIGNED NOT NULL DEFAULT 587,
  smtp_secure TINYINT(1) NOT NULL DEFAULT 0,
  smtp_username VARCHAR(255) NULL,
  smtp_password_enc TEXT NULL,
  webhook_url VARCHAR(512) NULL,
  webhook_secret VARCHAR(128) NULL,
  is_admin TINYINT(1) NOT NULL DEFAULT 0,
  status ENUM('active','disabled','deleted') NOT NULL DEFAULT 'active',
  trust_token_hash CHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sender_uuid (uuid),
  UNIQUE KEY uq_sender_address (address),
  KEY ix_sender_token (trust_token_hash),
  KEY ix_sender_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A templated batch send: one row per POST /v1/send/batch. The same row is
-- referenced by every per-recipient outbox row in the batch.
CREATE TABLE IF NOT EXISTS batch (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  sender_id BIGINT UNSIGNED NOT NULL,
  msg_class ENUM('transactional','marketing') NOT NULL DEFAULT 'marketing',
  subject_template VARCHAR(998) NULL,
  html_template MEDIUMTEXT NULL,
  text_template MEDIUMTEXT NULL,
  total INT UNSIGNED NOT NULL DEFAULT 0,
  queued INT UNSIGNED NOT NULL DEFAULT 0,
  dropped INT UNSIGNED NOT NULL DEFAULT 0,
  completed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_batch_uuid (uuid),
  KEY ix_batch_sender (sender_id, created_at),
  CONSTRAINT fk_batch_sender FOREIGN KEY (sender_id) REFERENCES sender (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Durable message queue + delivery log. One row per recipient.
CREATE TABLE IF NOT EXISTS outbox (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  sender_id BIGINT UNSIGNED NOT NULL,
  batch_id BIGINT UNSIGNED NULL,
  msg_class ENUM('transactional','marketing') NOT NULL DEFAULT 'transactional',
  from_addr VARCHAR(320) NOT NULL,
  reply_to VARCHAR(320) NULL,
  to_addr VARCHAR(320) NOT NULL,
  to_domain VARCHAR(255) NOT NULL,
  subject VARCHAR(998) NULL,
  html MEDIUMTEXT NULL,
  body_text MEDIUMTEXT NULL,
  headers JSON NULL,
  status ENUM('queued','sending','sent','deferred','bounced','failed','dropped') NOT NULL DEFAULT 'queued',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts INT UNSIGNED NOT NULL DEFAULT 6,
  next_attempt_at DATETIME NULL,
  scheduled_at DATETIME NULL,
  provider_message_id VARCHAR(255) NULL,
  error TEXT NULL,
  sent_at DATETIME NULL,
  unsubscribed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_outbox_uuid (uuid),
  -- Worker pickup index: status + class (transactional first) + due time.
  KEY ix_outbox_pickup (status, msg_class, next_attempt_at),
  KEY ix_outbox_sender (sender_id, created_at),
  KEY ix_outbox_batch (batch_id),
  KEY ix_outbox_to (to_addr),
  KEY ix_outbox_domain (to_domain),
  CONSTRAINT fk_outbox_sender FOREIGN KEY (sender_id) REFERENCES sender (id) ON DELETE CASCADE,
  CONSTRAINT fk_outbox_batch FOREIGN KEY (batch_id) REFERENCES batch (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Per-message lifecycle events. `dropped` is recorded on suppression-at-queue;
-- `action_clicked` and `unsubscribed` carry the relevant key in `extra`.
CREATE TABLE IF NOT EXISTS event (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  message_id BIGINT UNSIGNED NULL,
  message_uuid CHAR(36) NULL,
  sender_id BIGINT UNSIGNED NULL,
  type ENUM(
    'queued','sending','sent','deferred','bounced','complained',
    'failed','dropped','opened','action_clicked','unsubscribed'
  ) NOT NULL,
  smtp_code VARCHAR(16) NULL,
  bounce_type ENUM('hard','soft') NULL,
  reason TEXT NULL,
  extra JSON NULL,
  raw MEDIUMTEXT NULL,
  occurred_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_event_message (message_id),
  KEY ix_event_uuid (message_uuid),
  KEY ix_event_type (type),
  KEY ix_event_sender (sender_id, occurred_at),
  CONSTRAINT fk_event_message FOREIGN KEY (message_id) REFERENCES outbox (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Per-recipient action tokens (CTA / approval / decline / confirm). The token
-- itself is signed (HMAC) so verification needs no DB lookup, but we persist
-- the redirect URL + click state for reporting and webhook payloads.
CREATE TABLE IF NOT EXISTS message_action (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  token VARCHAR(128) NOT NULL,
  message_id BIGINT UNSIGNED NOT NULL,
  message_uuid CHAR(36) NOT NULL,
  sender_id BIGINT UNSIGNED NOT NULL,
  action_key VARCHAR(64) NOT NULL,
  action_type ENUM('cta','approval','decline','confirm') NOT NULL DEFAULT 'cta',
  label VARCHAR(190) NULL,
  redirect_url VARCHAR(1024) NOT NULL,
  expires_at DATETIME NULL,
  clicked_at DATETIME NULL,
  click_ip VARCHAR(64) NULL,
  click_ua VARCHAR(512) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_action_token (token),
  KEY ix_action_message (message_id, action_key),
  CONSTRAINT fk_action_message FOREIGN KEY (message_id) REFERENCES outbox (id) ON DELETE CASCADE,
  CONSTRAINT fk_action_sender FOREIGN KEY (sender_id) REFERENCES sender (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Suppression. scope='global' is cross-sender (hard bounce, complaint, manual
-- block). scope=<sender_uuid> is per-sender (unsubscribe from that sender only).
CREATE TABLE IF NOT EXISTS suppression (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  address VARCHAR(320) NOT NULL,
  scope VARCHAR(64) NOT NULL DEFAULT 'global',
  reason ENUM('hard_bounce','complaint','manual_block','unsubscribe') NOT NULL DEFAULT 'manual_block',
  active TINYINT(1) NOT NULL DEFAULT 1,
  source_uuid CHAR(36) NULL,
  note VARCHAR(512) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_suppression (address, scope),
  KEY ix_suppression_addr (address),
  KEY ix_suppression_active (active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Per-receiving-domain counters + computed score. Updated after every send
-- outcome (sent / bounced / complained / deferred). `score_override` lets an
-- admin pin a score (e.g. force 100 for a known good corporate relay, or 0 to
-- pause sends to a problem domain). `max_per_minute` is the hard ceiling that
-- applies to ALL classes including transactional.
CREATE TABLE IF NOT EXISTS domain_reputation (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  domain VARCHAR(255) NOT NULL,
  sent BIGINT UNSIGNED NOT NULL DEFAULT 0,
  delivered BIGINT UNSIGNED NOT NULL DEFAULT 0,
  bounced BIGINT UNSIGNED NOT NULL DEFAULT 0,
  complained BIGINT UNSIGNED NOT NULL DEFAULT 0,
  deferred BIGINT UNSIGNED NOT NULL DEFAULT 0,
  score INT NOT NULL DEFAULT 100,
  score_override INT NULL,
  max_per_minute INT UNSIGNED NULL,
  last_sent_at DATETIME NULL,
  notes VARCHAR(512) NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_domain (domain)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Lightweight per-minute counter for the hard ceiling. Rolled over by the
-- worker on each tick: rows older than 1 minute are pruned.
CREATE TABLE IF NOT EXISTS domain_rate_bucket (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  domain VARCHAR(255) NOT NULL,
  minute_start DATETIME NOT NULL,
  count INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_domain_minute (domain, minute_start),
  KEY ix_minute (minute_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Outbound webhook delivery log so we can prove (and retry) what we told the
-- sender. A failed POST schedules a retry; status moves to 'delivered' on 2xx.
CREATE TABLE IF NOT EXISTS webhook_delivery (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sender_id BIGINT UNSIGNED NOT NULL,
  message_id BIGINT UNSIGNED NULL,
  batch_id BIGINT UNSIGNED NULL,
  event_type VARCHAR(64) NOT NULL,
  payload JSON NOT NULL,
  status ENUM('pending','delivered','failed') NOT NULL DEFAULT 'pending',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  last_status_code INT NULL,
  last_error TEXT NULL,
  next_attempt_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY ix_webhook_pickup (status, next_attempt_at),
  KEY ix_webhook_sender (sender_id, created_at),
  CONSTRAINT fk_webhook_sender FOREIGN KEY (sender_id) REFERENCES sender (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
