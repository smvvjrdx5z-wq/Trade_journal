"""Local JSON cache of every synced trade.

Analytics run against this cache rather than reading back from Notion, so a
dashboard refresh costs no API calls and stays correct even if someone edits a
number by hand in Notion.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from .models import Trade

log = logging.getLogger(__name__)

_DATETIME_FIELDS = ("open_time", "close_time")
_SKIP_FIELDS = {"local_open"}


def _serialize(trade: Trade) -> dict:
    data = {}
    for key, value in vars(trade).items():
        if key in _SKIP_FIELDS:
            continue
        if isinstance(value, datetime):
            data[key] = value.isoformat()
        else:
            data[key] = value
    return data


def _deserialize(data: dict) -> Trade:
    payload = dict(data)
    for key in _DATETIME_FIELDS:
        raw = payload.get(key)
        if isinstance(raw, str):
            parsed = datetime.fromisoformat(raw)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            payload[key] = parsed

    valid = {f for f in Trade.__dataclass_fields__}  # type: ignore[attr-defined]
    return Trade(**{k: v for k, v in payload.items() if k in valid})


class TradeStore:
    def __init__(self, path: Path):
        self.path = path
        self._trades: dict[int, Trade] = {}
        self._page_ids: dict[int, str] = {}
        self.starting_balance: float | None = None
        self.load()

    # ------------------------------------------------------------------
    def load(self) -> None:
        if not self.path.is_file():
            return
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            log.warning("Could not read cache %s: %s — starting empty", self.path, exc)
            return

        for item in raw.get("trades", []):
            try:
                trade = _deserialize(item)
            except Exception as exc:  # noqa: BLE001 - one bad row must not kill the run
                log.warning("Skipping unreadable cached trade: %s", exc)
                continue
            self._trades[trade.position_id] = trade

        self._page_ids = {int(k): v for k, v in raw.get("page_ids", {}).items()}
        self.starting_balance = raw.get("starting_balance")
        log.info("Loaded %d cached trade(s)", len(self._trades))

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": 1,
            "saved_at": datetime.now(timezone.utc).isoformat(),
            "starting_balance": self.starting_balance,
            "page_ids": {str(k): v for k, v in self._page_ids.items()},
            "trades": [_serialize(t) for t in self._trades.values()],
        }
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        tmp.replace(self.path)

    # ------------------------------------------------------------------
    def add(self, trade: Trade) -> None:
        self._trades[trade.position_id] = trade

    def add_many(self, trades: Iterable[Trade]) -> int:
        added = 0
        for trade in trades:
            if trade.position_id not in self._trades:
                added += 1
            self._trades[trade.position_id] = trade
        return added

    def has(self, position_id: int) -> bool:
        return position_id in self._trades

    def page_id(self, position_id: int) -> str | None:
        return self._page_ids.get(position_id)

    def set_page_id(self, position_id: int, page_id: str) -> None:
        self._page_ids[position_id] = page_id

    # ------------------------------------------------------------------
    @property
    def trades(self) -> list[Trade]:
        return sorted(self._trades.values(), key=lambda t: t.close_time)

    def on_date(self, day) -> list[Trade]:
        return [t for t in self._trades.values() if t.trade_date == day]

    def total_net(self) -> float:
        return sum(t.net_pl for t in self._trades.values())

    def balance_at_open(self, trade: Trade, starting_balance: float) -> float:
        """Account balance immediately before this trade was opened."""
        prior = sum(
            t.net_pl
            for t in self._trades.values()
            if t.close_time <= trade.open_time and t.position_id != trade.position_id
        )
        return starting_balance + prior

    def infer_starting_balance(self, current_balance: float) -> float:
        """Derive the opening balance from the current balance and known P&L.

        Assumes no deposits or withdrawals; override with BRIDGE_STARTING_BALANCE
        when that is not true.
        """
        return current_balance - self.total_net()
