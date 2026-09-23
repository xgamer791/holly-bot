# Holly Bot — Convex

Team: `chris-4b19d` (Mango Marketeers)  
Project: `holly-bot`  
Dashboard: https://dashboard.convex.dev/t/chris-4b19d/holly-bot

## Deployments

| Kind | Name | Cloud URL | Dashboard |
|------|------|-----------|-----------|
| Production | `impressive-ferret-800` | https://impressive-ferret-800.convex.cloud | https://dashboard.convex.dev/t/chris-4b19d/holly-bot/impressive-ferret-800 |
| Development | `useful-wildebeest-212` (`dev/chris`) | https://useful-wildebeest-212.convex.cloud | https://dashboard.convex.dev/t/chris-4b19d/holly-bot/useful-wildebeest-212 |

## Local wiring

1. Copy `.env.example` → `.env.local` (or use deploy keys from the owner’s secret store).
2. `npm install`
3. Dev push: `npm run convex:once` (or `npx convex dev`)
4. Prod push: `npx convex deploy` (uses default prod deployment)

Deploy keys live in box secrets (not in this repo):
- `/home/box/.secrets/holly-bot-convex-prod.env`
- `/home/box/.secrets/holly-bot-convex-dev.env`

## Scaffold

- `convex/schema.ts` — `meta` table with `by_key`
- `convex/health.ts` — `health:ping` query, `health:upsertMeta` mutation

Do not point Forge (`polished-ram-883` / `zealous-partridge-60`) at Holly Bot.
