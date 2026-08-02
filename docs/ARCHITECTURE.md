# Architecture

## The shape of the problem

Getting MT5 trades into Notion has two halves that pull in opposite directions.

**Capturing the chart** can only be done inside MetaTrader. `ChartScreenShot()`
renders the real chart — your template, your indicators, your colours — and MQL5
can draw the entry, exit, stop and target onto it as chart objects first. The
`MetaTrader5` Python package has no screenshot API at all. Redrawing the chart in
matplotlib from OHLC data would produce something that is not your chart.

**Talking to Notion** should never happen inside MetaTrader. `WebRequest()` is
synchronous: it halts the calling thread until the server answers. It also needs
every URL whitelisted in terminal options, cannot run in the Strategy Tester, and
would put a Notion secret on the trading machine. Building multipart file uploads
and computing forty metrics in MQL5 would be miserable and brittle.

So the split is: **MQL5 does what only MQL5 can do, and nothing else.**

## Data flow

```
 MetaTrader 5 terminal                    Filesystem                Python bridge
┌───────────────────────────┐        ┌──────────────────┐      ┌───────────────────┐
│ OnTradeTransaction        │        │ NotionJournal/   │      │ spool.pending()   │
│   detect DEAL_ENTRY_OUT   │        │   trade_123.json │      │        │          │
│        │ queue            │───────►│   trade_123.png  │─────►│        ▼          │
│        ▼                  │  write │   account.json   │ read │ Trade.from_ea_... │
│ OnTimer (1s)              │        │   processed.csv  │      │   enrich()        │
│   reconstruct position    │        │   processed/     │◄─────│   archive()       │
│   open H4 chart           │        └──────────────────┘ move │        │          │
│   draw markers            │                                  │        ▼          │
│   ChartScreenShot         │                                  │ TradeStore cache  │
│   close chart             │                                  │   analytics       │
└───────────────────────────┘                                  │        │          │
                                                               │        ▼          │
                                                               │ Notion REST       │
                                                               │   upload PNG      │
                                                               │   upsert pages    │
                                                               └───────────────────┘
```

A directory is the interface. That choice buys a lot:

- **The EA never blocks.** Writing a file takes microseconds. No network call ever
  touches the trading thread.
- **Nothing is lost when the bridge is down.** Payloads accumulate on disk and
  drain on the next run. No queue server, no database.
- **No secrets in MetaTrader.** The Notion token only exists in the bridge's `.env`.
- **Either side can be restarted independently**, mid-trade, without coordination.

## Why not the alternatives

| Approach | Why not |
|---|---|
| **EA calls Notion directly via `WebRequest`** | Blocks the trading thread, needs URL whitelisting, embeds the token on the trading machine, no retries, JSON and multipart assembly in MQL5. |
| **Python only, using the `MetaTrader5` package** | Windows-only, and cannot screenshot. Charts would have to be redrawn and would not match what you actually traded. |
| **Notion's own API polling a broker** | MetaQuotes exposes no public account REST API. Broker-specific APIs are not portable. |
| **iOS MT5 app as the bridge** | The mobile apps are sealed clients: no MQL5 runtime, no file access, no API. Structurally impossible. |

The Python package is still used, but only for `tradejournal import` — pulling
years of history in one pass, which the EA's event-driven path cannot do.

## Correctness details worth knowing

### Reconstructing a position from deals

MT5 stores *deals*, not trades. One journal row is a round-turn position, rebuilt
by grouping deals on `DEAL_POSITION_ID`:

- Entry price is the **volume-weighted** mean of all `DEAL_ENTRY_IN` deals, so
  scaling in is handled correctly.
- Exit price is the volume-weighted mean of all `DEAL_ENTRY_OUT` deals, so partial
  closes are too.
- Open time is the earliest IN, close time the **latest** OUT.
- Balance, credit and commission rows are skipped — they carry no position.
- A position whose IN deal predates the loaded history has an OUT with no matching
  IN. It cannot be reconstructed, so it is skipped rather than half-reported.

### The original stop, not the final one

Reading the stop off order history after the fact gives whatever it was last
moved to, which destroys the R-multiple. Instead the EA polls open positions once
a second and records `POSITION_SL` / `POSITION_TP` the first time it sees a
position. That snapshot is persisted to `open_positions.csv`, so it survives a
terminal restart. Order history is only a fallback for positions the EA never
saw open.

### MAE and MFE

Tracked from the same one-second poll: the worst and best price the position ever
reached, converted to account currency at close. MT5 keeps no record of this, so
it cannot be reconstructed later — trades imported through `tradejournal import`
have no MAE/MFE, and that is unavoidable.

### Idempotency

`Position ID` is the unique key end to end. The EA keeps a `processed.csv` so it
never re-emits. The bridge checks its local cache, then queries Notion by
`Position ID` before creating anything. Re-running any command is safe.

### Hand-written columns are never overwritten

On update, the bridge deletes `Playbook`, `Tags`, `Setup Grade`,
`Execution Grade`, `Followed Plan`, `Confidence`, `Entry Reason`, `Exit Reason`
and `Lessons` from the payload before sending it. Machine fields refresh; your
analysis does not get clobbered.

## The local cache

`bridge_state.json` holds every synced trade. Analytics run against it rather
than reading back from Notion, which means a dashboard refresh costs almost no
API calls and stays correct even if a number gets edited by hand in Notion.

The exceptions are Playbook, Tag and Setup Grade rollups. Those columns only
exist in Notion, so `_load_annotations()` pages through the Trades database to
read them before computing those scopes.

## Rate limiting

Notion allows roughly three requests per second. `NotionClient` throttles to that
interval, honours `Retry-After` on 429, and retries 5xx with exponential backoff
up to five attempts. Screenshot uploads follow Notion's three-step direct upload
and are attached immediately, well inside the one-hour window before an unattached
upload is archived.

## Timezones

MT5 timestamps are broker-server local with no zone attached. The EA emits
`server_utc_offset_minutes` alongside every trade, computed from
`TimeCurrent() − TimeGMT()`. The bridge normalises everything to UTC on ingest,
then presents in `BRIDGE_TIMEZONE`. Sessions are classified on the UTC hour;
calendar day and weekday use your local zone. A 23:30 UTC trade correctly lands
on the next day for a Berlin-based trader.

The importer has no such field to work from, so it estimates the broker offset
from a live tick and rounds to the nearest half hour — which covers every real
broker offset.
