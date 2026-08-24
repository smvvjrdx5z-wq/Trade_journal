# Trade Journal — web app

The web edition of this repo's MT5 → Notion trading journal: the same
TradeZella-style journal, running as a Next.js app on **Vercel** with
**Supabase** as the database, auth and file storage. Everything the Notion
workspace holds lives here too, plus the analytics are computed live on every
page load instead of being pushed as rows.

| Module | What it does |
|---|---|
| **Dashboard** | Net P&L, win rate, profit factor, expectancy, drawdown, streaks, the Zella Score with its six weighted components, equity curve and daily P&L chart. |
| **Trades** | One row per round-turn position: entry/exit, volume, commission, swap, MAE/MFE, R-multiples, session — plus your nine hand-written journal columns (playbook, tags, grades, followed plan, confidence, entry/exit reasons, lessons) and a chart screenshot. |
| **Daily Journal** | A page per trading day with the same pre-market plan, post-market review and rule-check template. Daily stats fill in automatically. |
| **Playbooks** | Your strategies with their rules, each with live win rate, profit factor, expectancy and R. |
| **Tags** | The same 45 seeded setup / mistake / emotion / condition / management tags (seeded per user on signup), each with its own stats. |
| **Performance** | The full metric suite sliced by all-time, month, symbol, session, weekday, playbook, tag and setup grade — with the small-sample ⚠ flag. |
| **Accounts** | Balance, equity, peak balance and net P&L per MT5 login. |

The scoring math is a TypeScript port of `bridge/src/tradejournal/analytics.py`
— same bands, same interpolation refinements. `docs/METRICS.md` in the repo
root remains the reference for every definition.

## Setup

### 1. Supabase

1. Create a project at [database.new](https://database.new).
2. Open the SQL editor and run `supabase/migrations/0001_init.sql`
   (or `supabase db push` if you use the Supabase CLI). This creates the
   tables, row-level security policies, the private `screenshots` bucket, and
   the signup trigger that seeds each new user's settings row and 45 tags.
3. From **Settings → API** copy the project URL, the `anon` key and the
   `service_role` key.

### 2. Run locally

```bash
cd "journal app"
cp .env.example .env.local   # fill in the three values
npm install
npm run dev
```

Sign up at http://localhost:3000/login — email confirmation is on by default
in Supabase (disable it under Authentication → Providers → Email while
developing, or check your inbox).

### 3. Deploy on Vercel

1. Import this GitHub repo at [vercel.com/new](https://vercel.com/new).
2. Set **Root Directory** to `journal app` (Vercel auto-detects Next.js).
3. Add the environment variables:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` (server-only; powers `/api/ingest`)
4. Deploy. Then add your Vercel URL to Supabase under
   **Authentication → URL Configuration** (Site URL +
   `https://<app>.vercel.app/auth/callback` as a redirect URL) so email links
   land back in the app.

## Getting trades in

Three ways, all idempotent:

- **Manual entry** — *Trades → Log trade*. Outcome, session, R-multiples and
  calendar fields are derived exactly as the Python bridge derives them.
- **MT5 bridge** — `POST /api/ingest` accepts the very JSON payloads the
  `NotionTradeJournal.mq5` EA spools to disk (`server_utc_offset_minutes`,
  `account`, `trade`), one payload or an array. Authenticate with the
  per-user bearer token from the Settings page. Trades upsert by
  `position_id`; accounts upsert by login; an optional `screenshot_base64`
  attaches the chart PNG. A small addition to the Python bridge's sync loop —
  POSTing each spool payload to this endpoint — feeds both journals at once.
- **Editing** — re-posting a position refreshes the machine fields only. The
  nine hand-written journal columns are never overwritten, matching the
  bridge's behaviour with Notion.

## Layout

```
journal app/
├── supabase/migrations/0001_init.sql   Schema, RLS, storage, seed-tag trigger
└── src/
    ├── middleware.ts                   Session refresh + auth gate
    ├── lib/
    │   ├── analytics.ts                Zella Score clone + full metric suite (port of analytics.py)
    │   ├── trade-math.ts               Sessions, outcome, R-multiples, calendar fields (port of models.py)
    │   ├── format.ts                   Number/date formatting
    │   └── supabase/                   Browser, server and service-role clients
    ├── components/                     Nav, stat tiles, equity curve, daily P&L bars, Zella score, trade table
    └── app/
        ├── page.tsx                    Dashboard
        ├── trades/                     List, manual entry, detail + journal editor
        ├── journal/                    Daily journal list + day page
        ├── performance/                All eight scope slices
        ├── playbooks/  tags/  accounts/  settings/
        └── api/ingest/route.ts         MT5-bridge-compatible ingest endpoint
```

## Notes

- **Timezones** work as in the bridge: everything is stored in UTC, sessions
  are classified on the UTC hour, and the journal calendar day / weekday /
  hour use the timezone from Settings.
- **No-stop trades** get the configured default-risk fallback and their R is
  flagged "estimated", exactly like the bridge.
- **Row-level security** isolates every user's data; the service-role key is
  used only by the ingest route after the bearer token has been matched.
