"""Optional full-history import via the MetaTrader5 Python package.

The EA is the live path and the only source of screenshots. This module exists
for the initial backfill — pulling years of closed positions in one pass — and
for reconciling anything the EA might have missed.

The `MetaTrader5` package is Windows-only. Every entry point here degrades
gracefully when it is unavailable.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from .models import Account, Trade

log = logging.getLogger(__name__)

# Deal entry directions
_ENTRY_IN = 0
_ENTRY_OUT = 1
_ENTRY_INOUT = 2
_ENTRY_OUT_BY = 3

# Deal types
_TYPE_BUY = 0
_TYPE_SELL = 1


class MT5Unavailable(RuntimeError):
    pass


def _import_mt5():
    try:
        import MetaTrader5 as mt5  # type: ignore
    except ImportError as exc:  # pragma: no cover - platform dependent
        raise MT5Unavailable(
            "The MetaTrader5 package is not installed. It is Windows-only; "
            "on other platforms rely on the EA spool instead."
        ) from exc
    return mt5


def connect(*, path: str | None = None) -> object:
    """Initialise the terminal connection. Caller is responsible for shutdown()."""
    mt5 = _import_mt5()
    ok = mt5.initialize(path) if path else mt5.initialize()
    if not ok:
        raise MT5Unavailable(f"mt5.initialize() failed: {mt5.last_error()}")
    return mt5


def server_utc_offset(mt5) -> timedelta:
    """Estimate the broker's UTC offset from a live tick.

    MT5 timestamps are in broker-server time with no zone attached, so we infer
    the offset and round to the nearest half hour.
    """
    symbols = mt5.symbols_get()
    if not symbols:
        return timedelta(0)

    for symbol in symbols[:50]:
        tick = mt5.symbol_info_tick(symbol.name)
        if tick and tick.time:
            delta = tick.time - datetime.now(timezone.utc).timestamp()
            half_hours = round(delta / 1800.0)
            return timedelta(seconds=half_hours * 1800)
    return timedelta(0)


def read_account(mt5) -> Account | None:
    info = mt5.account_info()
    if info is None:
        return None
    return Account(
        login=int(info.login),
        server=str(info.server),
        company=str(info.company),
        currency=str(info.currency),
        balance=float(info.balance),
        equity=float(info.equity),
        name=str(info.name),
        is_demo=int(getattr(info, "trade_mode", 0)) == 0,
    )


def fetch_closed_trades(mt5, *, days: int = 3650) -> list[Trade]:
    """Reconstruct every closed round-turn position in the window."""
    offset = server_utc_offset(mt5)
    now = datetime.now(timezone.utc) + offset
    start = now - timedelta(days=days)

    deals = mt5.history_deals_get(start, now + timedelta(days=1))
    if deals is None:
        log.warning("history_deals_get returned nothing: %s", mt5.last_error())
        return []

    grouped: dict[int, list] = defaultdict(list)
    for deal in deals:
        if deal.type not in (_TYPE_BUY, _TYPE_SELL):
            continue  # balance, credit and commission rows carry no position
        if deal.position_id:
            grouped[int(deal.position_id)].append(deal)

    trades: list[Trade] = []
    for position_id, position_deals in grouped.items():
        trade = _build_trade(mt5, position_id, position_deals, offset)
        if trade is not None:
            trades.append(trade)

    trades.sort(key=lambda t: t.close_time)
    log.info("Reconstructed %d closed position(s) from MT5 history", len(trades))
    return trades


def _build_trade(mt5, position_id: int, deals: list, offset: timedelta) -> Trade | None:
    ins = [d for d in deals if d.entry in (_ENTRY_IN, _ENTRY_INOUT)]
    outs = [d for d in deals if d.entry in (_ENTRY_OUT, _ENTRY_OUT_BY)]
    if not ins or not outs:
        return None  # still open, or the entry predates the history window

    in_volume = sum(d.volume for d in ins)
    out_volume = sum(d.volume for d in outs)
    if in_volume <= 0 or out_volume <= 0:
        return None

    first_in = min(ins, key=lambda d: d.time)
    last_out = max(outs, key=lambda d: d.time)

    entry_price = sum(d.price * d.volume for d in ins) / in_volume
    exit_price = sum(d.price * d.volume for d in outs) / out_volume

    gross = sum(d.profit for d in deals)
    commission = sum(d.commission for d in deals)
    swap = sum(d.swap for d in deals)
    fee = sum(getattr(d, "fee", 0.0) for d in deals)

    symbol = first_in.symbol
    info = mt5.symbol_info(symbol)
    digits = int(getattr(info, "digits", 5)) if info else 5
    tick_size = float(getattr(info, "trade_tick_size", 0.0)) if info else 0.0
    tick_value = float(getattr(info, "trade_tick_value", 0.0)) if info else 0.0

    stop_loss, take_profit = _order_stops(mt5, position_id)

    def to_utc(server_epoch: float) -> datetime:
        return datetime.fromtimestamp(server_epoch, tz=timezone.utc) - offset

    return Trade(
        position_id=position_id,
        symbol=symbol,
        direction="Long" if first_in.type == _TYPE_BUY else "Short",
        volume=out_volume,
        open_time=to_utc(first_in.time),
        close_time=to_utc(last_out.time),
        entry_price=entry_price,
        exit_price=exit_price,
        stop_loss=stop_loss,
        take_profit=take_profit,
        gross_pl=gross,
        commission=commission,
        swap=swap,
        fee=fee,
        net_pl=gross + commission + swap + fee,
        mae=0.0,  # not reconstructable without tick data; the EA fills this live
        mfe=0.0,
        magic=int(getattr(first_in, "magic", 0)),
        comment=str(getattr(first_in, "comment", "") or ""),
        digits=digits,
        tick_size=tick_size,
        tick_value=tick_value,
        screenshot=None,
    )


def _order_stops(mt5, position_id: int) -> tuple[float, float]:
    """Read the original stop and target from the position's orders."""
    orders = mt5.history_orders_get(position=position_id)
    if not orders:
        return 0.0, 0.0

    ordered = sorted(orders, key=lambda o: o.time_setup)
    stop = float(ordered[0].sl or 0.0)
    target = float(ordered[0].tp or 0.0)

    # A stop attached after entry is still better than none.
    for order in ordered:
        if stop == 0.0 and order.sl:
            stop = float(order.sl)
        if target == 0.0 and order.tp:
            target = float(order.tp)
    return stop, target
