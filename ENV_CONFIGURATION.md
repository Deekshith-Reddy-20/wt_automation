# Environment Configuration

The authoritative template is [`.env.local.example`](./.env.local.example) (committed, no secrets).
Copy it to `.env.local` for local work. `.gitignore` excludes every `.env*` file except the
example, and `.dockerignore` keeps them out of the Docker image.

> **Process environment wins over `.env.local`.** Next.js only fills variables that are not
> already set. If your shell (or CI) exports e.g. `NEXT_PUBLIC_SUPABASE_URL`, that value is used
> and `.env.local` is silently ignored for it. During setup a shell holding CI dummy values made
> the dev server talk to a non-existent Supabase. If the app behaves as if credentials are wrong,
> check `Get-ChildItem Env:` (PowerShell) / `env` (bash) first.

## Variables

| Variable | Required | Scope | Where to get it / how to generate |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | **Yes** | Build-time, browser + server | Supabase → Project Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **Yes** | Build-time, browser + server | Supabase → Project Settings → API → `anon` public key |
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes** | Runtime, **server only** | Supabase → Project Settings → API → `service_role`. Bypasses RLS — never expose to the browser, never prefix with `NEXT_PUBLIC_`. |
| `ENCRYPTION_KEY` | **Yes** | Runtime, server only | 64 hex chars (AES-256-GCM key for stored WhatsApp + AI credentials): `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Use a different key per environment; rotating it forces every account to re-save WhatsApp/AI settings. |
| `META_APP_SECRET` | **Yes** | Runtime, server only | Meta for Developers → your app → App settings → Basic → App secret. Verifies `X-Hub-Signature-256` on every webhook. Comma-separate several secrets only if your WABAs live under different Meta Apps (`docs/multi-waba.md`). Unset ⇒ webhook rejects everything (fail-closed). |
| `NEXT_PUBLIC_SITE_URL` | Recommended | Build-time | Canonical public URL, no trailing slash, e.g. `https://crm.surajsolar.com`. Pins invite links; used by background jobs. |
| `AUTOMATION_CRON_SECRET` | Required if using Wait steps / flows | Runtime | Long random string (`openssl rand -hex 32`). Sent as `x-cron-secret` to `/api/automations/cron` and `/api/flows/cron`; both return 503 while unset. |
| `WHATSAPP_VERIFY_TOKEN` | Optional | Runtime | Long random string. Meta webhook verification succeeds when Meta's verify token equals this **or** the token saved in *Settings → WhatsApp*. Server-only. |
| `WHATSAPP_TEST_RECIPIENT` | Optional | Runtime, server only | A number you own, international format (e.g. `+9198…`). The only recipient *Settings → WhatsApp → Send test message* will message (Meta's `hello_world` template, after a confirm dialog). Unset ⇒ the button is disabled. For a Meta test number it must also be in the app's allowed recipient list. |
| `META_APP_ID` | Optional | Runtime | Meta app → App settings → Basic → App ID. Only needed to submit templates with an **image header** (resumable upload). |
| `WHATSAPP_TEMPLATES_DRY_RUN` | Dev only | Runtime | `true` ⇒ template submission is stored locally with a fake `dry-run-…` id and never sent to Meta. **Unset in production.** |
| `ALLOWED_INVITE_HOSTS` | Optional | Runtime | Comma-separated hostnames allowed in invite links (defence in depth), e.g. `crm.surajsolar.com`. If no trusted host can be determined, the invite is refused (no fallback domain). |
| `WHATSAPP_CONFIG_CACHE_TTL_MS` | Optional | Runtime | Inbound webhook WhatsApp-config cache, default `30000`; `0` disables. |
| `WHATSAPP_INBOUND_CONTEXT_RPC` | Optional | Runtime | `0` skips the `resolve_inbound_context` function (migration 058). The code falls back automatically when it is missing. |
| `WHATSAPP_WEBHOOK_INBOX` | Optional | Runtime | `1` stores verified webhook payloads for retry by `/api/whatsapp/webhook/sweep`. Requires migration 056. Default off. |
| `AI_REQUEST_TIMEOUT_MS` | Optional | Runtime | Per-call AI provider timeout, default `30000`. |
| `AI_CONTEXT_MESSAGE_LIMIT` | Optional | Runtime | Recent messages sent as AI context, default `20`. |
| `AI_PROVIDER_ALLOWED_PRIVATE_HOSTS` | Optional | Runtime | Exact private hosts allowed for OpenAI-compatible providers (e.g. a self-hosted Ollama). Operator-only. |
| `ALLOWED_DEV_ORIGINS` | Dev only | Dev server | Extra tunnel hosts for `next dev` (ngrok etc. are already allowed). |
| `PORT` / `HOST_PORT` | Optional | Runtime / Compose | `PORT` = listen port (Compose pins 3000 inside the container); `HOST_PORT` = published host port. |

**There are no global AI keys.** OpenAI / Anthropic / embeddings keys are entered per account in
*Settings → AI Assistant* and stored encrypted with `ENCRYPTION_KEY`.

**WhatsApp credentials are not env vars either.** Phone Number ID, WABA ID, access token, verify
token and optional 2-step PIN are entered in *Settings → WhatsApp* by an owner/admin and stored
encrypted per account. See `META_WHATSAPP_SETUP.md`.

## Build-time vs runtime

`NEXT_PUBLIC_*` values are inlined into the JavaScript bundle by `next build` (and passed as
Docker build args by `docker-compose.yml`). Changing them requires a rebuild. All other variables
are read at runtime and must **not** be baked into images.

## Current local development file

`.env.local` (not committed) was generated on 2026-10-17 with:

| Variable | Value source |
|---|---|
| Supabase URL / anon / service-role | The hosted Suraj Solar Supabase project (switched from the local CLI stack). Migration 055 is **not** applied there yet. |
| `ENCRYPTION_KEY` | Freshly generated 32 random bytes |
| `META_APP_SECRET` | Set (value not inspected). Must be the real App Secret of the Meta app that owns the webhook, or every signed POST from Meta is rejected with 401. |
| `AUTOMATION_CRON_SECRET` | Freshly generated |
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:3001` (port 3000 on this PC is used by another app) |
| `WHATSAPP_TEMPLATES_DRY_RUN` | `true` |

## Per-environment checklist

| | Local | Staging | Production |
|---|---|---|---|
| Supabase project | CLI stack | Separate dev project | Separate prod project |
| `ENCRYPTION_KEY` | own | own | own (store in a secrets manager; back it up — losing it orphans every stored token) |
| `META_APP_SECRET` | placeholder | real (test app or prod app) | real |
| `WHATSAPP_TEMPLATES_DRY_RUN` | `true` | `true` until approved | unset |
| `AUTOMATION_CRON_SECRET` | own | own | own |
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:3001` | staging HTTPS URL | `https://crm.surajsolar.com` (example) |
