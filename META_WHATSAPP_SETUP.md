# Meta WhatsApp Cloud API — Direct Connection Guide

The CRM talks **directly** to Meta's official WhatsApp Cloud API (`graph.facebook.com`). There is
no AiSensy / WATI / other BSP in the path, and no per-message fee other than Meta's own
conversation pricing.

**Status: live messaging is NOT yet tested** — no real Meta credentials were available during
setup. Everything up to the Meta boundary (webhook signature verification, verify handshake,
inbound processing, idempotency, status updates, templates in dry-run) was validated with
self-signed mock payloads. Treat the first live connection as a test (see *Go-live test plan*).

## 1. What you need from Meta (credential checklist)

| # | Item | Where | Goes into |
|---|---|---|---|
| 1 | Meta Business Portfolio (verified, for production limits) | business.facebook.com → Settings → Business info | — |
| 2 | Meta App (type **Business**) with the **WhatsApp** product added | developers.facebook.com → My Apps | — |
| 3 | **App ID** | App → App settings → Basic | env `META_APP_ID` (only for image-header templates) |
| 4 | **App Secret** | App → App settings → Basic → Show | env `META_APP_SECRET` |
| 5 | **WhatsApp Business Account (WABA) ID** | App → WhatsApp → API Setup, or Business Settings → Accounts → WhatsApp accounts | CRM *Settings → WhatsApp* |
| 6 | **Phone Number ID** (numeric id, *not* the phone number) | App → WhatsApp → API Setup | CRM *Settings → WhatsApp* |
| 7 | **Permanent access token** from a **System User** | Business Settings → Users → System users → Add (Admin) → Assign assets: the app + the WABA (full control) → Generate token, expiry *Never*, permissions `whatsapp_business_messaging`, `whatsapp_business_management` (add `business_management` if template media upload is needed) | CRM *Settings → WhatsApp* |
| 8 | **Verify token** — any random string you invent | e.g. `openssl rand -hex 16` | Both Meta webhook config **and** CRM *Settings → WhatsApp* |
| 9 | **Two-step verification PIN** of the number (production numbers) | Business Settings → WhatsApp accounts → Phone numbers → Two-step verification | CRM *Settings → WhatsApp* (only needed to register the number) |
| 10 | Public **HTTPS** URL for the CRM | your hosting | Meta webhook callback |
| 11 | A payment method on the WABA | Business Settings → WhatsApp accounts → Payment settings | — (needed for business-initiated conversations beyond free tier) |

Do **not** use the 24-hour temporary token from the API Setup page in production — it expires
and the CRM will show `Meta error code 190`.

## 2. Configure the server

```env
META_APP_SECRET=<App Secret from step 4>
META_APP_ID=<App ID from step 3>     # optional
# WHATSAPP_TEMPLATES_DRY_RUN must be UNSET in production
```

Restart/redeploy after changing env vars. Without `META_APP_SECRET` the webhook rejects every
request (fail-closed, by design).

## 3. Connect the number in the CRM

1. Sign in as the account **owner/admin** → *Settings → WhatsApp*.
2. Enter **Phone Number ID**, **WABA ID**, **Access token**, **Verify token**, and the **PIN**
   (production numbers only; Meta test numbers have no PIN — leave blank).
3. Click **Save Configuration**. The server calls Meta in this order and stops on the first
   failure, explaining the cause, Meta error code and trace id
   (full table in [`docs/whatsapp-connection-troubleshooting.md`](./docs/whatsapp-connection-troubleshooting.md)):
   `GET /{phone_number_id}` → `GET /{waba_id}/phone_numbers` → `POST /{phone_number_id}/register`
   (if PIN given) → `POST /{waba_id}/subscribed_apps`.
4. Tokens are stored AES-256-GCM encrypted with `ENCRYPTION_KEY`. Only owner/admin can change
   them (enforced by API and RLS; verified by the smoke test: viewer → 403).

## 4. Configure the webhook in Meta

App → WhatsApp → **Configuration** → Webhook → Edit:

| Field | Value |
|---|---|
| Callback URL | `https://<your-crm-host>/api/whatsapp/webhook` |
| Verify token | exactly the verify token saved in step 3, **or** the server's `WHATSAPP_VERIFY_TOKEN` |

Click **Verify and save** — Meta sends `GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`;
the CRM echoes the challenge (plain text, 200) only when the token matches `WHATSAPP_VERIFY_TOKEN`
or a stored (encrypted) verify token; anything else gets 403.

Troubleshooting "The callback URL or verify token couldn't be validated":
- Check the ngrok inspector (`http://127.0.0.1:4040`) or server logs for the GET. **403** means
  the token differs — copy it again with no extra spaces. **No request** means the URL or tunnel
  is wrong; the tunnel must forward to the port Next.js is listening on.
- A free ngrok URL changes each time ngrok restarts — update the callback URL in Meta.
- Verification only proves the URL. Incoming events are POSTs signed with the App Secret, so
  `META_APP_SECRET` must be the **real** App Secret or every event is rejected with 401.

Then **Webhook fields → Manage** and subscribe:

| Field | Why |
|---|---|
| `messages` | **Required** — inbound messages *and* sent/delivered/read/failed statuses |
| `message_template_status_update` | Template approved / rejected / paused |
| `message_template_quality_update` | Template quality score |
| `message_template_components_update` | Meta modified a template |

Every POST must carry `X-Hub-Signature-256`, verified with HMAC-SHA256 over the raw body in
constant time against `META_APP_SECRET`. Payloads over the size cap are rejected (413). The
handler acknowledges within Meta's timeout and processes in `after()`; replays of the same
`message.id` are ignored via a unique index (idempotent).

## 5. Message templates (required for business-initiated messages)

Outside the 24-hour customer-service window you may only send **approved templates**. The seed
script created three DRAFT templates (never submitted):

| Template | Category | Purpose |
|---|---|---|
| `solar_quotation_followup` | Marketing | Used by the *Quotation follow-up reminder* automation |
| `solar_site_survey_reminder` | Utility | Survey appointment reminder (`{{1}}` = date/time) |
| `solar_enquiry_reengage` | Marketing | Broadcast re-engagement with opt-out footer |

To submit: unset `WHATSAPP_TEMPLATES_DRY_RUN`, open the template, review the wording, and submit.
Status changes arrive by webhook. Meta may re-categorise templates; Marketing templates need
recipient **opt-in**.

## 6. Compliance rules the team must follow

- **Opt-in:** only message people who gave WhatsApp opt-in (enquiry form checkbox, they messaged
  you first, etc.). Record the source in the *Lead source* field. Honour STOP/opt-out
  immediately (tag *Do Not Follow Up*; remove from broadcast audiences).
- **24-hour window:** free-form replies (inbox, `send_message`, buttons/lists) only within 24 h
  of the customer's last message. The seeded follow-up automation therefore uses a template.
- **Rate & tier limits:** new numbers start at a limited number of business-initiated
  conversations per 24 h; the tier rises with quality. The CRM throttles broadcasts and limits
  `/api/whatsapp/send` and `/broadcast` to 60 requests/min per user, but Meta's tier is the
  binding constraint — keep early broadcasts small.
- **Quality:** watch template quality (GREEN/YELLOW/RED) in the templates list; low quality
  pauses templates and can lower your tier.
- **Display name & content:** the display name must be approved by Meta and match Suraj Solar's
  branding; avoid promising specific subsidy amounts in templates.

## 7. Go-live test plan (needs real credentials)

Use a Meta **test number** first, with your own phone as the only recipient.

1. Save configuration → expect success, *Registration status* registered/subscribed.
2. *Test API Connection* → number verified, WABA subscribed to app.
3. Meta → Configuration → Verify webhook → succeeds.
4. Send "Hi" from your phone → conversation appears in Inbox in real time.
5. Reply from Inbox → received on phone; ticks progress sent → delivered → read.
6. Send an image both ways → displays; inbound copy stored in `chat-media`.
7. Submit `solar_site_survey_reminder` → becomes APPROVED via webhook.
8. Activate *New WhatsApp enquiry* only → message the number from a fresh phone → buttons arrive;
   tap *Residential* (with *Residential enquiry* active) → bill list arrives; pick a range →
   custom field filled. Check *Automations → Logs*.
9. Broadcast the approved template to a 1–2 person tag audience → delivery/read counts update.
10. Only then add teammates and enable more automations.

## 8. Known issue: Graph API version

`src/lib/whatsapp/meta-api.ts` pins `META_API_VERSION = 'v21.0'`. A third-party tracker
(harbyn.com) lists v21.0 as retiring on **2027-01-21**; confirm on Meta's
[Graph API changelog](https://developers.facebook.com/docs/graph-api/changelog). Before that date,
bump the constant to a current version (e.g. v24.0) on a branch and re-run the go-live test plan;
check upstream WACRM for a release that already did this.
