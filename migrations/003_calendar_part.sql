-- Rutba-MTA · a calendar part on an outbound message
--
-- An invitation is not an email with an attachment: iMIP (RFC 6047) puts the
-- iCalendar object in a text/calendar body part carrying the METHOD, and that
-- part is what makes a recipient's client show "Accept / Decline" instead of a
-- file to download. Without it, an invite sent from the suite is prose that a
-- human has to read and re-enter — which is what "the calendar sends nothing"
-- really costs.
--
-- Two columns rather than a generic attachments table, deliberately: this is
-- the ONE structured part the relay needs to carry, it is at most a few KB, and
-- a general attachment store is a different feature with different limits,
-- storage and abuse questions. When those are wanted they should be built as
-- what they are, not grown quietly out of this.
ALTER TABLE outbox
  ADD COLUMN calendar_method  varchar(20) NULL,
  ADD COLUMN calendar_content mediumtext  NULL;
