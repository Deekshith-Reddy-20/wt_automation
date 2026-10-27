# Module Status — Suraj Solar CRM (WACRM fork)

Baseline: `ArnasDon/wacrm` `main` @ `f6a9a1211e28efaa37c5ca7e75fdc0ccdfbb1ba0` (v0.8.0, 2026-10-16).
Working branch: `suraj-solar/customization`. Validated 2026-10-17 against a local Supabase stack
(Supabase CLI 2.121, Postgres 17) with mock Meta credentials.

## Legend

| Status | Meaning |
|---|---|
| **Validated** | Code located, migrations applied, routes/UI load, and exercised by an automated check (unit tests and/or `scripts/smoke-test.mjs`). |
| **Installed** | Code + schema present, page/API loads, unit tests pass — but the end-to-end behaviour needs an external service (Meta, OpenAI/Anthropic) that was not available. |
| **Needs credentials** | Cannot work until a real external credential is configured. |
| **Not implemented** | Requested/documented, but absent from the code. |

"Unit tests" = the upstream Vitest suite (127 files / 1,444 tests, all passing).
"Smoke" = `scripts/smoke-test.mjs` (80/80 checks passing on both `next dev` and the Docker image).

## CRM

| Feature | Implementation | Schema | Status | Evidence |
|---|---|---|---|---|
| Contacts | `src/app/(dashboard)/contacts`, `src/components/contacts`, `/api/v1/contacts` | 001, 017, 022 | **Validated** | Smoke: page 200, API create/list, RLS isolation |
| Contact tags | `/api/contacts/[id]/tags`, `src/lib/contacts/tag-*.ts` | 001, 025 | **Validated** | Smoke: tag add via API fires `tag_added` automation |
| Custom fields | `src/components/contacts/custom-fields-manager.tsx` | 001 | **Validated** | 11 solar fields seeded; engine writes `custom:<id>` values (smoke) |
| CSV import / export | `src/components/contacts/import-*`, `src/lib/contacts` | — | **Installed** | Unit tests (CSV parsing, phone normalisation); UI not driven by a browser |
| Duplicate detection | `src/lib/contacts/dedupe.ts` | 022, 036, 040 | **Validated** | Unit tests + unique indexes verified; webhook replay creates no duplicate |
| Search & filtering | contacts page, `filter_contacts_by_tags` RPC | 025 | **Installed** | Unit tests; RPC present |
| Conversation history | contact sidebar / inbox | 001 | **Validated** | Smoke: inbound message stored and linked to contact |

## WhatsApp

| Feature | Implementation | Schema | Status | Evidence |
|---|---|---|---|---|
| Meta Cloud API connection | `/api/whatsapp/config`, `src/lib/whatsapp/meta-api.ts` (Graph **v21.0**) | 001, 013, 015 | **Needs credentials** | Save/verify path calls Meta; not testable without a WABA. ⚠ v21.0 retires 2027-01-21 (see SETUP_REPORT) |
| Inbound messages (webhook) | `/api/whatsapp/webhook` | 037, 039, 054 | **Validated (simulated)** | Smoke: HMAC-signed payload → contact + conversation + message; replay idempotent |
| Webhook signature validation | `src/lib/whatsapp/webhook-signature.ts` | — | **Validated** | Smoke: unsigned/forged → 401; fail-closed if `META_APP_SECRET` unset (unit) |
| Webhook verify handshake | webhook `GET` | — | **Validated** | Smoke: correct token echoes challenge, wrong token 403 |
| Outbound messages | `/api/whatsapp/send`, `/api/v1/messages` | 001, 023 | **Needs credentials** | Auth + rate limit validated (401 unauthenticated); live send untested |
| Shared team inbox | `src/app/(dashboard)/inbox` | 017, 024 | **Validated** | Smoke: page 200 for owner + viewer; realtime not browser-tested |
| Text & media messages | send route, `chat-media` bucket, media proxy | 023, 039, 043 | **Installed** | Buckets + scoped storage policies verified; media needs Meta |
| Conversation status / assignment / notes | inbox components, `contact_notes` | 001, 002 | **Validated** | Engine assignment validated (smoke); notes seeded |
| Message templates | `/api/whatsapp/templates/*`, `template-validators.ts` | 014 | **Installed** | 3 DRAFT solar templates seeded; dry-run mode on; Meta submission needs credentials |
| Delivery / read tracking | `message-status-sync.ts`, status webhook | 042, 054 | **Validated (simulated)** | Smoke: signed status payload accepted; forward-only logic unit-tested |
| Conversation filtering | inbox filters | 025 | **Installed** | Unit tests |

## Marketing

| Feature | Status | Notes |
|---|---|---|
| Broadcast campaigns | **Installed / needs credentials** | `/api/whatsapp/broadcast`, resume route, rate limit 60/min. Live send untested. |
| Approved templates only | **Installed** | Broadcast wizard selects templates; Meta approval required. |
| Recipient selection (all / tags / CSV / custom field) | **Installed** | Unit tests for audience + CSV + pagination. |
| Template variables | **Installed** | Positional `{{n}}`; per-recipient params (049). |
| **Campaign scheduling** | **Not implemented** | The wizard's "Schedule & Send" step only offers *Send now* (upstream removed the schedule stub). Needs development — see SETUP_REPORT. |
| Delivery tracking & reporting | **Installed** | Aggregate trigger on `broadcast_recipients` (005, 037); `/broadcasts/[id]` page. |

## Automation

| Feature | Status | Evidence |
|---|---|---|
| Visual builder | **Validated** | `/automations/new` 200; seeded workflows use builder row format |
| Triggers: keyword, new contact, first inbound, incoming message, tag added, interactive reply, time-based | **Validated** (keyword/tag/first-inbound configs pass activation validator; tag_added executed end-to-end) | Smoke |
| Condition branches | **Validated** | Unit tests; seeded follow-up workflow uses tag_presence branch |
| Wait / delay | **Installed** | Requires external scheduler calling `/api/automations/cron` (cron auth validated) |
| Contact tagging / field updates / create deal | **Validated** | Smoke engine run |
| Outbound webhooks (`send_webhook`) | **Installed** | SSRF guard unit-tested (`src/lib/webhooks/ssrf.ts`) |
| Execution history | **Validated** | `automation_logs` row written with step results (smoke) |
| Error handling & retries | **Installed** | Failed steps logged; stalled executions requeued by cron; atomic counters (007/051) |
| **Round-robin agent assignment** | **Fixed + Validated** | Was picking an arbitrary single profile (could be a viewer). Now least-loaded eligible agent, sticky per lead (`src/lib/automations/assign.ts`, 8 new tests). |
| Flows (chatbot menus) | **Installed** | `/flows` 200, flows cron 200 |

## Sales

| Feature | Status | Evidence |
|---|---|---|
| Pipelines / Kanban | **Validated** | `/pipelines` 200; "Solar Sales" pipeline with 8 stages seeded |
| Lead stages | **Validated** | New Lead → Contacted → Qualified → Site Survey → Quotation Sent → Negotiation → Won / Lost |
| Deal assignment | **Installed** | `deals.assigned_to` (002); sample deals assigned |
| Pipeline analytics | **Installed** | Dashboard pipeline-value chart |
| Deal ↔ conversation linking | **Validated** | Sample deals carry `conversation_id`; `create_deal` step links automatically |

## AI

| Feature | Status | Notes |
|---|---|---|
| OpenAI / Anthropic / OpenAI-compatible | **Needs credentials** | Bring-your-own key per account, AES-256-GCM encrypted (029, 046). Config API 200. |
| Reply assistant (draft) | **Needs credentials** | `/api/ai/draft` |
| Auto-reply bot + cap | **Needs credentials** | Off by default; per-conversation cap (031/053) |
| Knowledge base | **Installed** | FTS works without a key; pgvector semantic search needs an embeddings key. `/api/ai/knowledge` 200 |
| Human handoff | **Installed** | `src/lib/ai/handoff.ts` (unit-tested) |
| Usage controls & logging | **Validated** | `/api/ai/usage` 200, `ai_usage_log` table |
| Error handling | **Installed** | Timeouts (`AI_REQUEST_TIMEOUT_MS`), private-host SSRF block (unit-tested) |

## Administration

| Feature | Status | Evidence |
|---|---|---|
| Registration / login / password reset | **Validated** | Signup trigger creates profile + account; password login; auth pages 200 |
| Account settings / profile | **Validated** | `/settings`, `/api/account` 200 |
| Team invitations | **Validated** | Smoke: owner invites, viewer redeems link |
| Roles owner/admin/agent/viewer | **Validated** | Smoke: viewer gets 403 on API keys, invitations, WhatsApp config |
| API key management | **Validated** | Mint (one-time plaintext, hashed at rest), scope enforcement, revocation |
| Dashboard & reporting | **Validated** | `/dashboard` 200 |
| Audit capabilities | **Partial** | Automation logs, AI usage log, `created_by`/`user_id` audit columns, notifications. No general audit trail. |

## Developer integrations

| Feature | Status | Evidence |
|---|---|---|
| Public REST API `/api/v1` | **Validated** | `docs/public-api.md`; smoke covers me/contacts/scopes/revocation |
| Outbound event webhooks | **Installed** | `/api/v1/webhooks`, HMAC-signed deliveries (unit) |
| MCP server | **Removed** (cleanup, 2026-10-21) | Optional upstream package; not used by Suraj Solar. The public API it wrapped (`/api/v1`) is unchanged. |
| Docker / Compose | **Validated** | Image builds, runs non-root, healthy, no `.env*` inside; full smoke 80/80 against container |
| Database migrations | **Validated** | 53 migrations applied in order; `supabase/ci/verify-schema.sql` passes |
| Unit tests | **Validated** | 1,444 / 1,444 |

## Integrations deliberately absent

No AiSensy, WATI, Interakt, Gupshup or any other BSP SDK/dependency exists in `package.json`,
`package-lock.json`, or `src/` — messaging goes directly to `graph.facebook.com`.
