# Supabase Setup

The CRM uses Supabase for Postgres, Auth, Storage, Realtime and RLS. Schema lives in
`supabase/migrations/` (53 idempotent files, `001`…`054`; `050` was intentionally renumbered to
`054` upstream, so the gap is expected).

## A. Local development stack (what is running now)

Requires Docker Desktop and the Supabase CLI (`npx supabase` works; v2.121 used).

```powershell
cd wacrm
npx supabase start -x edge-runtime,logflare,vector,supavisor   # first run pulls images (~10 min)
npx supabase status                                           # URLs + local demo keys
```

On a fresh volume `start` applies every migration in filename order. Verified 2026-10-17:
all 53 applied without error, and the repo's assertion script passes:

```powershell
npx supabase db query --local --file supabase/ci/verify-schema.sql
```

| Local service | URL |
|---|---|
| API (use as `NEXT_PUBLIC_SUPABASE_URL`) | http://127.0.0.1:54321 |
| Studio (DB browser) | http://127.0.0.1:54323 |
| Mailpit (captures auth emails) | http://127.0.0.1:54324 |
| Postgres | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` |

`npx supabase stop` keeps data; `npx supabase stop --no-backup` deletes it. `npx supabase db reset`
**wipes** the local DB and replays migrations — local only, never against a hosted project.

### Local demo data

```powershell
node scripts/seed-suraj-solar.mjs --owner-email admin@surajsolar.test --with-samples
```

Local login: the dev account you created in the local stack (keep its password outside Git). Smoke-test users
`*@smoke.surajsolar.test` also exist locally.

## B. New hosted development project (needs your Supabase account)

Not created during setup — it requires your account and is your decision (free tier is enough
for development).

1. supabase.com → New project. Region **Mumbai (ap-south-1)** for India latency; strong DB
   password stored in a password manager. Keep Postgres at the version `supabase/config.toml`
   expects (17) or update that file.
2. Apply migrations **in order** (non-destructive — every file is `IF NOT EXISTS`-guarded):
   ```powershell
   npx supabase login
   npx supabase link --project-ref <project-ref>
   npx supabase db push            # applies supabase/migrations/* in filename order
   ```
   Alternative: paste each file into *SQL Editor* in numeric order.
   **Never** run `db reset` or hand-written `DROP` statements against a project that holds data
   without a backup and explicit approval.
3. Verify: run `supabase/ci/verify-schema.sql` in the SQL editor → `schema verification passed`.
4. *Authentication → URL Configuration* (see [`docs/auth-emails.md`](./docs/auth-emails.md)):
   - Site URL: your app origin (e.g. `https://crm.surajsolar.com`)
   - Redirect URLs: `https://crm.surajsolar.com/**` plus `http://localhost:3001/**` for dev.
   Without this, confirmation/reset emails link to `localhost:3000`.
5. *Authentication → Providers → Email*: keep "Confirm email" on for production. Configure custom
   SMTP (Supabase's built-in mailer is rate-limited) under *Authentication → SMTP*.
6. *Project Settings → API*: copy URL, `anon`, `service_role` into the environment
   (`ENV_CONFIGURATION.md`). The service-role key is used only in server code
   (`src/lib/**/admin-client.ts`, webhook, cron, public-API auth) — verified that no
   `NEXT_PUBLIC_` variable carries it.
7. Seed configuration (no samples) for the owner after they sign up:
   ```powershell
   node scripts/seed-suraj-solar.mjs --owner-email owner@surajsolar.com
   ```

## What the migrations create

| Area | Objects |
|---|---|
| Tables | 37 in `public`, **all with RLS enabled** |
| Tenancy | `accounts`, `profiles.account_id` + `account_role` (owner/admin/agent/viewer), `is_account_member()` used by policies |
| Signup provisioning | `handle_new_user()` trigger on `auth.users` → profile + personal account (owner). Verified. |
| Service-only tables | `automation_pending_executions`, `pending_message_statuses` — RLS on, no policies (server writes via service role) |
| Storage buckets | `avatars` (2 MB), `chat-media` (16 MB), `flow-media` (16 MB) — public read by URL; listing restricted to account members (043) |
| Realtime publication | `conversations`, `messages`, `message_reactions`, `notifications`, `member_presence`, `flow_runs` |
| Extensions | `pgcrypto`, `uuid-ossp`, `vector` (pgvector 0.8, for AI knowledge base) |
| Internal SECURITY DEFINER functions | Execute revoked from `anon`/`authenticated` (044, asserted by verify-schema) |
| Key indexes | per-table `account_id` indexes, unique `(conversation_id, message_id)` for webhook idempotency, unique phone / BSUID per account (022, 040), partial index for due automation jobs |

## Security checks performed

- RLS on every public table; no policy with a literal `true` qual/check remains (the permissive
  `messages` insert policy from 001 was replaced in later migrations).
- `whatsapp_config` writes require admin (`is_account_member(account_id,'admin')`); reads are
  member-level but the token column is AES-256-GCM ciphertext.
- Cross-tenant test: a user from another account read **zero** rows from contacts,
  conversations, messages, automations, pipelines, deals, whatsapp_config, api_keys,
  custom_fields. Anonymous client reads nothing.

## Privacy recommendation — media buckets

`chat-media` is a *public* bucket: inbound customer files (electricity-bill photos contain
name, address and consumer number) are served to anyone who holds the URL. Paths include the
random account UUID, so they are not guessable, but a forwarded link stays valid. For stricter
privacy, convert the bucket to private and serve signed URLs (code change across the media
proxy/inbox — not done in this setup).

## Backups

- Hosted free tier: no point-in-time recovery. Pro: daily backups (7 days); PITR is an add-on.
- Independently schedule `npx supabase db dump --linked -f backup-$(date).sql` (schema) and
  `--data-only` dumps to off-site storage; storage buckets are **not** included in DB dumps —
  copy them via the S3-compatible API.
- Store `ENCRYPTION_KEY` alongside backups (separately secured): a restored DB without it cannot
  decrypt WhatsApp/AI tokens.
- Test a restore into a scratch project before go-live.
