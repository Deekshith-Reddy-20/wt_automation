# Suraj Solar — Multilingual WhatsApp Lead Qualification

A Flow (Flows module, existing engine) that greets a new WhatsApp enquiry,
lets the customer pick Telugu / English / Hindi, asks category-specific
qualification questions, scores the lead (HOT / WARM / NURTURE), writes the
answers to the contact's CRM fields and hands the conversation to the sales
queue (round robin).

Source of truth for the copy and graph: `src/lib/suraj-solar/lead-flow.ts`.

## Status

- Built and covered by mocked tests only. **No real WhatsApp message has
  been sent or received through this flow.** A passing mocked test does not
  prove live Meta messaging works.
- Seeded as a **Draft**. It does nothing for customers until an admin
  activates it.

## Before deploying / activating

1. **Apply migration `055_flow_lead_capture_and_opt_out.sql`** to the target
   Supabase database (SQL editor or `supabase db push`). It is additive and
   idempotent: it widens the `flow_nodes.node_type` check to allow
   `update_contact` / `score_lead` and adds `contacts.opted_out_at`.
   Without it, seeding the flow fails (node type check) and opt-out is not
   persisted.
2. Seed (creates missing custom fields, tags and the draft flow; never
   duplicates). Needs Node 22.18+ / 23.6+ because it imports the `.ts` flow
   definition directly:

   ```bash
   node scripts/seed-suraj-solar.mjs --owner-email you@surajsolar.com
   ```

   An existing flow is left untouched. To rebuild its nodes after changing
   `lead-flow.ts`, pause it first, then add `--update-flow`.
3. Keep the automation **"Suraj Solar · New WhatsApp enquiry"** inactive —
   it also fires on the first inbound message and would double-greet.
4. Make sure at least one agent/admin exists in the account, so round-robin
   handoff has someone to assign to.
5. Confirm the Meta webhook (GET verification and signed POSTs) works on the
   deployed URL — see `META_WHATSAPP_SETUP.md`.

## Testing without sending anything

Automations page → **Suraj Solar — Multilingual WhatsApp Lead
Qualification** card → **Test**. This drives
the flow through `POST /api/flows/[id]/test` (admin only) against a dedicated
test contact (`+91 55555 99999`, non-routable). Every outbound message is
built as a real Meta payload but simulated — nothing reaches WhatsApp. Use
**Reset** to start over.

## Activation

Card → **Activate** (admin, with confirmation). The card shows **Active**
only when the flow is enabled and valid; it shows **Error** when the flow
has no entry node / nodes or the latest run failed, and **Paused** after
**Pause**.

## Behaviour notes

- Triggers on the first inbound message of a new conversation, or on a
  restart keyword: `menu`, `main menu`, `restart`, `start over`, `మెనూ`,
  `मेनू`.
- Webhook retries (same message id) and status events (sent / delivered /
  read) never start or advance a run.
- Questions accept a button tap or a typed answer; every question has a
  skip option. The name question is asked only when the contact has no name.
- Language choice and greetings never add score points.
- STOP / UNSUBSCRIBE opts the contact out of all automated messages (flows,
  automations, AI auto-reply, broadcasts); START opts back in. Agents can
  still reply manually.
- Messages never promise a booking or a response time.
