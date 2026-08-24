# MT5 → Notion Trading Journal

> **Also in this repo:** [`journal app/`](journal%20app/README.md) — a standalone
> web edition of this journal (same trades / daily journal / playbooks / tags /
> performance model, same scoring math) built on Supabase and deployable on
> Vercel. Its `/api/ingest` endpoint accepts the same JSON payloads the EA
> spools, so the bridge can feed both.

A TradeZella-style trading journal that lives in Notion and fills itself in from
MetaTrader 5. Every closed position arrives with its numbers, its R-multiple, and
a **4H chart screenshot with the entry, exit, stop and target drawn on it**.

```
MetaTrader 5 (Windows)                    Python bridge                Notion
┌──────────────────────┐   JSON + PNG   ┌────────────────┐   REST   ┌──────────┐
│  NotionTradeJournal  │ ─────────────► │   spool watch  │ ───────► │  Trades  │
│  Expert Advisor      │   spool dir    │   analytics    │          │  Daily   │
│  · trade capture     │                │   file upload  │          │  Perf.   │
│  · H4 screenshot     │                └────────────────┘          └──────────┘
└──────────────────────┘
```

## What you get

| Module | What it does |
|---|---|
| **Trades** | One row per round-turn position: entry/exit, volume, commission, swap, MAE/MFE, R-multiple, session, and the H4 screenshot. |
| **Daily Journal** | A page per trading day, pre-filled with a pre-market plan and post-market review template. Daily stats fill in automatically. |
| **Playbooks** | Your strategies with their rules. Tag trades to a playbook and get per-strategy win rate, profit factor, expectancy and R. |
| **Tags** | 45 seeded setup / mistake / emotion / condition / management tags. Find out what actually costs you money. |
| **Performance** | The Zella-Score clone plus ~40 metrics, sliced by all-time, month, symbol, session, weekday, playbook, tag and setup grade. |
| **Accounts** | Balance, equity, peak balance and net P&L per MT5 login. |

## Quick start

Run these in **Windows PowerShell**, on the PC where MetaTrader 5 is installed.
Press `Win`, type `powershell`, hit Enter.

```powershell
# 1. Get the code and install the bridge (needs Python 3.11+ and Git)
cd $HOME
git clone https://github.com/smvvjrdx5z-wq/Trade_journal.git
cd Trade_journal\bridge
python -m pip install -e .

# 2. Configure — then fill in NOTION_TOKEN and BRIDGE_SPOOL_DIR
Copy-Item ..\.env.example .env
notepad .env

# 3. Copy the EA and attach it to any ONE chart in MT5
#    mql5\Experts\NotionTradeJournal.mq5 -> <terminal data folder>\MQL5\Experts\

# 4. Check everything is wired up
python -m tradejournal.cli doctor

# 5. Run it
python -m tradejournal.cli watch
```

Full instructions, including where to find the spool path and how to grant the
Notion integration access, are in **[docs/SETUP.md](docs/SETUP.md)**.

## Commands

Run these from the `bridge` folder.

| Command | Purpose |
|---|---|
| `python -m tradejournal.cli watch` | Run continuously. Trades appear in Notion seconds after they close. |
| `python -m tradejournal.cli sync` | Drain the spool once and exit. Good for a scheduled task. |
| `python -m tradejournal.cli import --days 365` | Backfill closed positions straight from the terminal. Windows only. |
| `python -m tradejournal.cli refresh` | Recompute the dashboard without syncing anything new. |
| `python -m tradejournal.cli doctor` | Verify config, spool directory and Notion connectivity. |

A `tradejournal` shortcut is also installed, but pip often puts it somewhere
Windows is not searching. The `python -m` form always works; see
[docs/SETUP.md](docs/SETUP.md#using-the-tradejournal-shortcut) to enable the short one.

## Why an EA *and* a Python bridge

Both halves do the thing the other cannot:

- **Only MQL5 can screenshot a real MT5 chart.** `ChartScreenShot()` renders your
  actual chart, with your template and indicators, and the EA draws the entry,
  exit, stop and target on it before capturing. The `MetaTrader5` Python package
  has no screenshot API — a Python-drawn chart would not look like your chart.
- **Only Python should talk to Notion.** MQL5's `WebRequest()` is synchronous, so
  a slow API call would block the trading thread. It also needs URL whitelisting,
  would put your Notion token on the trading machine, and has no retry or queue.

So the EA writes JSON + PNG to a folder and never blocks. The bridge watches that
folder. If the bridge is offline, trades queue on disk and drain when it returns.

**The iOS MT5 app cannot be part of this.** MetaQuotes' mobile apps are sealed
clients with no EA runtime, no file access and no API. Use the Notion iOS app to
read and journal on your phone — the views are built to work there.

## Layout

```
mql5/Experts/NotionTradeJournal.mq5   Trade capture + H4 screenshot
bridge/src/tradejournal/
  ├── analytics.py    Zella Score clone and the full metric suite
  ├── cli.py          Command line entry point
  ├── config.py       Environment configuration
  ├── models.py       Trade / Account, R-multiples, sessions
  ├── mt5_source.py   Optional full-history import (Windows only)
  ├── notion.py       REST client, file upload, property builders
  ├── spool.py        The on-disk queue shared with the EA
  ├── store.py        Local trade cache that analytics run against
  └── sync.py         Orchestration, daily rollups, dashboard
docs/
  ├── SETUP.md        Step by step installation
  ├── ARCHITECTURE.md How the pieces fit and why
  └── METRICS.md      Every metric, defined and sourced
```

## Tests

```bash
cd bridge && python -m pytest
```

95 tests cover the scoring ladders, drawdown, streaks, expectancy, broker-time
conversion, session boundaries, the trade cache and the spool queue.
