from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from tradejournal import analytics
from tradejournal.analytics import (
    WEIGHTS,
    compute,
    drawdown_series,
    score_avg_win_loss,
    score_consistency,
    score_max_drawdown,
    score_profit_factor,
    score_recovery_factor,
    score_win_rate,
)

from conftest import make_trade

UTC = timezone.utc


class TestComponentScores:
    def test_weights_sum_to_one(self):
        assert pytest.approx(sum(WEIGHTS.values())) == 1.0

    @pytest.mark.parametrize(
        "profit_factor,expected",
        [
            (3.0, 100.0),   # at or above the top band
            (2.6, 100.0),   # band boundary
            (1.8, 50.0),    # bottom of the graded range
            (1.4, 20.0),    # TradeZella's flat "below 1.8" floor
        ],
    )
    def test_profit_factor_bands(self, profit_factor, expected):
        assert score_profit_factor(profit_factor) == pytest.approx(expected, abs=0.5)

    def test_profit_factor_below_one_ramps_to_zero(self):
        # A losing system must not tie with a nearly-profitable one.
        assert score_profit_factor(0.2) < score_profit_factor(1.4)
        assert score_profit_factor(0.0) == 0.0

    def test_profit_factor_is_monotonic(self):
        values = [0.0, 0.5, 1.0, 1.5, 1.85, 1.95, 2.1, 2.3, 2.5, 2.6, 5.0]
        scores = [score_profit_factor(v) for v in values]
        assert scores == sorted(scores)

    def test_none_profit_factor_scores_zero(self):
        assert score_profit_factor(None) == 0.0

    def test_avg_win_loss_uses_same_ladder(self):
        assert score_avg_win_loss(2.6) == score_profit_factor(2.6)

    def test_win_rate_caps_at_top_threshold(self):
        assert score_win_rate(60.0) == pytest.approx(100.0)
        assert score_win_rate(75.0) == pytest.approx(100.0)
        assert score_win_rate(30.0) == pytest.approx(50.0)

    def test_max_drawdown_is_inverted(self):
        assert score_max_drawdown(0.0) == 100.0
        assert score_max_drawdown(25.0) == 75.0
        assert score_max_drawdown(140.0) == 0.0

    @pytest.mark.parametrize(
        "recovery,expected",
        [(4.0, 100.0), (3.5, 100.0), (3.0, 70.0), (2.5, 60.0), (2.0, 50.0), (0.5, 0.0)],
    )
    def test_recovery_factor_bands(self, recovery, expected):
        assert score_recovery_factor(recovery) == pytest.approx(expected, abs=0.5)

    def test_consistency_rewards_flat_daily_returns(self):
        steady = score_consistency([100.0, 100.0, 100.0, 100.0])
        lumpy = score_consistency([400.0, 5.0, 5.0, 5.0])
        assert steady == pytest.approx(100.0)
        assert lumpy < steady

    def test_consistency_is_zero_when_unprofitable(self):
        assert score_consistency([-10.0, 5.0, -20.0]) == 0.0

    def test_consistency_needs_two_days(self):
        assert score_consistency([100.0]) == 0.0


class TestDrawdown:
    def test_measures_peak_to_trough(self):
        base = datetime(2026, 3, 2, 9, 0, tzinfo=UTC)
        trades = [
            make_trade(position_id=1, net_pl=500.0, open_time=base),
            make_trade(position_id=2, net_pl=-200.0, open_time=base + timedelta(days=1)),
            make_trade(position_id=3, net_pl=-100.0, open_time=base + timedelta(days=2)),
            make_trade(position_id=4, net_pl=400.0, open_time=base + timedelta(days=3)),
        ]
        max_dd, max_dd_pct, avg_dd = drawdown_series(trades, starting_balance=10_000.0)

        # Peak 10,500 then down to 10,200 -> 300 drawdown.
        assert max_dd == pytest.approx(300.0)
        assert max_dd_pct == pytest.approx(300.0 / 10_500.0 * 100.0)
        assert avg_dd == pytest.approx(250.0)  # mean of the 200 and 300 observations

    def test_no_drawdown_on_a_pure_winner(self):
        trades = [make_trade(position_id=1, net_pl=100.0)]
        max_dd, pct, avg = drawdown_series(trades, starting_balance=1000.0)
        assert (max_dd, pct, avg) == (0.0, 0.0, 0.0)

    def test_empty_input(self):
        assert drawdown_series([], starting_balance=1000.0) == (0.0, 0.0, 0.0)


class TestCompute:
    def _mixed_book(self):
        base = datetime(2026, 3, 2, 9, 0, tzinfo=UTC)
        return [
            make_trade(position_id=1, net_pl=300.0, open_time=base),
            make_trade(position_id=2, net_pl=-100.0, open_time=base + timedelta(days=1)),
            make_trade(position_id=3, net_pl=200.0, open_time=base + timedelta(days=2)),
            make_trade(position_id=4, net_pl=-100.0, open_time=base + timedelta(days=3)),
        ]

    def test_core_aggregates(self):
        m = compute(self._mixed_book(), starting_balance=10_000.0, min_sample_size=2)

        assert m.trade_count == 4
        assert m.winners == 2
        assert m.losers == 2
        assert m.net_pl == pytest.approx(300.0)
        assert m.gross_profit == pytest.approx(500.0)
        assert m.gross_loss == pytest.approx(200.0)
        assert m.profit_factor == pytest.approx(2.5)
        assert m.win_rate == pytest.approx(50.0)
        assert m.avg_win == pytest.approx(250.0)
        assert m.avg_loss == pytest.approx(100.0)
        assert m.avg_win_loss == pytest.approx(2.5)
        assert m.largest_win == pytest.approx(300.0)
        assert m.largest_loss == pytest.approx(-100.0)

    def test_expectancy_matches_the_textbook_formula(self):
        m = compute(self._mixed_book(), starting_balance=10_000.0)
        expected = 0.5 * 250.0 - 0.5 * 100.0
        assert m.expectancy == pytest.approx(expected)
        # Expectancy times trade count must reconcile with net P&L.
        assert m.expectancy * m.trade_count == pytest.approx(m.net_pl)

    def test_r_multiples(self):
        # Default fixture risk is 10 price units on 1 lot at tick value 0.01/0.01 => 10.0
        trade = make_trade(position_id=1, net_pl=20.0)
        assert trade.risk_amount == pytest.approx(10.0)
        assert trade.realized_r == pytest.approx(2.0)
        assert trade.planned_r == pytest.approx(3.0)

        m = compute([trade], starting_balance=10_000.0)
        assert m.total_r == pytest.approx(2.0)
        assert m.avg_r == pytest.approx(2.0)

    def test_risk_falls_back_to_percentage_without_a_stop(self):
        trade = make_trade(position_id=1, net_pl=50.0, stop_loss=0.0, balance_at_open=10_000.0)
        assert trade.risk_is_estimated is True
        assert trade.risk_amount == pytest.approx(100.0)  # 1% of 10,000
        assert trade.realized_r == pytest.approx(0.5)

    def test_day_win_rate_groups_by_calendar_day(self):
        base = datetime(2026, 3, 2, 9, 0, tzinfo=UTC)
        trades = [
            # Day one nets positive despite holding a loser.
            make_trade(position_id=1, net_pl=300.0, open_time=base),
            make_trade(position_id=2, net_pl=-100.0, open_time=base + timedelta(hours=2)),
            # Day two nets negative.
            make_trade(position_id=3, net_pl=-50.0, open_time=base + timedelta(days=1)),
        ]
        m = compute(trades, starting_balance=10_000.0)
        assert m.logged_days == 2
        assert m.day_win_rate == pytest.approx(50.0)
        assert m.win_rate == pytest.approx(1 / 3 * 100.0)

    def test_streaks(self):
        base = datetime(2026, 3, 2, 9, 0, tzinfo=UTC)
        pattern = [100.0, 100.0, 100.0, -50.0, -50.0, 100.0]
        trades = [
            make_trade(position_id=i, net_pl=pnl, open_time=base + timedelta(days=i))
            for i, pnl in enumerate(pattern, start=1)
        ]
        m = compute(trades, starting_balance=10_000.0)
        assert m.max_consecutive_wins == 3
        assert m.max_consecutive_losses == 2
        assert m.current_streak == 1

    def test_losing_streak_reports_negative_current_streak(self):
        base = datetime(2026, 3, 2, 9, 0, tzinfo=UTC)
        trades = [
            make_trade(position_id=1, net_pl=100.0, open_time=base),
            make_trade(position_id=2, net_pl=-50.0, open_time=base + timedelta(days=1)),
            make_trade(position_id=3, net_pl=-50.0, open_time=base + timedelta(days=2)),
        ]
        assert compute(trades, starting_balance=10_000.0).current_streak == -2

    def test_long_short_split(self):
        base = datetime(2026, 3, 2, 9, 0, tzinfo=UTC)
        trades = [
            make_trade(position_id=1, net_pl=100.0, direction="Long", open_time=base),
            make_trade(position_id=2, net_pl=-100.0, direction="Long", open_time=base),
            make_trade(position_id=3, net_pl=100.0, direction="Short", open_time=base),
        ]
        m = compute(trades, starting_balance=10_000.0)
        assert (m.longs, m.shorts) == (2, 1)
        assert m.long_win_rate == pytest.approx(50.0)
        assert m.short_win_rate == pytest.approx(100.0)

    def test_breakeven_trades_are_excluded_from_win_and_loss(self):
        trades = [
            make_trade(position_id=1, net_pl=0.0),
            make_trade(position_id=2, net_pl=100.0),
        ]
        m = compute(trades, starting_balance=10_000.0)
        assert m.breakeven == 1
        assert m.winners == 1
        assert m.losers == 0
        # No losses at all means profit factor is undefined, not infinite.
        assert m.profit_factor is None

    def test_empty_input_is_safe(self):
        m = compute([], starting_balance=10_000.0)
        assert m.trade_count == 0
        assert m.zella_score == 0.0
        assert m.sample_warning is True

    def test_sample_warning_clears_once_the_book_is_big_enough(self):
        base = datetime(2026, 3, 2, 9, 0, tzinfo=UTC)
        trades = [
            make_trade(position_id=i, net_pl=10.0, open_time=base + timedelta(days=i))
            for i in range(1, 26)
        ]
        assert compute(trades, min_sample_size=20).sample_warning is False
        assert compute(trades, min_sample_size=50).sample_warning is True


class TestZellaScore:
    def test_strong_book_scores_high(self):
        base = datetime(2026, 3, 2, 9, 0, tzinfo=UTC)
        trades = [
            make_trade(
                position_id=i,
                net_pl=300.0 if i % 3 else -100.0,
                open_time=base + timedelta(days=i),
            )
            for i in range(1, 31)
        ]
        m = compute(trades, starting_balance=10_000.0)
        assert m.zella_score > 70
        assert 0 <= m.zella_score <= 100

    def test_losing_book_scores_low(self):
        base = datetime(2026, 3, 2, 9, 0, tzinfo=UTC)
        trades = [
            make_trade(
                position_id=i,
                net_pl=50.0 if i % 4 == 0 else -100.0,
                open_time=base + timedelta(days=i),
            )
            for i in range(1, 31)
        ]
        m = compute(trades, starting_balance=10_000.0)
        assert m.zella_score < 35

    def test_score_is_the_weighted_sum_of_its_components(self):
        base = datetime(2026, 3, 2, 9, 0, tzinfo=UTC)
        trades = [
            make_trade(
                position_id=i,
                net_pl=250.0 if i % 2 else -100.0,
                open_time=base + timedelta(days=i),
            )
            for i in range(1, 21)
        ]
        m = compute(trades, starting_balance=10_000.0)
        expected = (
            m.score_profit_factor * WEIGHTS["profit_factor"]
            + m.score_avg_win_loss * WEIGHTS["avg_win_loss"]
            + m.score_max_drawdown * WEIGHTS["max_drawdown"]
            + m.score_win_rate * WEIGHTS["win_rate"]
            + m.score_recovery_factor * WEIGHTS["recovery_factor"]
            + m.score_consistency * WEIGHTS["consistency"]
        )
        assert m.zella_score == pytest.approx(round(expected, 1))


class TestGroupBy:
    def test_buckets_and_skips_blanks(self):
        trades = [
            make_trade(position_id=1, symbol="XAUUSD"),
            make_trade(position_id=2, symbol="XAUUSD"),
            make_trade(position_id=3, symbol="EURUSD"),
        ]
        grouped = analytics.group_by(trades, lambda t: t.symbol)
        assert set(grouped) == {"XAUUSD", "EURUSD"}
        assert len(grouped["XAUUSD"]) == 2

        assert analytics.group_by(trades, lambda t: None) == {}
