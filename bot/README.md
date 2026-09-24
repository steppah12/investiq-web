# InvestIQ Trading Bot

Reads today's raw model signals from Supabase (written by the main app's
prediction pipeline — this folder contains **no ML of its own**), sizes
trades using the model's Kelly-criterion output against your real account
balance, and executes them on NSE Soko Play (`academy.nse.co.ke`) — NSE's
own investor-education simulation platform. **Virtual money, not a real
brokerage.**

Lives inside the main `investiq-web` repo but runs as its own Node
process — Playwright needs a real browser and persistent session state,
neither of which Vercel's serverless functions support.

## What each file does

- `src/session.js` — logs into Soko Play, saves/restores session state so it doesn't re-login every run
- `src/portfolio.js` — reads current cash balance + holdings (read-only; best-effort selectors, see note below)
- `src/trade.js` — clicks through to Buy/Sell a stock. `submitOrderForm()` is a **deliberate stub** — send a screenshot of the order-entry screen (what appears after clicking Buy/Sell) and it gets wired up for real
- `src/orchestrator.js` — the daily entry point: fetch signals → gate → size → trade
- `src/regretEngine.js` — scores yesterday's raw-vs-gated decision once today's close lands, feeds a per-stock trust score back into the gate

## Setup

```bash
cd bot
npm install
npx playwright install chromium
cp .env.example .env
# fill in NSE_EMAIL, NSE_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
npm run login    # one-time, opens a real browser window to seed the session
```

Then run the SQL migrations in `../supabase-migration/004_predictions_for_bot.sql`
and `005_bot_support_tables.sql` against your Supabase project (same one
the main app uses) if you haven't already.

## Daily flow (manual for now — see "Running on a schedule" below)

```bash
npm run trade    # reads today's predictions, sizes, executes
npm run regret   # scores yesterday's decisions, updates trust scores
```

## Trade sizing — full Kelly, uncapped trade count

This is deliberate, given it's virtual money: `MAX_TRADES_PER_DAY` is unset
by default (no cap), and position sizes use the model's **full** Kelly
percentage — the main app's own `kellyPct` field is already halved for
safety in the browser UI; the value written here is reconstructed back to
full Kelly. The only hard limit is that a trade can never exceed the
account's actual available cash — that's a technical constraint, not a
risk decision.

## `LEARNING_MODE`

Recommended **on** to start (`.env.example` defaults it this way). With it
on, the gate is bypassed entirely — every raw signal gets acted on
directly, `gated_action` always equals `raw_action`. `daily_signals` still
logs both, so you get a clean, unfiltered accuracy record per stock before
any gating logic is trusted with real decisions. Turn it off once you want
`regretEngine.js`'s trust score to start actually influencing the gate.

## Roster integration (Phase C)

If you've enabled the roster/rotation system in the main app, `orchestrator.js`
automatically only trades stocks currently in the **active** tier — benched
stocks get skipped, logged clearly in the console output. If Phase C is
still off (today's default), this is a no-op: every signal trades as
before. Nothing to configure — it just checks whether a roster exists.

## Running on a schedule (cron)

`scripts/run-trade.sh` and `scripts/run-regret.sh` wrap the two npm
commands with timestamped logging to `logs/` (auto-rotated after 30 days)
and correct exit-code propagation, so cron failures are actually visible
instead of silently disappearing.

**This only runs while your machine is on** — there's no way around that
without an always-on host (a small VPS is the usual next step once this is
working reliably). Add to your crontab:

```bash
crontab -e
```

```cron
# Trade shortly after the main app's daily prediction cron (16:00 EAT / 13:00 UTC)
15 13 * * 1-5 /home/blackhouse/investiq-web/bot/scripts/run-trade.sh

# Score yesterday's decisions once today's close is in
20 13 * * 1-5 /home/blackhouse/investiq-web/bot/scripts/run-regret.sh
```

(Adjust the path if your username/home directory differs — check with `pwd`
from inside the `bot` folder.)

Check `bot/logs/trade-YYYY-MM-DD.log` and `bot/logs/regret-YYYY-MM-DD.log`
each morning to see what happened.

## Known rough edges

- **`submitOrderForm()`** — now implemented against real screenshots of the order form (Order Type toggle, Quantity input, Submit button), but **not yet live-verified**. Test it manually on ONE trade before trusting the daily automated run:
  ```bash
  node -e "
  import('./src/session.js').then(async ({ launchSession }) => {
    const { placeTrade } = await import('./src/trade.js');
    const { browser, page } = await launchSession({ headless: false });
    try {
      await placeTrade(page, 'KNRE', 'BUY', { quantity: 10 });
      console.log('Check the account — did it actually go through?');
    } finally {
      await browser.close();
    }
  });
  "
  ```
  Run this with `headless: false` so you can watch it happen, on a small quantity, and confirm manually on the dashboard afterward that it worked as expected.

- **Holdings reading is currently disabled** (`portfolio.js` returns `[]` always) — an earlier heuristic returned false-positive "holdings" that didn't actually exist. Until we see a real screenshot of the "View All Your Holdings" page, holdings stay empty on purpose: a wrongly-empty list just means the bot won't sell anything that day (safe); a wrongly-populated one could trigger a sell of shares you don't hold (not safe). **Practical effect: SELL signals will all be skipped for now** — only BUY works currently.

- **Session expiry** — seen at least once ("Your session has expired due to inactivity"). If a run fails with a login-related error, just re-run `npm run login`. Worth hardening the auto-recovery for this in a future round if it keeps happening.

- **Running on a schedule** — this needs to run somewhere always-on (not your laptop, unless it's on during market hours every day). A small VPS or a scheduled CI job are the usual options; worth deciding once the manual flow is confirmed working end to end.
