# Side Bet

**Pick a side. Put up chips.**

Side Bet is a play-chip app for friendly bets and custom draft contests. You can draft players, write your own scoring rules in plain English, attach a results source, and the scoreboards update as matches finish. Chips are free and can't be redeemed.

Stack: Next.js 16 (App Router, TypeScript, Tailwind v4) · Supabase Postgres, Auth and Realtime · Vercel. No AI or paid APIs.

---

## Quick start (demo mode, no accounts or keys)

```bash
npm install
npm run dev
```

Open http://localhost:3000. With no environment variables set, the app runs in **demo mode**. A banner labels it, and demo mode means:

- an embedded PostgreSQL database (PGlite, stored in `./.data`) that runs **the same SQL migrations, RLS policies and functions** as production
- local username/password accounts
- the built-in rule parser (the app never calls an AI service)
- live updates over server-sent events
- three seeded demos with fictional people and events

Demo accounts all use the password `sidebet-demo`:

| user | role |
|---|---|
| `commish` | admin |
| `jordan`, `riley` | entrants in the private demos |
| `casey` | regular user who was **not** invited to the private contests |

Seeded demos:
1. **Northgate Chess Championship Draft** (private): rosters were drafted offline and imported. A match win is +2 and beating a higher seed is +3 more; only main-bracket matches count. A demo feed with stages: in *Admin → Results*, click **Stage ▶** and then **Check results now** to finish matches, apply a correction, and trigger an ambiguous-name review (“M. Okafor”).
2. **Comets vs Owls** (public): two bets on a fictional game, “who wins?” and “overtime?”. Each shows the live score, and the outcome stays pending until the final result.
3. **Backyard Race Day** (private): scored from results the admin types in, e.g. *“Josiah won race two”*.

To reset the demo, run `npm run demo:reset` and restart. Admins also get a **demo clock** (Admin page) that shifts server time, so you can test the weekly claim and lock times.

---

## Production setup (Supabase + Vercel)

1. **Create a Supabase project.**
2. **Run the migrations.** In the Supabase dashboard → SQL editor, paste and run each file in `supabase/migrations/` in order (`0001_side_bet.sql`, then `0002_friends_manual_achievements.sql`). Or, with `DATABASE_URL` set, run `npm run db:migrate`. The file is idempotent.
   Do **not** run `supabase/shim/*`. That file is for local demo and tests only.
3. **Configure Auth.** Under Authentication → Providers, enable Email. For the smoothest sign-up, turn off “Confirm email”. If you leave it on, the app tells new users to check their email.
4. **Fill in the environment variables** (see `.env.example`), in `.env.local` locally or in Vercel → Project → Settings → Environment Variables:
   - `DATABASE_URL` (or `POSTGRES_URL`, which the Vercel ↔ Supabase integration sets for you): Database → Connection string → **Transaction pooler** (port 6543). Setting either switches the app to Supabase mode.
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `ADMIN_USERNAMES`: who becomes admin (see below)
   - `CRON_SECRET`: a long random string
5. **Deploy to Vercel.** Import the GitHub repo; the framework is Next.js and there are no build settings to change. Realtime works automatically: the migration adds `contest_signals` to the `supabase_realtime` publication.
6. **Optional demo content:** `SUPABASE_SERVICE_ROLE_KEY=… npm run db:seed` creates the fictional demo accounts and contests in Supabase.

### Create the first admin

Use any one of these:
- Set `ADMIN_USERNAMES=yourname` and sign up or sign in as `yourname`. The account is promoted on sign-in.
- Run `npm run make-admin -- yourname` (needs `DATABASE_URL`).
- In the SQL editor, run `update public.profiles set is_admin = true where username = 'yourname';`

### Player-run bets, friends and achievements

- **Start a bet** (`/new`): any player can create a private "pick a side" bet or a "draft / teams" contest and run it themselves: add friends or share a link, lock entries, type in rosters and scores, and pay out. Nothing is auto-tracked. These are `contests.manual = true`; the creator gets the same controls an admin has, but only for contests they created (`can_manage_contest()`).
- **Friends** (`/friends`): send requests by username; friends can be added straight to bets you run.
- **Achievements** (`/achievements`): milestone rewards players claim on their own screen. Definitions live in `src/lib/server/achievements.ts`; each claim is recorded once and paid through the ledger.
- Free chips are 10 once a week (`app_settings.claim_amount`, `claim_cooldown_seconds`).

### No AI, no paid services

Side Bet calls **no AI service and no paid API**. Scoring instructions and typed results (e.g. “Josiah won race two”) are read by a built-in, rule-based parser; anything it can’t map is flagged so the admin handles it with an explicit adjustment. Results come from structured feeds (PGN, ESPN, Side Bet JSON) or admin-entered results. Chips are free play chips with no purchase or cash-out path.

### Scheduled result checks

Scheduled runs, the cron route and the admin **Check results now** button all call the same `checkContest()` pipeline.

- **Vercel Cron:** `vercel.json` calls `/api/cron/check-results` daily. The Hobby plan only allows daily crons; on Pro, change the schedule to e.g. `*/10 * * * *`. Vercel sends `Authorization: Bearer $CRON_SECRET` automatically.
- **Every 10 minutes on any plan:** `.github/workflows/check-results.yml`. Add repo secrets `SIDEBET_URL` and `CRON_SECRET`, and set the repo variable `SIDEBET_CRON_ENABLED=true`.
- **Manually:**

  ```bash
  curl -H "Authorization: Bearer $CRON_SECRET" https://your-app/api/cron/check-results
  ```

- **Local dev:** an in-process scheduler runs every `SIDEBET_CHECK_INTERVAL_SECONDS` (default 300). Disable it with `SIDEBET_LOCAL_SCHEDULER=0`.

---

## How it works

**Ledger.** Every chip movement is one row in `ledger`: starting grant, free claim, stake, payout or refund. Each row has a unique idempotency key and is written by `sidebet_private.post_ledger`, which locks the wallet row and refuses negative balances. Claims are keyed to the previous claim and checked against server time (`app_now()`). Joins are unique per contest and user, and settlement is unique per contest, so retries and races can't double-charge or double-pay.

**Access.** Every table has RLS. Private contests are visible only to admins, entrants and people who redeemed an invite. This holds in API responses, raw table reads and realtime subscriptions (`contest_signals` is RLS-filtered and carries no picks). Bet picks are hidden by RLS until entries lock. Settlement, cancellation, rule approval and scoring writes live in the `sidebet_private` schema, which signed-in users can't call; the server calls it after checking admin rights and recomputing payouts.

**States.** A contest moves through `setup → open → (drafting) → locked/active → awaiting_settlement → settled`, or to `canceled`. A trigger enforces the allowed transitions, and terms freeze once the first entry is accepted.

**Results pipeline** (`src/lib/server/results/pipeline.ts`):
1. **Fetch.** An adapter reads the source: Side Bet JSON feed, PGN (e.g. Lichess broadcasts), ESPN scoreboard JSON, admin-entered results, or demo fixtures. Fetching is limited to public http(s) URLs, with private IPs blocked on every redirect, a 10 s timeout and a 2 MB cap.
2. **Validate.** Facts are checked with zod, and participants are matched to picks by name, alias and accent-insensitive comparison.
3. **Review.** Ambiguous names, conflicting results, missing facts and post-payout corrections go to **admin review** instead of being scored.
4. **Identify.** Each event has a stable `event_key` plus a fingerprint of its facts. Rechecking identical facts adds nothing.
5. **Correct.** A changed result creates a new revision, recalculates that event's score lines, and logs “what changed”.
6. **Settle.** The admin previews exact payouts. Confirming re-computes them on the server and refuses if anything changed since the preview.

**Payout rules.** These are published on every contest.
- Bets split the pot equally among winning entries. Leftover chips go one each to the earliest winning entries.
- If nobody picked the winning outcome, every stake is refunded.
- Drafts are winner-take-all. The tiebreaker is the best single pick, and entrants still tied split the pot.
- Canceling refunds every stake. Canceled contests and refunded “push” bets don't count toward win/loss records.

---

## Tests and checks

```bash
npm run typecheck
npm run lint
npm test                      # unit + integration (real SQL in PGlite): 45 tests
npm run test:concurrency      # real PostgreSQL (embedded-postgres), parallel connections
npm run build
```

With the app running:

```bash
BASE_URL=http://localhost:3000 npm run e2e
```

That command runs two new accounts in separate cookie sessions through the whole private chess draft over HTTP, including the live SSE updates.

```bash
BASE_URL=http://localhost:3000 npm run screenshots
```

That command captures every main screen at phone and desktop widths using the system Edge or Chrome.

To check a live source:

```bash
BASE_URL=… PGN_URL=https://lichess.org/api/broadcast/round/<id>.pgn PLAYERS="Name, First|1;…" npm run check:live
```

That command runs a live public PGN feed through the same pipeline the scheduler uses.

## Project layout

```
supabase/migrations/        schema, ledger, state machine, RLS (production)
supabase/shim/              local auth/roles shim for demo + tests only
src/lib/scoring/            pure scoring engine, payouts, name matching, schemas
src/lib/server/             db, auth, contests, admin, wallet, profiles, rule parser, results pipeline
src/app/                    pages + API routes (actions, live SSE, cron)
fixtures/                   fictional demo feeds
tests/                      unit, integration, real-Postgres concurrency
scripts/                    e2e, screenshots, live-source check, db helpers
```
