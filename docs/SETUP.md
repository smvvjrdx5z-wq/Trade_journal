# Setup

Everything runs on the Windows PC where MetaTrader 5 is installed. Budget about
fifteen minutes.

---

## 1. Create a Notion integration

1. Go to <https://www.notion.so/my-integrations> and click **New integration**.
2. Name it `MT5 Trade Journal`, pick your workspace, and give it
   **Read**, **Update** and **Insert** content capabilities.
3. Copy the **Internal Integration Secret** — it starts with `ntn_`.

Then grant it access to the journal:

4. Open the **MT5 Trade Journal** page in Notion.
5. Click **•••** (top right) → **Connections** → find `MT5 Trade Journal` → **Confirm**.

Sharing the parent page cascades to all six databases inside it. If a later sync
returns `object_not_found`, this step was missed or applied to the wrong page.

---

## 2. Install the bridge

Python 3.11 or newer is required.

```bash
cd bridge
python -m pip install -e .
```

To also enable the full-history importer:

```bash
python -m pip install -e ".[mt5]"
```

---

## 3. Install the Expert Advisor

1. In MetaTrader 5: **File → Open Data Folder**. Explorer opens the terminal's
   data directory.
2. Copy `mql5/Experts/NotionTradeJournal.mq5` into `MQL5\Experts\`.
3. Back in MT5, open the Navigator (`Ctrl+N`), right-click **Expert Advisors** →
   **Refresh**, then double-click `NotionTradeJournal` to compile it.
4. Drag it onto **any one chart**. It watches every symbol on the account, so a
   single instance is enough — attaching more than one will duplicate trades.
5. Make sure **Algo Trading** is enabled (the toolbar button must be green).

> The EA does not trade and does not need "Allow live trading". It only reads
> history and writes files.

### EA inputs worth knowing

| Input | Default | Notes |
|---|---|---|
| `InpSpoolFolder` | `NotionJournal` | Subfolder inside `MQL5\Files`. |
| `InpBackfillOnInit` | `true` | Exports past trades the first time you attach it. |
| `InpBackfillDays` | `90` | How far back that backfill reaches. |
| `InpCaptureChart` | `true` | Set to `false` to skip screenshots entirely. |
| `InpTemplateName` | *(blank)* | A `.tpl` name to apply before capturing — use this to get your own indicators into the screenshot. |
| `InpChartScale` | `3` | 0 is the widest zoom, 5 the tightest. |
| `InpRightMarginBars` | `12` | Bars of empty space to the right of the exit. |
| `InpRenderWaitMs` | `900` | Raise this if screenshots come out blank on a slow machine. |

---

## 4. Find your spool path

When the EA starts it prints the exact path to the **Experts** tab of the
Toolbox:

```
[NotionJournal] Spool directory: C:\Users\you\AppData\Roaming\MetaQuotes\Terminal\D0E8209F77C8CF37\MQL5\Files\NotionJournal
```

Copy that line into `.env`.

---

## 5. Configure the bridge

```bash
cp .env.example .env
```

Then edit `.env`:

```ini
NOTION_TOKEN=ntn_your_secret_here
BRIDGE_SPOOL_DIR=C:\Users\you\AppData\Roaming\MetaQuotes\Terminal\D0E8209F77C8CF37\MQL5\Files\NotionJournal
BRIDGE_TIMEZONE=Europe/Berlin
```

The six `NOTION_*_DB` IDs are already filled in for your workspace.

`BRIDGE_TIMEZONE` decides which calendar day a trade is journalled under and how
sessions are labelled. Set it to the timezone you actually trade in, not the
broker's.

---

## 6. Verify

```bash
tradejournal doctor
```

Expected output:

```
Spool directory : C:\...\MQL5\Files\NotionJournal
                  exists, 0 pending payload(s)
Timezone        : Europe/Berlin
Cached trades   : 0
Notion Trades        : reachable
Notion Accounts      : reachable
Notion Daily Journal : reachable
Notion Playbooks     : reachable
Notion Tags          : reachable
Notion Performance   : reachable

All good.
```

---

## 7. Run

```bash
tradejournal watch
```

Close a trade and it appears in Notion within a few seconds, screenshot attached.

### Keep it running

Create a Windows Scheduled Task set to **At log on**, running:

```
Program:   C:\path\to\python.exe
Arguments: -m tradejournal.cli watch
Start in:  C:\path\to\Trade_journal\bridge
```

Tick **Run whether user is logged on or not** if MT5 runs as a service.

---

## 8. Import your history (optional)

To pull in everything from before you installed the EA:

```bash
tradejournal import --days 730
```

This reads the terminal's deal history directly. It requires MT5 to be open and
logged in, and the `MetaTrader5` package installed. Historic trades come in with
full numbers but **no screenshots** — the chart state at the time is gone.

---

## Troubleshooting

**Screenshots are blank or missing**
Raise `InpRenderWaitMs` to 2000. The terminal needs time to render the chart
before the capture, and a cold symbol may still be downloading H4 history.

**`file upload send failed 400`**
Bump `NOTION_VERSION` in `.env` to a newer date, e.g. `2025-09-03`.

**Trades appear without an R-multiple**
The position had no stop loss, so there is no initial risk to divide by. The
bridge falls back to `BRIDGE_DEFAULT_RISK_PCT` of the balance and flags the value
as estimated in the trade page body.

**Duplicate trades**
More than one chart has the EA attached. Remove all but one.

**Nothing syncs, but `doctor` passes**
Check the EA is actually writing: look for `trade_*.json` files in the spool
folder. If none appear, Algo Trading is off, or the EA errored — check the
Experts tab.

**A trade is missing after the bridge was offline**
Nothing is lost. Payloads stay in the spool folder until the bridge processes
them. Start it and they drain automatically.
