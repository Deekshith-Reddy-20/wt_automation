# Test Report — 2026-10-17

Environment: Windows 11, Node 24.18.0, npm 12.0.2, Docker 29.7.2, Supabase CLI 2.121 (Postgres 17,
local stack). App on `http://localhost:3001` (dev) and `http://localhost:3002` (Docker image).
All results below were actually executed; nothing is extrapolated.

## 1. Repository quality gates

| Command | Upstream `f6a9a12` (before changes) | Branch `suraj-solar/customization` (after) |
|---|---|---|
| `npm ci` | ✅ 685 packages | ✅ |
| `npm run lint` | ✅ 0 errors, 40 warnings (pre-existing) | ✅ 0 errors, 40 warnings (unchanged) |
| `npm run typecheck` | ✅ | ✅ |
| `npm test` | ✅ 126 files / 1,436 tests | ✅ **127 files / 1,444 tests** (+8 new) |
| `npm run build` | ✅ (CI dummy env) | ✅ (real local env) |
| `mcp-server`: `npm ci && npm run build` | — | ✅ 0 vulnerabilities |
| `docker compose up --build` | — | ✅ image built, container *healthy* |

Notes
- First upstream build attempt failed at prerender (`@supabase/ssr: URL and API key are
  required`) only because the env vars were not visible to that shell — **harness error, not a
  code defect**; the rerun with env passed.
- npm 12 printed "install scripts blocked" for `@swc/core`, `unrs-resolver`, `@parcel/watcher`;
  lint/typecheck/build all work regardless (prebuilt optional binaries are used). Production and
  CI use Node 22 + npm 10 (`packageManager: npm@10.9.9`).

## 2. Database

| Check | Result |
|---|---|
| 53 migrations applied in order on a clean Postgres 17 | ✅ |
| `supabase/ci/verify-schema.sql` (upstream assertions) | ✅ passed |
| RLS enabled on all 37 public tables | ✅ |
| No permissive (`true`) policies remain | ✅ |
| Storage buckets `avatars`, `chat-media`, `flow-media` | ✅ present |
| Realtime publication (6 tables) | ✅ |

## 3. End-to-end smoke test (`scripts/smoke-test.mjs`)

80 checks; **80/80 passed on `next dev`** and **80/80 passed against the Docker image**.

| Group | Checks | Result |
|---|---|---|
| Unauthenticated: `/login` 200; 10 protected pages → `/login`; send API 401; public API without/bogus key 401 | 15 | ✅ |
| Cron: no secret 401, wrong secret 401, correct secret 200 (automations + flows) | 4 | ✅ |
| Webhook security: no params 400, wrong verify token 403, unsigned POST 401, forged signature 401 | 4 | ✅ |
| Provisioning: signup trigger creates profile + owner account; password login; logged-in `/login` → `/dashboard` | 3 | ✅ |
| Authenticated pages: dashboard, inbox, contacts, pipelines, broadcasts, broadcasts/new, automations, automations/new, flows, agents, notifications, settings | 12 | ✅ all 200 |
| Authenticated APIs: account, members, invitations, api-keys, automations, flows, flow templates, quick-replies, ai/config, ai/usage, ai/knowledge, whatsapp/config | 12 | ✅ all 200 |
| Team & RBAC: invite link → viewer joins; viewer reads contacts; viewer **403** on API-key mint, invitations, WhatsApp config | 5 | ✅ |
| Public API keys: mint (one-time plaintext), `/v1/me`, create + list contacts, missing scope → 403, revoked → 401 | 6 | ✅ |
| RLS: other tenant sees 0 rows in 9 tables; anonymous sees nothing | 2 | ✅ |
| Webhook pipeline (self-signed, mock config): verify handshake echoes challenge; inbound text → contact + conversation + message; **replay stored once**; status update accepted; inbox renders | 6 | ✅ |
| Suraj Solar seed: catalogue present (11 fields, 12 tags, 8-stage pipeline, 9 inactive automations) | 1 | ✅ |
| All 9 seeded automations pass the app's activation validator (activated then deactivated via API) | 9 | ✅ |
| Engine run: tagging "Hot Lead" fires *Sales agent assignment* → log `success`, conversation assigned, Lead priority = High | 1 | ✅ |

Reproduce:

```powershell
$env:SMOKE_BASE_URL='http://localhost:3001'
$env:SMOKE_SOLAR_EMAIL='<local dev account email>'; $env:SMOKE_SOLAR_PASSWORD='<local dev account password>'
node scripts/smoke-test.mjs
```

## 4. Other validations

| Item | Result |
|---|---|
| Seed script idempotency (second run) | ✅ "nothing new — already seeded" |
| MCP server over stdio against local CRM (scoped read-only key) | ✅ initialize, 7 read tools listed, `list_contacts` returned seeded contacts; key revoked afterwards |
| Service-role key absent from client code and built browser chunks | ✅ |
| No AiSensy / WATI / other BSP code or dependency | ✅ |
| `.env.local` git-ignored; no `.env*` in Docker image | ✅ |

## 5. Regression tests added

`src/lib/automations/assign.test.ts` (8 tests) for the round-robin fix: never assigns viewers,
least-loaded selection, deterministic ties, even spread over 6 assignments, sticky existing
assignee, reassignment when assignee is ineligible, ignores unknown ids, null when nobody eligible.
`scripts/smoke-test.mjs` is a reusable end-to-end regression suite.

## 6. Not tested (and why)

| Area | Reason |
|---|---|
| Live Meta: connect number, outbound text/media/template, real delivery/read receipts, template approval | No Meta credentials. **Live messaging is not claimed to work.** |
| AI providers (OpenAI/Anthropic) drafts, auto-reply, embeddings | No API keys |
| Browser UI interaction (drag-and-drop Kanban, builder canvas, realtime updates, CSV upload dialog) | No browser-automation tool in this environment; pages verified at HTTP level (server render 200) and by unit tests |
| Broadcast send / campaign reporting with real recipients | Needs Meta |
| Auth emails (confirmation / reset links) | Local Mailpit only; hosted SMTP not configured |
| Multi-instance rate limiting | Single instance only |

## 7. Disclosure — outbound calls during testing

No WhatsApp message was sent. However, `GET /api/whatsapp/config` verifies a stored number with
Meta whenever one exists, so after the smoke test seeded a **fake** WhatsApp config for the test
account, later runs made read-only `GET graph.facebook.com/v21.0/<fake id>` calls with a fake
token (Meta rejects these). All sample contacts use non-routable `+91 55555…` numbers, and every
seeded automation is inactive.
