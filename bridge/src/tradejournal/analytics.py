"""Performance analytics: TradeZella-equivalent metrics and the composite score.

Scoring thresholds mirror TradeZella's published Zella Score definition. Where
their documentation leaves a gap, this module interpolates rather than stepping,
and each deviation is called out in ``docs/METRICS.md``.
"""

from __future__ import annotations

import statistics
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from datetime import date
from typing import Iterable, Sequence

from .models import Trade

# Component weights, summing to 1.0.
WEIGHTS = {
    "profit_factor": 0.25,
    "avg_win_loss": 0.20,
    "max_drawdown": 0.20,
    "win_rate": 0.15,
    "recovery_factor": 0.10,
    "consistency": 0.10,
}

# (lower_bound, upper_bound, score_at_lower, score_at_upper)
_RATIO_BANDS: tuple[tuple[float, float, float, float], ...] = (
    (0.0, 1.0, 0.0, 20.0),   # refinement: losing systems should not tie 1.7
    (1.0, 1.8, 20.0, 20.0),  # TradeZella: "below 1.8 = 20"
    (1.8, 1.9, 50.0, 59.0),
    (1.9, 2.0, 60.0, 69.0),
    (2.0, 2.2, 70.0, 79.0),
    (2.2, 2.4, 80.0, 89.0),
    (2.4, 2.6, 90.0, 99.0),
)

_RECOVERY_BANDS: tuple[tuple[float, float, float, float], ...] = (
    (0.0, 1.0, 0.0, 0.0),    # TradeZella: "below 1.0 = 0"
    (1.0, 2.0, 0.0, 50.0),   # interpolated; undocumented upstream
    (2.0, 2.5, 50.0, 59.0),
    (2.5, 3.0, 60.0, 69.0),
    (3.0, 3.5, 70.0, 89.0),
)

WIN_RATE_TOP_THRESHOLD = 60.0


def _clamp(value: float, low: float = 0.0, high: float = 100.0) -> float:
    return max(low, min(high, value))


def _banded(value: float, bands: Sequence[tuple[float, float, float, float]]) -> float:
    """Linearly interpolate ``value`` through a ladder of scoring bands."""
    if value is None:
        return 0.0
    if value <= bands[0][0]:
        return bands[0][2]
    for low, high, score_low, score_high in bands:
        if low <= value < high:
            if high == low:
                return score_high
            ratio = (value - low) / (high - low)
            return score_low + ratio * (score_high - score_low)
    return 100.0


def score_profit_factor(profit_factor: float | None) -> float:
    if profit_factor is None:
        return 0.0
    return _clamp(_banded(profit_factor, _RATIO_BANDS))


def score_avg_win_loss(ratio: float | None) -> float:
    if ratio is None:
        return 0.0
    return _clamp(_banded(ratio, _RATIO_BANDS))


def score_recovery_factor(recovery: float | None) -> float:
    if recovery is None:
        return 0.0
    return _clamp(_banded(recovery, _RECOVERY_BANDS))


def score_win_rate(win_rate_pct: float) -> float:
    """TradeZella caps the score once win rate reaches the top threshold."""
    return _clamp(win_rate_pct / WIN_RATE_TOP_THRESHOLD * 100.0)


def score_max_drawdown(drawdown_pct: float) -> float:
    """100 minus the drawdown percentage."""
    return _clamp(100.0 - drawdown_pct)


def score_consistency(daily_pnl: Sequence[float]) -> float:
    """100 minus the coefficient of variation of daily P&L, as a percentage."""
    if len(daily_pnl) < 2:
        return 0.0
    mean = statistics.fmean(daily_pnl)
    if mean <= 0:
        return 0.0
    stdev = statistics.pstdev(daily_pnl)
    return _clamp(100.0 - (stdev / mean) * 100.0)


@dataclass
class Metrics:
    """Every figure the Performance database stores for one scope."""

    trade_count: int = 0
    winners: int = 0
    losers: int = 0
    breakeven: int = 0

    net_pl: float = 0.0
    gross_profit: float = 0.0
    gross_loss: float = 0.0
    costs: float = 0.0

    profit_factor: float | None = None
    win_rate: float = 0.0
    day_win_rate: float = 0.0
    avg_win: float = 0.0
    avg_loss: float = 0.0
    avg_win_loss: float | None = None
    expectancy: float = 0.0
    expectancy_r: float | None = None
    total_r: float = 0.0
    avg_r: float | None = None

    max_drawdown: float = 0.0
    max_drawdown_pct: float = 0.0
    avg_drawdown: float = 0.0
    recovery_factor: float | None = None
    consistency: float = 0.0

    largest_win: float = 0.0
    largest_loss: float = 0.0
    max_consecutive_wins: int = 0
    max_consecutive_losses: int = 0
    current_streak: int = 0

    avg_hold_minutes: float = 0.0
    logged_days: int = 0
    longs: int = 0
    shorts: int = 0
    long_win_rate: float = 0.0
    short_win_rate: float = 0.0
    avg_volume: float = 0.0

    zella_score: float = 0.0
    score_profit_factor: float = 0.0
    score_avg_win_loss: float = 0.0
    score_max_drawdown: float = 0.0
    score_win_rate: float = 0.0
    score_recovery_factor: float = 0.0
    score_consistency: float = 0.0

    sample_warning: bool = True
    period_start: date | None = None
    period_end: date | None = None

    def as_dict(self) -> dict:
        return asdict(self)


def daily_pnl(trades: Iterable[Trade]) -> dict[date, float]:
    """Net P&L per trading day, keyed on the trade's local calendar date."""
    buckets: dict[date, float] = defaultdict(float)
    for trade in trades:
        buckets[trade.trade_date] += trade.net_pl
    return dict(buckets)


def drawdown_series(
    trades: Sequence[Trade], starting_balance: float
) -> tuple[float, float, float]:
    """Return (max drawdown in currency, max drawdown %, average drawdown).

    The curve is built from closed-trade equity, ordered by close time, which is
    what TradeZella charts. Intraday float is not modelled.
    """
    if not trades:
        return 0.0, 0.0, 0.0

    ordered = sorted(trades, key=lambda t: t.close_time)
    equity = starting_balance if starting_balance > 0 else 0.0
    peak = equity
    max_dd = 0.0
    max_dd_pct = 0.0
    observations: list[float] = []

    for trade in ordered:
        equity += trade.net_pl
        peak = max(peak, equity)
        drop = peak - equity
        observations.append(drop)
        if drop > max_dd:
            max_dd = drop
        if peak > 0:
            pct = drop / peak * 100.0
            if pct > max_dd_pct:
                max_dd_pct = pct

    active = [d for d in observations if d > 0]
    avg_dd = statistics.fmean(active) if active else 0.0
    return max_dd, max_dd_pct, avg_dd


def _streaks(outcomes: Sequence[str]) -> tuple[int, int, int]:
    """Return (max win streak, max loss streak, current streak)."""
    max_win = max_loss = 0
    run_win = run_loss = 0
    for outcome in outcomes:
        if outcome == "Win":
            run_win += 1
            run_loss = 0
            max_win = max(max_win, run_win)
        elif outcome == "Loss":
            run_loss += 1
            run_win = 0
            max_loss = max(max_loss, run_loss)
        else:
            run_win = run_loss = 0

    if run_win:
        current = run_win
    elif run_loss:
        current = -run_loss
    else:
        current = 0
    return max_win, max_loss, current


def compute(
    trades: Sequence[Trade],
    *,
    starting_balance: float = 0.0,
    min_sample_size: int = 20,
) -> Metrics:
    """Aggregate a set of trades into the full metric suite."""
    metrics = Metrics()
    if not trades:
        return metrics

    ordered = sorted(trades, key=lambda t: t.close_time)
    metrics.trade_count = len(ordered)
    metrics.period_start = ordered[0].trade_date
    metrics.period_end = ordered[-1].trade_date
    metrics.sample_warning = len(ordered) < min_sample_size

    wins = [t for t in ordered if t.outcome == "Win"]
    losses = [t for t in ordered if t.outcome == "Loss"]
    metrics.winners = len(wins)
    metrics.losers = len(losses)
    metrics.breakeven = metrics.trade_count - metrics.winners - metrics.losers

    metrics.net_pl = sum(t.net_pl for t in ordered)
    metrics.gross_profit = sum(t.net_pl for t in wins)
    metrics.gross_loss = abs(sum(t.net_pl for t in losses))
    metrics.costs = sum(t.costs for t in ordered)

    metrics.profit_factor = (
        metrics.gross_profit / metrics.gross_loss if metrics.gross_loss > 0 else None
    )
    metrics.win_rate = metrics.winners / metrics.trade_count * 100.0
    metrics.avg_win = statistics.fmean([t.net_pl for t in wins]) if wins else 0.0
    metrics.avg_loss = (
        abs(statistics.fmean([t.net_pl for t in losses])) if losses else 0.0
    )
    metrics.avg_win_loss = (
        metrics.avg_win / metrics.avg_loss if metrics.avg_loss > 0 else None
    )

    # Expectancy: (win rate x avg win) - (loss rate x avg loss)
    win_frac = metrics.winners / metrics.trade_count
    loss_frac = metrics.losers / metrics.trade_count
    metrics.expectancy = win_frac * metrics.avg_win - loss_frac * metrics.avg_loss

    r_values = [t.realized_r for t in ordered if t.realized_r is not None]
    if r_values:
        metrics.total_r = sum(r_values)
        metrics.avg_r = statistics.fmean(r_values)
        metrics.expectancy_r = metrics.avg_r

    metrics.largest_win = max((t.net_pl for t in ordered), default=0.0)
    metrics.largest_loss = min((t.net_pl for t in ordered), default=0.0)
    metrics.avg_hold_minutes = statistics.fmean(
        [t.duration_minutes for t in ordered]
    )
    metrics.avg_volume = statistics.fmean([t.volume for t in ordered])

    longs = [t for t in ordered if t.direction == "Long"]
    shorts = [t for t in ordered if t.direction == "Short"]
    metrics.longs = len(longs)
    metrics.shorts = len(shorts)
    if longs:
        metrics.long_win_rate = (
            sum(1 for t in longs if t.outcome == "Win") / len(longs) * 100.0
        )
    if shorts:
        metrics.short_win_rate = (
            sum(1 for t in shorts if t.outcome == "Win") / len(shorts) * 100.0
        )

    days = daily_pnl(ordered)
    metrics.logged_days = len(days)
    if days:
        winning_days = sum(1 for pnl in days.values() if pnl > 0)
        metrics.day_win_rate = winning_days / len(days) * 100.0

    metrics.max_drawdown, metrics.max_drawdown_pct, metrics.avg_drawdown = (
        drawdown_series(ordered, starting_balance)
    )
    metrics.recovery_factor = (
        metrics.net_pl / metrics.max_drawdown if metrics.max_drawdown > 0 else None
    )

    daily_values = [days[key] for key in sorted(days)]
    metrics.consistency = score_consistency(daily_values)

    (
        metrics.max_consecutive_wins,
        metrics.max_consecutive_losses,
        metrics.current_streak,
    ) = _streaks([t.outcome for t in ordered])

    # --- Composite score -------------------------------------------------
    metrics.score_profit_factor = score_profit_factor(metrics.profit_factor)
    metrics.score_avg_win_loss = score_avg_win_loss(metrics.avg_win_loss)
    metrics.score_max_drawdown = score_max_drawdown(metrics.max_drawdown_pct)
    metrics.score_win_rate = score_win_rate(metrics.win_rate)
    metrics.score_recovery_factor = score_recovery_factor(metrics.recovery_factor)
    metrics.score_consistency = metrics.consistency

    metrics.zella_score = round(
        metrics.score_profit_factor * WEIGHTS["profit_factor"]
        + metrics.score_avg_win_loss * WEIGHTS["avg_win_loss"]
        + metrics.score_max_drawdown * WEIGHTS["max_drawdown"]
        + metrics.score_win_rate * WEIGHTS["win_rate"]
        + metrics.score_recovery_factor * WEIGHTS["recovery_factor"]
        + metrics.score_consistency * WEIGHTS["consistency"],
        1,
    )

    return metrics


def group_by(
    trades: Sequence[Trade], key
) -> dict[str, list[Trade]]:
    """Bucket trades by an arbitrary key function, skipping empty keys."""
    out: dict[str, list[Trade]] = defaultdict(list)
    for trade in trades:
        value = key(trade)
        if value in (None, ""):
            continue
        out[str(value)].append(trade)
    return dict(out)
