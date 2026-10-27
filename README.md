# Suraj Solar CRM

WhatsApp lead qualification and sales CRM for Suraj Solar, built on
Next.js and Supabase and talking directly to Meta's WhatsApp Cloud API
(`graph.facebook.com`).

## What it does

- **WhatsApp lead qualification** — new enquiries get a Telugu / English /
  Hindi language choice, category buttons (residential, commercial,
  agricultural …) and category-specific questions. Answers, lead score and
  tags are saved to the contact before the closing message. Flow definition:
  `src/lib/suraj-solar/lead-flow.ts`, documented in
  [docs/suraj-solar-lead-flow.md](./docs/suraj-solar-lead-flow.md).
- **Inbound webhook** (`/api/whatsapp/webhook`) — Meta signature validation,
  duplicate-delivery protection, message status updates.
- **Shared inbox**, contacts, tags, custom fields, notes and conversation
  history for the sales team.
- **Sales pipeline** (Kanban) with deals linked to conversations.
- **Automations and Flows** — follow-up reminders, agent assignment,
  escalation.
- **Broadcasts** with Meta-approved templates.
- **Optional:** AI reply assistant (bring your own key), public REST API
  (`/api/v1`, see [docs/public-api.md](./docs/public-api.md)) and outbound
  event webhooks.
- **Team access** — owner / admin / agent / viewer roles, enforced by the
  API and by Supabase row-level security.

## Local development

Requires Node.js 22.12+.

```bash
npm install
cp .env.local.example .env.local   # fill in Supabase + Meta values; never commit this file
npm run dev
```

| Command | Purpose |
|---|---|
| `npm run dev` | Development server |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript |
| `npm test` | Unit and integration tests (Vitest, all external services mocked) |
| `npm run build` / `npm start` | Production build / server |

## Documentation

| Topic | File |
|---|---|
| Environment variables | [ENV_CONFIGURATION.md](./ENV_CONFIGURATION.md), [.env.local.example](./.env.local.example) |
| Supabase project and migrations | [SUPABASE_SETUP.md](./SUPABASE_SETUP.md) |
| Meta WhatsApp connection | [META_WHATSAPP_SETUP.md](./META_WHATSAPP_SETUP.md), [docs/whatsapp-connection-troubleshooting.md](./docs/whatsapp-connection-troubleshooting.md) |
| Deployment (Node.js host or Docker) | [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md), [docs/docker.md](./docs/docker.md) |
| Auth emails | [docs/auth-emails.md](./docs/auth-emails.md) |
| Module status | [MODULE_STATUS.md](./MODULE_STATUS.md) |

Database schema changes live in `supabase/migrations/` and are applied in
filename order. Never apply a migration to the production project without
reviewing it first.

## License

Based on [wacrm](https://github.com/ArnasDon/wacrm) by Arnas Donauskas,
used under the MIT License — see [LICENSE](./LICENSE). The license notice
must stay with the code.
