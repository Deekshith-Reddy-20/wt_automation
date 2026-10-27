-- ============================================================
-- Flow lead capture + WhatsApp opt-out.
--
--   1. flow_nodes.node_type gains two auto-advancing node types:
--        - 'update_contact' — copies captured flow vars onto the
--          contact (name / custom fields) and can append a note, so a
--          qualification flow's answers land on the CRM record.
--        - 'score_lead'     — computes a points-based lead score and
--          category (e.g. HOT / WARM / NURTURE) from captured vars
--          using rules stored in the node config.
--
--   2. contacts.opted_out_at — set when the customer asks to stop
--      automated messages (STOP / UNSUBSCRIBE …), cleared when they
--      opt back in (START). Automated senders (flows, automations,
--      AI auto-reply) and broadcasts skip contacts where it is set;
--      agents can still reply manually.
--
-- Additive only. Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE flow_nodes
  DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;

ALTER TABLE flow_nodes
  ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start',
    'send_buttons',
    'send_list',
    'send_message',
    'send_media',
    'collect_input',
    'condition',
    'set_tag',
    'update_contact',
    'score_lead',
    'handoff',
    'http_fetch',
    'end'
  ));

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS opted_out_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_contacts_account_opted_out
  ON contacts(account_id)
  WHERE opted_out_at IS NOT NULL;
