from __future__ import annotations

import json
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import pytest

from tradejournal.config import DEFAULT_SESSIONS
from tradejournal.models import Trade, classify_session
from tradejournal.store import TradeStore

from conftest import make_trade

UTC = timezone.utc


def ea_payload(**overrides) -> dict:
    trade = {
        "position_id": 987654,
        "symbol": "XAUUSD",
        "direction": "Long",
        "volume": 0.5,
        "open_time": "2026-03-02T11:00:00",
        "close_time": "2026-03-02T14:30:00",
        "entry_price": 2000.00,
        "exit_price": 2015.00,
        "stop_loss": 1990.00,
        "take_profit": 2030.00,
        "gross_pl": 750.0,
        "commission": -7.0,
        "swap": -1.0,
        "fee": 0.0,
        "net_pl": 742.0,
        "mae": -45.0,
        "mfe": 810.0,
        "magic": 0,
        "comment": "manual",
        "digits": 2,
        "point": 0.01,
        "tick_size": 0.01,
        "tick_value": 0.01,
        "screenshot": "trade_987654_h4.png",
    }
    trade.update(overrides.pop("trade", {}))
    payload = {
        "schema": 1,
        "type": "trade",
        "server_utc_offset_minutes": 120,  # broker runs UTC+2
        "account": {"login": 12345, "currency": "USD", "balance": 10_000.0},
        "trade": trade,
    }
    payload.update(overrides)
    return payload


class TestFromEaPayload:
    def test_converts_broker_time_to_utc(self):
        trade = Trade.from_ea_payload(ea_payload())
        # 11:00 broker time at UTC+2 is 09:00 UTC.
        assert trade.open_time == datetime(2026, 3, 2, 9, 0, tzinfo=UTC)
        assert trade.close_time == datetime(2026, 3, 2, 12, 30, tzinfo=UTC)

    def test_handles_a_utc_broker(self):
        payload = ea_payload()
        payload["server_utc_offset_minutes"] = 0
        trade = Trade.from_ea_payload(payload)
        assert trade.open_time == datetime(2026, 3, 2, 11, 0, tzinfo=UTC)

    def test_handles_a_negative_offset(self):
        payload = ea_payload()
        payload["server_utc_offset_minutes"] = -300  # UTC-5
        trade = Trade.from_ea_payload(payload)
        assert trade.open_time == datetime(2026, 3, 2, 16, 0, tzinfo=UTC)

    def test_reads_core_fields(self):
        trade = Trade.from_ea_payload(ea_payload())
        assert trade.position_id == 987654
        assert trade.symbol == "XAUUSD"
        assert trade.direction == "Long"
        assert trade.volume == pytest.approx(0.5)
        assert trade.net_pl == pytest.approx(742.0)
        assert trade.screenshot == "trade_987654_h4.png"
        assert trade.account_login == 12345

    def test_costs_sum_commission_swap_and_fee(self):
        trade = Trade.from_ea_payload(ea_payload())
        assert trade.costs == pytest.approx(-8.0)

    def test_blank_screenshot_becomes_none(self):
        payload = ea_payload()
        payload["trade"]["screenshot"] = ""
        assert Trade.from_ea_payload(payload).screenshot is None

    def test_duration(self):
        trade = Trade.from_ea_payload(ea_payload())
        assert trade.duration_minutes == pytest.approx(210.0)

    def test_survives_a_json_round_trip(self):
        raw = json.dumps(ea_payload())
        trade = Trade.from_ea_payload(json.loads(raw))
        assert trade.position_id == 987654


class TestEnrichment:
    def _enrich(self, trade: Trade, tz: str = "UTC", balance: float | None = 10_000.0):
        return trade.enrich(
            tz=ZoneInfo(tz),
            sessions=DEFAULT_SESSIONS,
            breakeven_threshold=0.5,
            default_risk_pct=0.01,
            balance_at_open=balance,
        )

    def test_outcome_classification(self):
        assert make_trade(net_pl=100.0).outcome == "Win"
        assert make_trade(net_pl=-100.0).outcome == "Loss"
        assert make_trade(net_pl=0.2).outcome == "Breakeven"
        assert make_trade(net_pl=-0.2).outcome == "Breakeven"

    def test_short_risk_uses_absolute_distance(self):
        trade = make_trade(
            direction="Short", entry_price=2000.0, stop_loss=2010.0, net_pl=-10.0
        )
        assert trade.risk_amount == pytest.approx(10.0)
        assert trade.realized_r == pytest.approx(-1.0)

    def test_planned_r_for_a_short(self):
        trade = make_trade(
            direction="Short", entry_price=2000.0, stop_loss=2010.0, take_profit=1970.0
        )
        assert trade.planned_r == pytest.approx(3.0)

    def test_no_planned_r_without_a_target(self):
        assert make_trade(take_profit=0.0).planned_r is None

    def test_return_pct(self):
        trade = make_trade(net_pl=250.0, balance_at_open=10_000.0)
        assert trade.return_pct == pytest.approx(0.025)

    def test_local_timezone_shifts_the_journal_date(self):
        # 23:30 UTC is already the next day in Berlin.
        trade = Trade.from_ea_payload(ea_payload())
        trade.open_time = datetime(2026, 3, 2, 23, 30, tzinfo=UTC)
        trade.close_time = datetime(2026, 3, 2, 23, 45, tzinfo=UTC)
        self._enrich(trade, tz="Europe/Berlin")
        assert trade.trade_date.isoformat() == "2026-03-03"
        assert trade.day_of_week == "Tuesday"

    def test_title_uses_local_time(self):
        trade = make_trade(open_time=datetime(2026, 3, 2, 9, 0, tzinfo=UTC))
        assert trade.title == "XAUUSD Long · 2026-03-02 09:00"

    def test_zero_tick_size_does_not_divide_by_zero(self):
        trade = make_trade(tick_size=0.0, tick_value=0.0, balance_at_open=None)
        assert trade.risk_amount == 0.0
        assert trade.realized_r is None


class TestSessions:
    @pytest.mark.parametrize(
        "hour,expected",
        [
            (2, "Asia"),
            (6, "Asia"),
            (7, "London"),
            (11, "London"),
            (12, "New York"),
            (15, "New York"),
            (16, "London Close"),
            (19, "London Close"),
            (20, "Off Hours"),
            (22, "Off Hours"),
            (23, "Asia"),  # window wraps midnight
        ],
    )
    def test_classification(self, hour, expected):
        when = datetime(2026, 3, 2, hour, 30, tzinfo=UTC)
        assert classify_session(when, DEFAULT_SESSIONS) == expected

    def test_classification_is_timezone_independent(self):
        # 09:00 UTC is London regardless of how the timestamp is expressed.
        as_utc = datetime(2026, 3, 2, 9, 0, tzinfo=UTC)
        as_tokyo = as_utc.astimezone(ZoneInfo("Asia/Tokyo"))
        assert classify_session(as_tokyo, DEFAULT_SESSIONS) == "London"


class TestTradeStore:
    def test_round_trips_through_disk(self, tmp_path):
        path = tmp_path / "cache.json"
        store = TradeStore(path)
        store.add(make_trade(position_id=1, net_pl=100.0))
        store.add(make_trade(position_id=2, net_pl=-40.0))
        store.set_page_id(1, "page-abc")
        store.starting_balance = 5_000.0
        store.save()

        reloaded = TradeStore(path)
        assert len(reloaded.trades) == 2
        assert reloaded.page_id(1) == "page-abc"
        assert reloaded.starting_balance == pytest.approx(5_000.0)
        assert reloaded.total_net() == pytest.approx(60.0)
        assert reloaded.trades[0].open_time.tzinfo is not None

    def test_add_is_idempotent_on_position_id(self, tmp_path):
        store = TradeStore(tmp_path / "cache.json")
        store.add(make_trade(position_id=7, net_pl=10.0))
        store.add(make_trade(position_id=7, net_pl=999.0))
        assert len(store.trades) == 1
        assert store.total_net() == pytest.approx(999.0)

    def test_infers_starting_balance_from_current(self, tmp_path):
        store = TradeStore(tmp_path / "cache.json")
        store.add(make_trade(position_id=1, net_pl=300.0))
        store.add(make_trade(position_id=2, net_pl=-100.0))
        assert store.infer_starting_balance(10_200.0) == pytest.approx(10_000.0)

    def test_balance_at_open_counts_only_earlier_trades(self, tmp_path):
        store = TradeStore(tmp_path / "cache.json")
        first = make_trade(
            position_id=1, net_pl=500.0, open_time=datetime(2026, 3, 2, 9, 0, tzinfo=UTC)
        )
        second = make_trade(
            position_id=2, net_pl=100.0, open_time=datetime(2026, 3, 5, 9, 0, tzinfo=UTC)
        )
        store.add(first)
        store.add(second)
        assert store.balance_at_open(second, 10_000.0) == pytest.approx(10_500.0)
        assert store.balance_at_open(first, 10_000.0) == pytest.approx(10_000.0)

    def test_missing_cache_file_is_not_an_error(self, tmp_path):
        assert TradeStore(tmp_path / "nope.json").trades == []

    def test_corrupt_cache_falls_back_to_empty(self, tmp_path):
        path = tmp_path / "cache.json"
        path.write_text("{not json", encoding="utf-8")
        assert TradeStore(path).trades == []

    def test_on_date_filters(self, tmp_path):
        store = TradeStore(tmp_path / "cache.json")
        store.add(make_trade(position_id=1, open_time=datetime(2026, 3, 2, 9, 0, tzinfo=UTC)))
        store.add(make_trade(position_id=2, open_time=datetime(2026, 3, 3, 9, 0, tzinfo=UTC)))
        from datetime import date

        assert len(store.on_date(date(2026, 3, 2))) == 1
