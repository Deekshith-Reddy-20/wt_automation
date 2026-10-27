-- ============================================================
-- 058: resolve_inbound_context — one round trip for inbound routing
--
-- NOT APPLIED to any database yet. Additive and backward compatible:
-- creates one function, changes no table, index, policy or existing
-- row. The webhook detects whether the function exists and falls back
-- to its previous per-table queries when it does not.
--
-- Before: every inbound WhatsApp message made these sequential round
-- trips before it could be stored:
--   1. whatsapp_config by phone_number_id         (UNIQUE, migration 013)
--   2. contact by wa_user_id, else phone variants (UNIQUE, 040 / 022)
--   3. INSERT contact when none matched           (new senders only)
--   4. oldest conversation for the contact        (UNIQUE, 036)
--   5. INSERT conversation when none exists
-- After: one call does all of them. Matching rules are unchanged:
--   - exactly one config row is required; 0 or ≥2 → nothing else runs
--     and the caller drops the delivery, as before;
--   - BSUID first; phone variants only when the BSUID matched nothing;
--   - a contact is created ONLY when nothing matched AND the caller
--     supplied p_new_contact (it passes the same fields it inserted
--     itself before), owned by the config's user_id;
--   - when phone candidates exist the caller still applies
--     pickBestPhoneMatch; if it rejects them all it creates the contact
--     through its previous path;
--   - the oldest conversation per contact, as findOrCreateConversation.
--
-- Concurrency: both INSERTs use ON CONFLICT DO NOTHING against the
-- existing unique indexes. A loser waits for the winner's transaction,
-- then re-reads (each statement takes a fresh READ COMMITTED snapshot),
-- so two simultaneous first messages resolve to one contact and one
-- conversation. The call is a single statement and therefore atomic: a
-- failure rolls back both inserts and the caller falls back.
--
-- Security: SECURITY INVOKER, executable by service_role only. The
-- result carries the ENCRYPTED access token, so anon / authenticated
-- must never be able to call it.
--
-- Rollback: DROP FUNCTION public.resolve_inbound_context(TEXT, TEXT, TEXT[], JSONB);
-- ============================================================

SET search_path = public;

CREATE OR REPLACE FUNCTION public.resolve_inbound_context(
  p_phone_number_id TEXT,
  p_wa_user_id TEXT,
  p_phone_variants TEXT[],
  p_new_contact JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_config JSONB;
  v_config_count INT;
  v_account UUID;
  v_owner UUID;
  v_matched_by TEXT := NULL;
  v_contact_ids UUID[] := '{}';
  v_new_contact contacts%ROWTYPE;
  v_contact_created BOOLEAN := FALSE;
  v_new_conv conversations%ROWTYPE;
  v_conv_created BOOLEAN := FALSE;
BEGIN
  SELECT count(*),
         coalesce(jsonb_agg(jsonb_build_object(
           'account_id', account_id,
           'user_id', user_id,
           'phone_number_id', phone_number_id,
           'access_token', access_token,
           'mirror_inbound_media', mirror_inbound_media
         )), '[]'::jsonb)
    INTO v_config_count, v_config
    FROM whatsapp_config
   WHERE phone_number_id = p_phone_number_id;

  IF v_config_count <> 1 THEN
    RETURN jsonb_build_object(
      'config', v_config,
      'matched_by', NULL,
      'contacts', '[]'::jsonb,
      'conversations', '[]'::jsonb,
      'contact_created', FALSE,
      'conversation_created', FALSE
    );
  END IF;

  SELECT account_id, user_id INTO v_account, v_owner
    FROM whatsapp_config
   WHERE phone_number_id = p_phone_number_id;

  -- Same lookup order as before: BSUID, then phone variants.
  IF p_wa_user_id IS NOT NULL THEN
    SELECT coalesce(array_agg(id), '{}') INTO v_contact_ids
      FROM contacts
     WHERE account_id = v_account AND wa_user_id = p_wa_user_id;
    IF cardinality(v_contact_ids) > 0 THEN v_matched_by := 'wa_user_id'; END IF;
  END IF;
  IF v_matched_by IS NULL AND coalesce(cardinality(p_phone_variants), 0) > 0 THEN
    SELECT coalesce(array_agg(id), '{}') INTO v_contact_ids
      FROM contacts
     WHERE account_id = v_account AND phone_normalized = ANY (p_phone_variants);
    IF cardinality(v_contact_ids) > 0 THEN v_matched_by := 'phone'; END IF;
  END IF;

  IF v_matched_by IS NULL AND p_new_contact IS NOT NULL THEN
    INSERT INTO contacts (account_id, user_id, phone, name, wa_user_id, wa_parent_user_id, wa_username)
    VALUES (
      v_account,
      v_owner,
      p_new_contact->>'phone',
      p_new_contact->>'name',
      p_new_contact->>'wa_user_id',
      p_new_contact->>'wa_parent_user_id',
      p_new_contact->>'wa_username'
    )
    ON CONFLICT DO NOTHING
    RETURNING * INTO v_new_contact;

    IF v_new_contact.id IS NOT NULL THEN
      v_contact_created := TRUE;
      v_matched_by := 'created';
      v_contact_ids := ARRAY[v_new_contact.id];

      INSERT INTO conversations (account_id, user_id, contact_id)
      VALUES (v_account, v_owner, v_new_contact.id)
      ON CONFLICT DO NOTHING
      RETURNING * INTO v_new_conv;
      v_conv_created := v_new_conv.id IS NOT NULL;
    ELSE
      -- Lost a race with a concurrent first message: read the winner.
      IF p_wa_user_id IS NOT NULL THEN
        SELECT coalesce(array_agg(id), '{}') INTO v_contact_ids
          FROM contacts
         WHERE account_id = v_account AND wa_user_id = p_wa_user_id;
        IF cardinality(v_contact_ids) > 0 THEN v_matched_by := 'wa_user_id'; END IF;
      END IF;
      IF v_matched_by IS NULL AND coalesce(cardinality(p_phone_variants), 0) > 0 THEN
        SELECT coalesce(array_agg(id), '{}') INTO v_contact_ids
          FROM contacts
         WHERE account_id = v_account AND phone_normalized = ANY (p_phone_variants);
        IF cardinality(v_contact_ids) > 0 THEN v_matched_by := 'phone'; END IF;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'config', v_config,
    'matched_by', v_matched_by,
    'contacts', coalesce((
      SELECT jsonb_agg(to_jsonb(c)) FROM contacts c WHERE c.id = ANY (v_contact_ids)
    ), '[]'::jsonb),
    -- Oldest conversation per contact, matching findOrCreateConversation.
    'conversations', coalesce((
      SELECT jsonb_agg(to_jsonb(v))
        FROM (
          SELECT DISTINCT ON (contact_id) *
            FROM conversations
           WHERE account_id = v_account AND contact_id = ANY (v_contact_ids)
           ORDER BY contact_id, created_at ASC
        ) v
    ), '[]'::jsonb),
    'contact_created', v_contact_created,
    'conversation_created', v_conv_created
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_inbound_context(TEXT, TEXT, TEXT[], JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_inbound_context(TEXT, TEXT, TEXT[], JSONB) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_inbound_context(TEXT, TEXT, TEXT[], JSONB) TO service_role;

COMMENT ON FUNCTION public.resolve_inbound_context(TEXT, TEXT, TEXT[], JSONB) IS
  'Inbound webhook routing in one round trip: the receiving number''s config, the matching contact(s) (BSUID first, then phone variants), creating the contact and its first conversation for a new sender, and each contact''s oldest conversation. service_role only.';
