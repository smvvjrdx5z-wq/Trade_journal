# Metrics reference

Every figure the journal computes, how it is defined, and where TradeZella's
published definition was followed or deliberately departed from.

Implementation: [`bridge/src/tradejournal/analytics.py`](../bridge/src/tradejournal/analytics.py).

---

## Trade-level fields

| Field | Definition |
|---|---|
| **Net P&L** | `gross profit + commission + swap + fee`. Commission and swap are negative as MT5 reports them, so this is a true net. |
| **Outcome** | `Win` above `+BREAKEVEN_THRESHOLD`, `Loss` below `−BREAKEVEN_THRESHOLD`, else `Breakeven`. Default threshold is 0.50 account currency. |
| **Risk $** | `|entry − stop| ÷ tick_size × tick_value × volume`. The original stop is captured live by the EA the moment the position opens, so later stop moves do not distort it. |
| **Realized R** | `net P&L ÷ Risk $`. |
| **Planned R** | `|target − entry| ÷ |entry − stop|`. Null when either level is absent. |
| **Return %** | `net P&L ÷ account balance immediately before the trade opened`. |
| **MAE / MFE** | Maximum adverse and favourable excursion in account currency, tracked live by the EA once per second. Backfilled trades have no MAE/MFE — the tick history is gone. |
| **Duration** | Close time minus open time, in minutes. |
| **Session** | Derived from the UTC open hour: Asia 23–07, London 07–12, New York 12–16, London Close 16–20, Off Hours 20–23. |
| **Day of Week / Hour** | Taken in `BRIDGE_TIMEZONE`, not broker time. |

### Positions with no stop loss

There is no initial risk to divide by. Rather than dropping the trade from every
R-based statistic, the bridge substitutes `BRIDGE_DEFAULT_RISK_PCT` of the
balance at open (default 1%) and marks the trade's page body with
*"estimated — no stop was attached"*. Treat those R-multiples as indicative.

---

## Aggregate metrics

| Metric | Definition |
|---|---|
| **Profit Factor** | `gross profit ÷ gross loss`. Above 1.0 is profitable. Null when there are no losses — undefined, not infinite. |
| **Win Rate** | Winning trades ÷ total trades. Breakeven trades count in the denominator. |
| **Day Win Rate** | Profitable days ÷ days traded, grouped on the local calendar date. |
| **Avg Win / Avg Loss** | Mean net P&L of winners, and the absolute mean of losers. |
| **Avg Win/Loss** | `avg win ÷ avg loss`. |
| **Expectancy** | `(win rate × avg win) − (loss rate × avg loss)`, i.e. expected currency per trade. Verified in tests to reconcile with net P&L. |
| **Expectancy R** | Mean realized R across trades that have one. |
| **Max Drawdown** | Largest peak-to-trough fall of the closed-trade equity curve, ordered by close time. |
| **Max Drawdown %** | The same fall expressed against the running peak. |
| **Avg Drawdown** | Mean of all non-zero drawdown observations along the curve. |
| **Recovery Factor** | `net profit ÷ max drawdown`. Null when there is no drawdown. |
| **Consistency** | `100 − (stdev of daily P&L ÷ mean daily P&L) × 100`, clamped to 0–100. Zero when mean daily P&L is negative. |
| **Streaks** | Longest consecutive win and loss runs. Current streak is positive for wins, negative for losses. Breakeven trades reset both. |

> Drawdown is measured on **closed-trade equity**, matching how TradeZella charts
> it. Intraday floating drawdown is not modelled — MT5 does not retain it.

---

## The composite score

TradeZella's "Zella Score" is a 0–100 blend of six weighted components. This is a
faithful reimplementation of their published definition.

| Component | Weight |
|---|---|
| Profit Factor | 25% |
| Avg Win/Loss ratio | 20% |
| Max Drawdown | 20% |
| Trade Win % | 15% |
| Recovery Factor | 10% |
| Consistency | 10% |

### Profit Factor and Avg Win/Loss

Both use the same ladder:

| Value | Score |
|---|---|
| ≥ 2.6 | 100 |
| 2.4 – 2.59 | 90 – 99 |
| 2.2 – 2.39 | 80 – 89 |
| 2.0 – 2.19 | 70 – 79 |
| 1.9 – 1.99 | 60 – 69 |
| 1.8 – 1.89 | 50 – 59 |
| < 1.8 | 20 |

### Trade Win %

`(win % ÷ 60) × 100`, capped at 100. A 60% win rate is treated as full marks,
which is why a high win rate alone cannot carry the score.

### Max Drawdown

`100 − drawdown %`, floored at 0.

### Recovery Factor

| Value | Score |
|---|---|
| ≥ 3.5 | 100 |
| 3.0 – 3.49 | 70 – 89 |
| 2.5 – 2.99 | 60 – 69 |
| 2.0 – 2.49 | 50 – 59 |
| < 1.0 | 0 |

### Consistency

`100 − coefficient of variation of daily P&L`, as defined above.

---

## Two deliberate departures

TradeZella's published tables are step functions with gaps. Both are handled
explicitly here, and both are covered by tests.

**1. Scores interpolate within a band instead of stepping.**
A profit factor of 2.39 scores 89, and 2.20 scores 80, with a smooth ramp
between. Stepping would make the score jump discontinuously for a rounding-level
change in performance.

**2. Ratios below 1.0 ramp down to 0 instead of sitting flat at 20.**
TradeZella scores anything under 1.8 as a flat 20. Taken literally, a strategy
with a profit factor of 0.2 — losing five times what it makes — scores the same
as one at 1.7, which is nearly breakeven. The implementation keeps the flat 20
from 1.0 to 1.8, then ramps linearly from 20 down to 0 as the ratio falls from
1.0 to 0.

The same reasoning applies to Recovery Factor between 1.0 and 2.0, which
TradeZella's table simply does not cover; it is interpolated from 0 to 50.

---

## Scope slices

The Performance database is rebuilt on every sync across:

| Scope Type | Rows |
|---|---|
| All Time | 1 |
| Month | one per `YYYY-MM` traded |
| Symbol | one per instrument |
| Session | Asia, London, New York, London Close, Off Hours |
| Day of Week | Monday … Sunday |
| Playbook | one per playbook you have tagged trades to |
| Tag | one per tag in use |
| Setup Grade | A … F |

Playbook, Tag and Setup Grade depend on columns *you* fill in inside Notion, so
the bridge reads those back before computing. Everything else comes from the
local trade cache.

**Sample Warning** is ticked on any scope with fewer than `BRIDGE_MIN_SAMPLE_SIZE`
trades (default 20). A 100% win rate over three trades is noise, and the flag
says so.

---

## Sources

- [Understanding Dashboard Widgets and Stats](https://help.tradezella.com/en/articles/7118437-understanding-dashboard-widgets-and-stats)
- [Introducing the All-New Zella Score](https://help.tradezella.com/en/articles/10305642-introducing-the-all-new-zella-score)
- [Reports: Playbook](https://help.tradezella.com/en/articles/11595424-reports-playbook)
- [Profit Factor in Trading](https://www.tradezella.com/blog/profit-factor)
