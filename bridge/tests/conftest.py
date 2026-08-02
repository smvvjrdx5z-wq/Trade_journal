from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from tradejournal.config import DEFAULT_SESSIONS
from tradejournal.models import Trade

UTC = timezone.utc


def make_trade(
    *,
    position_id: int = 1,
    symbol: str = "XAUUSD",
    direction: str = "Long",
    net_pl: float = 100.0,
    open_time: datetime | None = None,
    hold_minutes: int = 60,
    entry_price: float = 2000.0,
    stop_loss: float = 1990.0,
    take_profit: float = 2030.0,
    volume: float = 1.0,
    tick_size: float = 0.01,
    tick_value: float = 0.01,
    commission: float = 0.0,
    swap: float = 0.0,
    enrich: bool = True,
    balance_at_open: float | None = 10_000.0,
) -> Trade:
    """Build a Trade with sane defaults.

    With the default tick sizing, one price unit equals one currency unit per
    lot, so a 10-point stop on 1 lot is exactly 10.0 of risk.
    """
    start = open_time or datetime(2026, 3, 2, 9, 0, tzinfo=UTC)
    trade = Trade(
        position_id=position_id,
        symbol=symbol,
        direction=direction,
        volume=volume,
        open_time=start,
        close_time=start + timedelta(minutes=hold_minutes),
        entry_price=entry_price,
        exit_price=entry_price + (net_pl / 10.0 if direction == "Long" else -net_pl / 10.0),
        stop_loss=stop_loss,
        take_profit=take_profit,
        gross_pl=net_pl - commission - swap,
        commission=commission,
        swap=swap,
        fee=0.0,
        net_pl=net_pl,
        mae=0.0,
        mfe=0.0,
        magic=0,
        comment="",
        digits=2,
        tick_size=tick_size,
        tick_value=tick_value,
    )
    if enrich:
        trade.enrich(
            tz=ZoneInfo("UTC"),
            sessions=DEFAULT_SESSIONS,
            breakeven_threshold=0.5,
            default_risk_pct=0.01,
            balance_at_open=balance_at_open,
        )
    return trade


@pytest.fixture
def trade_factory():
    return make_trade
