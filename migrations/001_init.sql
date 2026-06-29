-- Mailer gateway schema (own MySQL database, e.g. `trustlist_mailer`).
-- Shared across products; rows are namespaced by `app` (the authenticated tenant).

CREATE TABLE IF NOT EXISTS email_message (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  app VARCHAR(64) NOT NULL,
  msg_class ENUM('transactional','bulk') NOT NULL DEFAULT 'transactional',
  from_addr VARCHAR(320) NOT NULL,
  reply_to VARCHAR(320) NULL,
  to_addr VARCHAR(320) NOT NULL,
  to_domain VARCHAR(255) NOT NULL,
  subject VARCHAR(998) NULL,
  html MEDIUMTEXT NULL,
  body_text MEDIUMTEXT NULL,
  headers JSON NULL,
  template_slug VARCHAR(190) NULL,
  status ENUM('queued','sending','sent','deferred','bounced','failed','dropped') NOT NULL DEFAULT 'queued',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts INT UNSIGNED NOT NULL DEFAULT 6,
  next_attempt_at DATETIME NULL,
  scheduled_at DATETIME NULL,
  provider_message_id VARCHAR(255) NULL,
  error TEXT NULL,
  sent_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_uuid (uuid),
  KEY ix_pickup (status, next_attempt_at),
  KEY ix_app_created (app, created_at),
  KEY ix_to_addr (to_addr),
  KEY ix_to_domain (to_domain)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS email_event (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  message_id BIGINT UNSIGNED NULL,
  message_uuid CHAR(36) NULL,
  type ENUM('queued','sending','sent','delivered','deferred','bounced','complained','failed','dropped','opened','clicked','unsubscribed') NOT NULL,
  smtp_code VARCHAR(16) NULL,
  bounce_type ENUM('hard','soft') NULL,
  reason TEXT NULL,
  raw MEDIUMTEXT NULL,
  occurred_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_message (message_id),
  KEY ix_uuid (message_uuid),
  KEY ix_type (type),
  CONSTRAINT fk_event_message FOREIGN KEY (message_id) REFERENCES email_message (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Suppression: scope = 'global' (address-level, e.g. hard bounce) OR an app id
-- (per-tenant, e.g. someone unsubscribing from one product's bulk mail only).
CREATE TABLE IF NOT EXISTS email_suppression (
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
  UNIQUE KEY uq_addr_scope (address, scope),
  KEY ix_address (address),
  KEY ix_active (active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Per-receiving-domain reputation drives drip/bleed pacing.
CREATE TABLE IF NOT EXISTS domain_reputation (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  domain VARCHAR(255) NOT NULL,
  sent BIGINT UNSIGNED NOT NULL DEFAULT 0,
  delivered BIGINT UNSIGNED NOT NULL DEFAULT 0,
  bounced BIGINT UNSIGNED NOT NULL DEFAULT 0,
  complained BIGINT UNSIGNED NOT NULL DEFAULT 0,
  deferred BIGINT UNSIGNED NOT NULL DEFAULT 0,
  score INT NOT NULL DEFAULT 100,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_domain (domain)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
