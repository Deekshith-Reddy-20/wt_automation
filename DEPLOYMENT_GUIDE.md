# Production Deployment Guide (provider-independent)

Nothing has been deployed, purchased or exposed publicly. This guide prepares a later deployment
to any Node.js host (VPS, Hostinger Managed Node.js, Railway, Render, Fly.io, Vercel, Kubernetes…)
or any container platform.

## 1. Architecture

```
WhatsApp user ⇄ Meta Cloud API ──HTTPS webhook──▶ CRM (Next.js 16, Node 22) ──▶ Supabase (Postgres/Auth/Storage/Realtime)
                                ◀──Graph API v21.0──       ▲   ▲
Team browsers ──HTTPS──────────────────────────────────────┘   └── Scheduler (every minute): /api/automations/cron, /api/flows/cron
```

Stateless app tier; all state in Supabase. One process serves UI, REST API, public API and webhook.

## 2. Prerequisites checklist

| Item | Status |
|---|---|
| Production Supabase project, migrations applied, auth URLs set (`SUPABASE_SETUP.md`) | ☐ |
| Domain, e.g. `crm.surajsolar.com`, DNS pointing at the host | ☐ |
| **HTTPS** with a valid certificate (Meta refuses non-HTTPS webhooks; self-signed rejected) | ☐ |
| Env vars set in the host's secret store (`ENV_CONFIGURATION.md`) | ☐ |
| Meta app + system-user token + webhook (`META_WHATSAPP_SETUP.md`) | ☐ |
| External scheduler for cron endpoints | ☐ |
| Backups + restore test | ☐ |
| Graph API version bumped from v21.0 before 2027-01-21 | ☐ |

## 3. Option A — Node.js host (no Docker)

```bash
node -v            # 22.x LTS (engines: >=22.12). Matches the Dockerfile's node:22-alpine.
npm ci
# set NEXT_PUBLIC_* in the build environment — they are inlined at build time
npm run build
npm start          # next start, listens on $PORT (default 3000)
```

`output: "standalone"` is enabled, so you can also run `node .next/standalone/server.js` after
copying `.next/static` → `.next/standalone/.next/static` and `public` → `.next/standalone/public`
(that is exactly what the Dockerfile does).

Put a reverse proxy (Caddy / nginx / platform edge) in front for TLS. Forward `Host` and
`X-Forwarded-*` headers.

## 4. Option B — Docker / Compose (validated locally)

```bash
cp .env.local.example .env.local     # fill with PRODUCTION values on the server only
docker compose --env-file .env.local up --build -d
docker compose ps                    # STATUS should show (healthy)
```

Validated on 2026-10-17: multi-stage build succeeds, final image ~369 MB, runs as non-root
`nextjs`, Compose healthcheck reports *healthy*, no `.env*` file inside the image, server secrets
supplied only at runtime, and the full smoke suite (80/80) passes against the container.

Build-time args: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`NEXT_PUBLIC_SITE_URL`. Changing them requires `--build`.

## 5. Scheduled jobs (required for Wait steps, follow-up reminders, flow timeouts)

Nothing inside the app schedules itself. Call both endpoints **every minute** with the secret:

```bash
curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://crm.surajsolar.com/api/automations/cron
curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://crm.surajsolar.com/api/flows/cron
```

Use host cron, a platform scheduler, GitHub Actions `schedule`, or an uptime pinger that supports
headers. Responses: `200 {"processed":n,…}` OK · `401` wrong secret · `503` secret not configured.
Each call drains up to 50 due jobs and requeues stalled ones; overlapping calls are safe (rows are
claimed before processing).

## 6. Health checks & monitoring

| Check | Expectation |
|---|---|
| `GET /` | any status < 500 — this is what the Compose healthcheck uses (redirects to `/login`) |
| `GET /login` | 200 — good uptime-monitor target |
| `GET /api/automations/cron` with secret | 200 — proves DB connectivity + service-role key |
| `GET /api/whatsapp/webhook` (no params) | 400 — route alive |
| Meta → App → WhatsApp → Webhooks | delivery failures appear here (401 = `META_APP_SECRET` mismatch) |

There is no dedicated `/health` endpoint; the above are sufficient. Add uptime monitoring on
`/login` and alerting on the cron call failing.

## 7. Logging

The app logs to stdout/stderr (`console.*`) with prefixes such as `[webhook]`, `[automations]`,
`[whatsapp/config GET]`. Capture container/process logs with your platform and retain ≥ 14 days.
Logs never print tokens; Meta failures include code + `fbtrace_id` for support. Business-level
history lives in the DB: `automation_logs`, `flow_run_events`, `ai_usage_log`, message `error_*`
columns, `notifications`.

## 8. Production security settings

- HTTPS only; HSTS is already sent (`next.config.ts`).
- Security headers already enforced: `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`,
  `Permissions-Policy`. CSP ships **report-only** — after a clean soak, switch the header key to
  `Content-Security-Policy`. If Supabase is self-hosted on a custom domain, add it to
  `connect-src`/`media-src` first (current CSP allows only `*.supabase.co`).
- Set `NEXT_PUBLIC_SITE_URL` (and optionally `ALLOWED_INVITE_HOSTS`) to pin invite links.
- Unset `WHATSAPP_TEMPLATES_DRY_RUN`.
- Keep Supabase "Confirm email" on; disable public sign-up after the team is onboarded if desired
  (Supabase → Authentication → Providers → Email → disable sign-ups) — teammates join via invites.
- **Rate limiting is in-memory per process** (`src/lib/rate-limit.ts`): fine for a single
  instance; if you run several replicas, swap in Redis/Upstash as described in that file.
- Rotate the Meta system-user token and API keys if a laptop/admin leaves; revoke API keys in
  *Settings → API keys*.
- `npm audit`: 9 "high" findings, all in one dev-tooling chain (`braces` via `fast-glob` via the
  `shadcn` CLI / `eslint-config-next`). No patched `braces` exists yet and these packages are not
  part of the standalone runtime bundle. Re-check monthly (`npm audit`), and follow upstream
  security releases (`git fetch upstream`).

## 9. Release procedure

1. `npm ci && npm run lint && npm run typecheck && npm test && npm run build`
2. `npx supabase db push` against **staging** first (new migrations only; non-destructive).
3. Deploy app to staging → `SMOKE_ALLOW_REMOTE=1 SMOKE_BASE_URL=https://staging… node scripts/smoke-test.mjs`
   (creates `*@smoke.surajsolar.test` users — use only on staging).
4. Repeat 2–3 for production (skip the smoke script there; do the manual go-live checks).
5. Pulling upstream fixes: `git remote add upstream https://github.com/ArnasDon/wacrm.git`,
   `git fetch upstream && git merge upstream/main` on a branch, re-run step 1.

## 10. Backup & recovery

See `SUPABASE_SETUP.md → Backups`. Minimum: daily DB dump off-site, weekly storage-bucket copy,
`ENCRYPTION_KEY` + env stored in a password manager/secret store, quarterly restore drill.
Recovery order: restore DB → restore buckets → set identical `ENCRYPTION_KEY` → deploy app →
re-point Meta webhook if the domain changed.
