-- DNS gate (owner decision, 2026-08-25): campaign mail is NOT forwarded for a
-- sending domain that lacks its required DNS records - SPF present, DKIM
-- present at the sender's selector (DMARC advisory). The MTA relays through
-- the sender's own SMTP server and never holds the DKIM key, so the check is
-- record PRESENCE at the published selector; signing remains the sender's
-- SMTP server's job (FUNCTION.md).
--
-- sender_domain_dns is the SENDING-domain registry. domain_reputation stays
-- what it always was: RECEIVING-domain adaptive pacing. Never merge them.

ALTER TABLE sender
  ADD COLUMN dkim_selector VARCHAR(63) NULL AFTER reply_to;

CREATE TABLE IF NOT EXISTS sender_domain_dns (
  domain VARCHAR(255) NOT NULL,
  dkim_selector VARCHAR(63) NOT NULL DEFAULT 'default',
  status ENUM('unverified','verified','failed') NOT NULL DEFAULT 'unverified',
  spf_ok TINYINT(1) NOT NULL DEFAULT 0,
  dkim_ok TINYINT(1) NOT NULL DEFAULT 0,
  dmarc_ok TINYINT(1) NOT NULL DEFAULT 0,
  last_error VARCHAR(512) NULL,
  last_checked_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (domain)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
