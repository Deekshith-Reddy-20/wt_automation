# Setup Report — Suraj Solar WhatsApp CRM (WACRM)

Date: 2026-10-17 · Location: `C:\Users\littu\OneDrive\Desktop\solar\wacrm`

| | |
|---|---|
| Upstream | https://github.com/ArnasDon/wacrm (MIT) |
| Baseline commit | `f6a9a1211e28efaa37c5ca7e75fdc0ccdfbb1ba0` (`main`, v0.8.0, merged 2026-10-16) |
| Working branch | `suraj-solar/customization` (local; nothing pushed) |
| Stack | Next.js 16.3.8, React 19.2, TypeScript 6, Tailwind 4, Supabase (Postgres 17), Meta Graph API v21.0 |

## Readiness summary

| Area | State |
|---|---|
| Code, dependencies, build, tests | ✅ Ready — all gates green (1,444/1,444 tests) |
| Local environment (app + Supabase + seed data) | ✅ Running and validated end-to-end (80/80 smoke checks, dev and Docker) |
| Suraj Solar branding + CRM customization | ✅ Done (configurable in the UI) |
| Docker deployment artefacts | ✅ Validated locally |
| Hosted Supabase project | ⏳ Needs your Supabase account (`SUPABASE_SETUP.md` §B) |
| Meta WhatsApp live messaging | ⛔ Blocked on credentials — **not tested live** |
| AI assistant | ⛔ Blocked on an OpenAI/Anthropic key (optional feature) |
| Public deployment | ⏳ Not done by design (needs your hosting decision + domain + HTTPS) |

## What was done

1. **Cloned & inspected** the full repository (README, AGENTS.md, package files, docs/, src/,
   supabase/, mcp-server/, Dockerfile, compose, CI workflows). Inventory → `MODULE_STATUS.md`.
2. **Installed** with `npm ci` from the lockfile (no upgrades); MCP server deps installed
   separately and built.
3. **Supabase**: local stack via Supabase CLI + Docker; all 53 migrations applied in order;
   upstream schema assertions pass; RLS/policy/index audit done.
4. **Environment**: `.env.local` generated (fresh `ENCRYPTION_KEY` and cron secret, placeholder
   Meta secret) — never committed. Guide → `ENV_CONFIGURATION.md`.
5. **Validated** auth, RBAC, RLS, API keys, webhook security/idempotency, cron auth, MCP, Docker.
6. **Customized** for Suraj Solar (below) and **fixed** one confirmed defect.
7. **Documented** everything in the seven reports.

## Suraj Solar customization

Code changes (minimal, upstream functionality untouched):

| Change | Files |
|---|---|
| Brand name "Suraj Solar CRM" in sidebar (all 4 locales), page titles, invite texts, metadata | `messages/*.json`, `src/app/layout.tsx` |
| Sun logo (sidebar, login/signup/forgot-password) + amber favicon | `src/components/layout/sidebar.tsx`, `src/app/(auth)/*/page.tsx`, `src/app/icon.tsx` |
| Default colour theme → Amber (users can still switch) | `src/lib/themes.ts` |
| Round-robin assignment fix | `src/lib/automations/assign.ts` (+ test), `engine.ts` |
| Seed + smoke scripts | `scripts/seed-suraj-solar.mjs`, `scripts/smoke-test.mjs` |

Data configuration (`node scripts/seed-suraj-solar.mjs --owner-email <email> [--with-samples]`,
idempotent; everything editable in the CRM afterwards):

- **Account**: name "Suraj Solar", default currency **INR**.
- **Contact attributes** — Customer name → built-in *Name*; Mobile number → built-in *Phone*;
  custom fields: Location, Property type, Electricity bill amount, Solar requirement,
  Interested capacity (kW), Installation type, Lead source, Lead priority, Assigned salesperson,
  Follow-up date, Lead status. (WACRM custom fields are text-typed; suggested values are stored
  in `field_options`.)
- **Pipeline "Solar Sales"**: New Lead → Contacted → Qualified → Site Survey → Quotation Sent →
  Negotiation → Won / Lost.
- **Tags**: New Enquiry, Residential, Commercial, Agricultural, Hot Lead, Bill Requested,
  Bill Received, Quotation Requested, Quotation Sent, Follow-up Sent, Do Not Follow Up, Needs Human.
- **9 automations (all INACTIVE until you enable them)**:

| Workflow | Trigger | What it does |
|---|---|---|
| New WhatsApp enquiry | First inbound message | Lead source=WhatsApp, status=New Lead, tag, creates deal in *New Lead*, sends 3 buttons (Residential / Commercial / Agricultural) |
| Residential enquiry | Button `solar_residential` | Tags, property/installation type, bill-range list (waits for reply → saves to *Electricity bill amount*), asks for location + bill photo |
| Commercial enquiry | Button `solar_commercial` | Tags, priority High, commercial bill ranges, assigns salesperson, asks business details |
| Agricultural enquiry | Button `solar_agricultural` | Tags, pump / farm-plant / guidance choice (saved to *Solar requirement*), asks farm details |
| Electricity bill collection | Keywords: bill, electricity bill, light bill, bijli bill | Tag *Bill Requested*, asks for bill photo/PDF |
| Sales agent assignment | Tag *Hot Lead* added | Priority High + assign least-loaded salesperson |
| Quotation request | Keywords: quotation, quote, price, cost, rate, estimate | Tag, status, lists info needed, assigns salesperson |
| Quotation follow-up reminder | Tag *Quotation Sent* added | Waits 2 days; unless *Do Not Follow Up*, sends approved template `solar_quotation_followup` (24-h-window compliant) |
| Human agent escalation | Keywords: agent, human, call me, callback, talk to, executive, speak to someone | Tag *Needs Human*, assign, confirm handoff |

- **3 DRAFT templates** (not submitted to Meta), **4 quick replies** (documents needed, site
  survey, subsidy info, quotation shared).
- **Sample data** (local only): 8 leads across every stage with custom values, notes, demo
  conversations and INR deals; phone numbers `+91 55555 000xx` (not valid mobile numbers).

Before enabling automations: connect WhatsApp, get templates approved, review message wording,
and note that keyword workflows and the AI auto-reply can both answer the same message — enable
one strategy per use case.

## Known defects and fixes

| # | Issue | Severity | Action |
|---|---|---|---|
| 1 | `assign_conversation` "round robin" picked an arbitrary single profile (`limit(1)`, unordered) — always the same person, possibly a read-only **viewer** | Medium (sales assignment broken) | **Fixed**: least-loaded owner/admin/agent, deterministic ties, sticky per lead; 8 unit tests + live engine check |
| 2 | Graph API pinned to **v21.0**; reported retirement **2027-01-21** | **High before Jan 2027** | Not changed (needs live regression test). Bump `META_API_VERSION` and run the go-live plan; or merge an upstream release that does |
| 3 | Broadcast **scheduling** not implemented ("Schedule & Send" step only has *Send now*) | Feature gap | Needs development (e.g. `scheduled_at` column + cron drain), or send manually at the desired time |
| 4 | Media buckets are public-by-URL (customer bill photos) | Privacy, medium | Documented; converting to private + signed URLs is a code change |
| 5 | Rate limiter is in-memory per process | Low (single instance OK) | Redis/Upstash swap if scaling horizontally |
| 6 | `npm audit`: 9 high in dev-only `braces` chain (shadcn CLI, eslint-config-next); no upstream fix | Low (not in runtime bundle) | Monitor; do **not** run `npm audit fix --force` (downgrades) |
| 7 | Next 16 deprecation warnings: `middleware` → `proxy`, Edge runtime for `icon.tsx` | Info | Upstream will migrate; harmless today |
| 8 | `.env.local.example` references `docs/automations-and-cron.md`, which moved to the separate wacrm-site repo | Docs | Cron usage documented in `DEPLOYMENT_GUIDE.md` §5 |
| 9 | Process env overrides `.env.local` (caused false failures during setup) | Ops gotcha | Documented in `ENV_CONFIGURATION.md` |
| 10 | MCP server reports version 0.1.0 while `package.json` says 0.1.1 | Cosmetic | None |

No defects found in authentication, RLS, webhook signature verification, idempotency or API-key
handling.

## Missing credentials checklist

| Credential | Needed for | Where it goes |
|---|---|---|
| Supabase project URL, anon key, service-role key (new **dev** project, later **prod**) | Hosted DB/auth | env vars |
| Meta App Secret | Webhook signature verification | `META_APP_SECRET` |
| Meta App ID | Image-header templates only | `META_APP_ID` |
| WABA ID, Phone Number ID | Connecting the number | CRM → Settings → WhatsApp |
| Permanent System-User access token (`whatsapp_business_messaging`, `whatsapp_business_management`) | All Meta calls | CRM → Settings → WhatsApp |
| Webhook verify token (you choose) + 2-step PIN | Webhook + number registration | Meta config + CRM settings |
| Domain + HTTPS certificate | Meta webhook, production access | hosting |
| OpenAI / Anthropic key (optional), embeddings key (optional) | AI assistant, semantic KB | CRM → Settings → AI Assistant |
| SMTP credentials (recommended) | Reliable auth emails | Supabase → Auth → SMTP |

## Local runbook

```powershell
cd C:\Users\littu\OneDrive\Desktop\solar\wacrm
npx supabase start                  # Docker Desktop must be running
npx next dev -p 3001                # port 3000 is used by another app on this PC
# open http://localhost:3001  → sign in with your local dev account (password kept outside Git)
# DB browser: http://127.0.0.1:54323   Auth emails: http://127.0.0.1:54324
```

Docker variant (also running during setup): http://localhost:3002 — stop with `docker compose down`.

## Next steps (in order)

1. Create the hosted dev Supabase project → `db push` → seed config for the real owner.
2. Create the Meta app, system user and token; connect a **test number**; run the go-live plan
   in `META_WHATSAPP_SETUP.md` §7.
3. Bump Graph API version and re-test (before 2027-01-21).
4. Submit and get the three templates approved; review automation wording with the sales team;
   enable automations one at a time.
5. Choose hosting, set env vars, configure the per-minute cron calls, HTTPS, backups
   (`DEPLOYMENT_GUIDE.md`).
6. Optional development: broadcast scheduling, private media bucket, Redis rate limiting.
