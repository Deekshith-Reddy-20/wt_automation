# Suraj Solar CRM — production-readiness audit (17 Oct 2026)

Evidence was gathered read-only from the dev-server log, the ngrok request
inspector, the hosted Supabase project (service role, no secrets printed)
and Meta's Graph API (GET calls only). Nothing was sent to WhatsApp.

## 1. "Hi" gets no welcome message

The inbound path is `POST /api/whatsapp/webhook` → signature check
(`META_APP_SECRET`) → `processMessage` → contact / conversation / message
insert → opt-out gate → `dispatchInboundToFlows` (Flows engine) →
automations engine → Meta send.

| # | Root cause | Evidence | Fix |
|---|---|---|---|
| 1a | **Meta has never POSTed an event to the app.** | ngrok inspector (13:41–15:31) shows only GET verification requests to `/api/whatsapp/webhook`, never a POST. The hosted DB has 0 messages, 0 contacts and 0 conversations. | Provider-side (see §5): subscribe the app's webhook to the `messages` field and keep the callback URL pointing at a live tunnel or deployment. |
| 1b | **The saved access token expired** at 15:30 IST on 17 Oct 2026. | Graph API returned `190 / 463 Session has expired` for the phone, `subscribed_apps` and `debug_token` calls. | Provider-side: generate a permanent System User token and re-save it in *Settings → WhatsApp*. The settings page already reports this on load. |
| 1c | **The welcome flow does not exist in the hosted DB.** | `flows` is empty; the seed was only ever run against a local stack. Migration 055 (needed for the flow's `update_contact` / `score_lead` nodes and opt-out) is absent (`42703`). | Needs approval: apply migration 055, then run the seed (it creates the flow as a Draft). |
| 1d | A conflicting automation, "Untitled automation", is **active** on `new_message_received` with a `send_buttons` step. | `automations` row with `is_active = true`. | Needs approval: pause it before activating the lead flow, otherwise every message (not just the first) triggers it. |

## 2. "Credentials valid" + "Not registered — Meta will not deliver events"

- **Credentials valid** was a live Meta check that was true while the
  temporary token was still valid. It now reports the expiry.
- **Not registered** came from a local timestamp only: `registered_at` is
  set only when an admin saves with the two-step verification PIN. It was
  never compared with Meta. *Code defect, fixed:*
  `GET /api/whatsapp/config/verify-registration` now reads Meta's
  `platform_type` / `status` for the number. "Registered" is shown only
  when Meta reports `CLOUD_API`, and `registered_at` is synced to that,
  including being cleared when Meta disagrees.
- The WABA *is* subscribed to the app (`subscribed_apps_at` was set today).
- Meta's phone status could not be read after 15:30 because of the
  expired token. Re-run **Verify with Meta** after saving the new token.

## 3. Signup and login "not working"

| Root cause | Evidence | Fix |
|---|---|---|
| **The app was used through the ngrok URL, and Next.js 16 dev mode blocked that origin.** `next.config.ts` allow-listed `*.ngrok-free.app`, but the tunnel is on the newer `*.ngrok-free.dev`. The HMR socket was refused, the page never hydrated, and the forms submitted natively (`GET /signup?`) without calling Supabase. | The dev log shows `Blocked cross-origin request … from "guide-mushily-condense.ngrok-free.dev"` and repeated `GET /signup?`. In the browser, the form was not hydrated on the ngrok host but was hydrated on localhost. | Added `*.ngrok-free.dev` / `*.ngrok.dev`. Verified: the form hydrates over ngrok, and a login with an unknown email reached Supabase and showed "Incorrect email or password." |
| The signup page claimed "check your email" for a duplicate address and when Supabase returned a session immediately. | Code review of `signup/page.tsx`. | `interpretSignUp` handles duplicates (including Supabase's obfuscated response), redirects when a session is returned, and validates the email. Login shows clear invalid-credentials, unconfirmed-email and rate-limit messages. |

Account data is healthy: 1 auth user (confirmed, last sign-in 16 Oct), with
an owner profile and account. No missing profiles or memberships were found
and nothing was changed. Each new signup gets its own isolated workspace as
its owner (existing WACRM design, enforced by RLS); it never gains roles in
another workspace. Teammates join through invites, which assign the role
the inviter chose.

## 4. Templates

The Templates page (create/edit, header/body/footer, buttons, `{{n}}`
variables with samples, submit, status sync) already exists.
`WHATSAPP_TEMPLATES_DRY_RUN=true` in `.env.local` means submissions are
stored with a fake `dry-run-…` id and **never reach Meta**. The seed now
defines seven starter templates as local drafts. None is approved until
Meta says so.

## 5. Provider-side actions required (cannot be done from code)

1. Meta Business Settings → System Users → create/choose a system user →
   assign the app and the WhatsApp Business Account → **Generate token**
   with `whatsapp_business_messaging` + `whatsapp_business_management`.
   Paste it in *Settings → WhatsApp* and save.
2. App Dashboard → WhatsApp → Configuration → Webhook: callback URL
   `https://<public host>/api/whatsapp/webhook`, verify token =
   `WHATSAPP_VERIFY_TOKEN`; then under **Webhook fields** subscribe
   **messages**.
3. If the number is a production number: set a two-step verification PIN
   in WhatsApp Manager and save it once in *Settings → WhatsApp* so the
   number is registered with the Cloud API (then **Verify with Meta**).
4. While the Meta app is unpublished (development mode), only Meta test
   numbers / allowed recipients can be messaged; publishing requires Meta's
   app review. Do not assume production delivery until verified.
5. The ngrok URL changes whenever the free tunnel is recreated. Update the
   callback URL in step 2 each time, or deploy to a stable HTTPS domain.
6. Supabase → Authentication → URL Configuration: add the public origin(s)
   (ngrok and the production domain) under Redirect URLs, otherwise email
   confirmation links fall back to the Site URL.

## 6. Inbound delivery checklist

A green "registered" indicator only proves the number is on the Cloud API.
It does not prove Meta delivers messages to this app. Work down the list;
each line says where to check it. Status as of 17 Oct 2026, 17:15 IST.

| # | Check | Where | Status |
|---|---|---|---|
| 1 | Callback URL is exactly `https://guide-mushily-condense.ngrok-free.dev/api/whatsapp/webhook` | App Dashboard → WhatsApp → Configuration | Meta's verification GETs reached it at 15:39 and 15:41 (200) |
| 2 | Verify token matches `WHATSAPP_VERIFY_TOKEN` or the token saved in Settings | Same page | Matches (the GETs returned the challenge) |
| 3 | `META_APP_SECRET` is the app's real secret (App settings → Basic), then the dev server is restarted | `.env.local` | **Blocking: still the `local-dev-` placeholder.** Every signed POST would get 401. |
| 4 | **messages** field is subscribed | App Dashboard → WhatsApp → Configuration → Webhook fields | Not verifiable without the app secret; no POST has ever arrived |
| 5 | WABA is subscribed to the app | Graph `GET /{waba-id}/subscribed_apps` | Yes: "suraj solar" is subscribed |
| 6 | Phone Number ID in Settings is the number customers message | Settings → WhatsApp; WhatsApp Manager | `1308331805703843` = +1 555-675-6950 (Meta test number), CLOUD_API, CONNECTED |
| 7 | Token type, scopes and expiry | Automations → WhatsApp health → Check now | 18 Oct: the stored token is **expired** (Meta 190/463), so outbound replies fail. A replacement offered in chat is also a USER token (expires 18 Oct 20:30 IST). Save a System User token (§7). |
| 8 | App mode and recipient eligibility | App Dashboard header; WhatsApp → API Setup → "To" list | Development mode: the test number can only exchange messages with numbers added to its recipient list |
| 9 | Tunnel is up and forwards to port 3001 | `http://127.0.0.1:4040` | Up |
| 10 | Delivery evidence | ngrok inspector (POST lines); Automations → WhatsApp health ("Last webhook POST") | No POST from Meta seen yet |

Controlled test: once rows 3 and 4 are done, press **Test** next to the
`messages` field. A signed sample POST should appear in ngrok with status
200, and the health panel should show "accepted". Then send "Hi" from a
phone on the recipient list to +1 555-675-6950.

## 7. Access-token lifecycle

### How the CRM handles the token

- **Storage.** Settings → WhatsApp posts the token to `POST /api/whatsapp/config`
  (admins and owners only). The route verifies it with Meta, encrypts it with
  AES-GCM (`ENCRYPTION_KEY`) and stores it in `whatsapp_config.access_token`.
  The browser never receives it back.
- **Use.** Every sender (agent replies, automations, flows, broadcasts,
  templates, media, reactions, health checks) loads and decrypts the row on
  each request. Nothing caches it, so a newly saved token takes effect
  immediately, with no restart needed.
- **Save-time check.** On save the route calls Meta's read-only
  `debug_token`. The save still goes through, but a USER token or any
  token expiring within 7 days triggers a warning in the UI and a log line
  naming the type and expiry. The token itself is never logged.
- **Rejection.** When Meta answers code 190 (expired, subcode 463;
  invalidated, subcodes 460 and 467) or 102 during any send or check, the
  connection is set to `disconnected`. The Settings check shows Meta's
  explanation, and a sanitized warning is logged with the code only.
  Senders do not retry an auth error. A broadcast stops calling Meta at the
  first rejection. Saved broadcasts leave the remaining recipients
  **pending** so they can be resumed after a new token is saved; the
  one-shot send route reports them as failed with "Meta rejected the
  WhatsApp access token". A later successful Settings check switches the
  status back to `connected`.

### Getting the longest-lived token Meta offers

Meta can invalidate any token, including System User tokens: for example
when the app secret is reset, the system user loses access, an admin
revokes it, or Meta's security checks fire. No token can be guaranteed
never to expire. A System User token generated with the expiry set to
**Never** is the longest-lived option Meta offers.

1. Business Settings → Users → **System users** → Add. Use an Admin system
   user, or Employee if your policy requires it.
2. **Assign assets**: the app ("suraj solar", ID 1838903734229038) and the
   WhatsApp account (WABA `1107707258667828`) with full control.
3. **Generate new token** → select the app → token expiration **Never**
   (if your business only offers 60 days, choose that and set a reminder) →
   permissions `whatsapp_business_messaging` and `whatsapp_business_management`.
4. Copy it straight into Settings → WhatsApp → Access Token (Phone Number ID
   `1308331805703843`, WABA ID unchanged), then save. Do not paste it into
   chat, email, tickets or `.env` files.
5. Confirm: no "short-lived token" warning appears, and Automations →
   WhatsApp health → **Check now** shows a SYSTEM_USER token with "never
   expires" (or the expected date).

### Recovery when Meta invalidates the token

Symptoms: Settings shows the connection disconnected or "Error validating
access token", replies to customers stop, and the server log shows
`Meta rejected the access token (code 190/…)`. Inbound messages are still
received and saved during this time; only outbound sending stops.

1. In Business Settings → System users, open the system user, revoke the
   dead token if it is still listed, and generate a new one (step 3 above).
2. Save it in Settings → WhatsApp. The save verifies it with Meta before
   storing it.
3. Press **Test API connection**. The status returns to connected.
4. Open any broadcast left in "sending" and press **Resume** on its detail
   page. Only the pending recipients are sent. Check the audience first:
   resuming sends to real customers.
5. If a token was ever exposed (for example pasted into chat or a ticket),
   revoke it in the same screen even if it still works.
