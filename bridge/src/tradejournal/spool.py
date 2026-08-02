"""Reads the JSON payloads the Expert Advisor drops on disk."""

from __future__ import annotations

import json
import logging
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

log = logging.getLogger(__name__)


@dataclass
class SpoolItem:
    path: Path
    payload: dict

    @property
    def screenshot_name(self) -> str | None:
        name = (self.payload.get("trade", {}).get("screenshot") or "").strip()
        return name or None


class Spool:
    """Directory queue shared with the EA.

    The EA only ever writes; the bridge only ever reads and then archives. That
    keeps the two processes decoupled — if the bridge is offline, trades simply
    queue up on disk and drain on the next run.
    """

    def __init__(self, spool_dir: Path, processed_dir: Path):
        self.dir = spool_dir
        self.processed = processed_dir

    def ensure(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        self.processed.mkdir(parents=True, exist_ok=True)

    def pending(self) -> Iterator[SpoolItem]:
        """Yield unprocessed trade payloads, oldest first."""
        if not self.dir.is_dir():
            return
        for path in sorted(self.dir.glob("trade_*.json")):
            try:
                payload = json.loads(path.read_text(encoding="utf-8-sig"))
            except (OSError, json.JSONDecodeError) as exc:
                # A half-written file will parse next pass; only warn once it is stale.
                log.debug("Skipping %s for now: %s", path.name, exc)
                continue
            if payload.get("type") != "trade":
                continue
            yield SpoolItem(path=path, payload=payload)

    def account_snapshot(self) -> dict | None:
        path = self.dir / "account.json"
        if not path.is_file():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            return None

    def screenshot_path(self, name: str) -> Path:
        return self.dir / name

    def archive(self, item: SpoolItem) -> None:
        """Move a handled payload (and its screenshot) out of the live queue."""
        self.processed.mkdir(parents=True, exist_ok=True)
        try:
            shutil.move(str(item.path), str(self.processed / item.path.name))
        except OSError as exc:
            log.warning("Could not archive %s: %s", item.path.name, exc)

        shot = item.screenshot_name
        if shot:
            source = self.screenshot_path(shot)
            if source.is_file():
                try:
                    shutil.move(str(source), str(self.processed / source.name))
                except OSError as exc:
                    log.debug("Could not archive screenshot %s: %s", shot, exc)
