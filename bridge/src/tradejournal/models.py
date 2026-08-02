"""Domain model for a round-turn MT5 position and its derived journal fields."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

WEEKDAYS = (
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
)


def _f(value: Any, default: float = 0.0) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return default if math.isnan(out) or math.isinf(out) else out


def _parse_naive(value: str) -> datetime:
    """Parse the EA's `YYYY-MM-DDTHH:MM:SS` broker-local timestamp."""
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S")


@dataclass
class Account:
    login: int
    server: str = ""
    company: str = ""
    currency: str = "USD"
    balance: float = 0.0
    equity: float = 0.0
    name: str = ""
    is_demo: bool = False

    @property
    def display_name(self) -> str:
        broker = self.company or self.server or "MT5"
        return f"{broker} · {self.login}"


@dataclass
class Trade:
    """A closed position, normalised to UTC and enriched with journal metrics."""

    position_id: int
    symbol: str
    direction: str  # "Long" | "Short"
    volume: float
    open_time: datetime  # tz-aware UTC
    close_time: datetime  # tz-aware UTC
    entry_price: float
    exit_price: float
    stop_loss: float
    take_profit: float
    gross_pl: float
    commission: float
    swap: float
    fee: float
    net_pl: float
    mae: float
    mfe: float
    magic: int
    comment: str
    digits: int
    tick_size: float
    tick_value: float
    screenshot: str | None = None
    account_login: int | None = None

    # Filled in by :meth:`enrich`
    risk_amount: float = 0.0
    risk_is_estimated: bool = False
    planned_r: float | None = None
    realized_r: float | None = None
    return_pct: float | None = None
    outcome: str = "Breakeven"
    session: str = "Off Hours"
    day_of_week: str = "Monday"
    hour: int = 0
    local_open: datetime | None = None

    # ------------------------------------------------------------------
    @property
    def sign(self) -> int:
        return 1 if self.direction == "Long" else -1

    @property
    def duration_minutes(self) -> float:
        return max(0.0, (self.close_time - self.open_time).total_seconds() / 60.0)

    @property
    def costs(self) -> float:
        return self.commission + self.swap + self.fee

    @property
    def trade_date(self):
        """Calendar date the trade is journalled under, in the user's timezone."""
        return (self.local_open or self.open_time).date()

    @property
    def title(self) -> str:
        stamp = (self.local_open or self.open_time).strftime("%Y-%m-%d %H:%M")
        return f"{self.symbol} {self.direction} · {stamp}"

    # ------------------------------------------------------------------
    def price_to_money(self, price_delta: float) -> float:
        """Convert an absolute price distance into account currency."""
        if self.tick_size <= 0 or self.tick_value <= 0:
            return 0.0
        return abs(price_delta) / self.tick_size * self.tick_value * self.volume

    def enrich(
        self,
        *,
        tz: ZoneInfo,
        sessions: dict[str, tuple[int, int]],
        breakeven_threshold: float,
        default_risk_pct: float,
        balance_at_open: float | None = None,
    ) -> "Trade":
        """Compute R-multiples, outcome, session and calendar fields."""
        self.local_open = self.open_time.astimezone(tz)
        self.hour = self.local_open.hour
        self.day_of_week = WEEKDAYS[self.local_open.weekday()]
        self.session = classify_session(self.open_time, sessions)

        if self.net_pl > breakeven_threshold:
            self.outcome = "Win"
        elif self.net_pl < -breakeven_threshold:
            self.outcome = "Loss"
        else:
            self.outcome = "Breakeven"

        # Initial risk: distance from entry to the original stop, in money.
        if self.stop_loss > 0 and self.entry_price > 0:
            self.risk_amount = self.price_to_money(self.entry_price - self.stop_loss)
            self.risk_is_estimated = False
        elif balance_at_open:
            # No stop was attached. Fall back to the configured risk budget so
            # R-multiples stay comparable, and flag it as an estimate.
            self.risk_amount = abs(balance_at_open) * default_risk_pct
            self.risk_is_estimated = True
        else:
            self.risk_amount = 0.0
            self.risk_is_estimated = True

        if self.risk_amount > 0:
            self.realized_r = self.net_pl / self.risk_amount
        else:
            self.realized_r = None

        if self.stop_loss > 0 and self.take_profit > 0 and self.entry_price > 0:
            risk_dist = abs(self.entry_price - self.stop_loss)
            reward_dist = abs(self.take_profit - self.entry_price)
            self.planned_r = (reward_dist / risk_dist) if risk_dist > 0 else None
        else:
            self.planned_r = None

        if balance_at_open:
            self.return_pct = self.net_pl / balance_at_open

        return self

    # ------------------------------------------------------------------
    @classmethod
    def from_ea_payload(cls, payload: dict[str, Any]) -> "Trade":
        """Build a Trade from the JSON the Expert Advisor spools to disk."""
        body = payload["trade"]
        offset_minutes = int(payload.get("server_utc_offset_minutes", 0))
        offset = timedelta(minutes=offset_minutes)

        def to_utc(raw: str) -> datetime:
            return (_parse_naive(raw) - offset).replace(tzinfo=timezone.utc)

        account = payload.get("account", {})
        screenshot = (body.get("screenshot") or "").strip()

        return cls(
            position_id=int(body["position_id"]),
            symbol=str(body["symbol"]),
            direction="Long" if str(body.get("direction")) == "Long" else "Short",
            volume=_f(body.get("volume")),
            open_time=to_utc(body["open_time"]),
            close_time=to_utc(body["close_time"]),
            entry_price=_f(body.get("entry_price")),
            exit_price=_f(body.get("exit_price")),
            stop_loss=_f(body.get("stop_loss")),
            take_profit=_f(body.get("take_profit")),
            gross_pl=_f(body.get("gross_pl")),
            commission=_f(body.get("commission")),
            swap=_f(body.get("swap")),
            fee=_f(body.get("fee")),
            net_pl=_f(body.get("net_pl")),
            mae=_f(body.get("mae")),
            mfe=_f(body.get("mfe")),
            magic=int(_f(body.get("magic"))),
            comment=str(body.get("comment") or ""),
            digits=int(_f(body.get("digits"), 5)),
            tick_size=_f(body.get("tick_size")),
            tick_value=_f(body.get("tick_value")),
            screenshot=screenshot or None,
            account_login=int(_f(account.get("login"))) or None,
        )


def classify_session(when: datetime, sessions: dict[str, tuple[int, int]]) -> str:
    """Map a UTC timestamp to a named trading session."""
    hour = when.astimezone(timezone.utc).hour
    for name, (start, end) in sessions.items():
        if start <= end:
            if start <= hour < end:
                return name
        else:  # window wraps midnight
            if hour >= start or hour < end:
                return name
    return "Off Hours"
