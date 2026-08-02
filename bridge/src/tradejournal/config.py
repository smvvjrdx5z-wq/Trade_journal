"""Configuration loaded from environment / .env file."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from zoneinfo import ZoneInfo

# Session windows in UTC, expressed as (start_hour, end_hour). A window whose
# start is greater than its end wraps around midnight.
DEFAULT_SESSIONS: dict[str, tuple[int, int]] = {
    "Asia": (23, 7),
    "London": (7, 12),
    "New York": (12, 16),
    "London Close": (16, 20),
    "Off Hours": (20, 23),
}


def _env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name, default)
    if value is not None:
        value = value.strip()
    return value or None


def _required(name: str) -> str:
    value = _env(name)
    if not value:
        raise ConfigError(
            f"{name} is not set. Copy .env.example to .env and fill it in."
        )
    return value


def _float(name: str, default: float) -> float:
    raw = _env(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be a number, got {raw!r}") from exc


def _int(name: str, default: int) -> int:
    raw = _env(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be a whole number, got {raw!r}") from exc


def _bool(name: str, default: bool) -> bool:
    raw = _env(name)
    if raw is None:
        return default
    return raw.lower() in {"1", "true", "yes", "on"}


class ConfigError(RuntimeError):
    """Raised when the environment is missing or malformed."""


@dataclass(frozen=True)
class Config:
    notion_token: str
    trades_db: str
    accounts_db: str
    daily_db: str
    playbooks_db: str
    tags_db: str
    performance_db: str

    spool_dir: Path
    processed_dir: Path
    state_file: Path

    # Risk model
    default_risk_pct: float
    """Fraction of balance assumed at risk when a trade carried no stop loss."""
    breakeven_threshold: float
    """Absolute net P&L below which a trade counts as breakeven, in account currency."""

    # Presentation
    timezone: ZoneInfo
    sessions: dict[str, tuple[int, int]]
    min_sample_size: int

    poll_seconds: int
    notion_version: str
    dry_run: bool

    @staticmethod
    def load() -> "Config":
        spool = Path(_required("BRIDGE_SPOOL_DIR")).expanduser()
        tz_name = _env("BRIDGE_TIMEZONE", "UTC") or "UTC"
        try:
            tz = ZoneInfo(tz_name)
        except Exception as exc:  # noqa: BLE001 - surface a clear message
            raise ConfigError(f"BRIDGE_TIMEZONE {tz_name!r} is not a valid zone") from exc

        return Config(
            notion_token=_required("NOTION_TOKEN"),
            trades_db=_required("NOTION_TRADES_DB"),
            accounts_db=_required("NOTION_ACCOUNTS_DB"),
            daily_db=_required("NOTION_DAILY_DB"),
            playbooks_db=_required("NOTION_PLAYBOOKS_DB"),
            tags_db=_required("NOTION_TAGS_DB"),
            performance_db=_required("NOTION_PERFORMANCE_DB"),
            spool_dir=spool,
            processed_dir=spool / "processed",
            state_file=spool / "bridge_state.json",
            default_risk_pct=_float("BRIDGE_DEFAULT_RISK_PCT", 0.01),
            breakeven_threshold=_float("BRIDGE_BREAKEVEN_THRESHOLD", 0.5),
            timezone=tz,
            sessions=dict(DEFAULT_SESSIONS),
            min_sample_size=_int("BRIDGE_MIN_SAMPLE_SIZE", 20),
            poll_seconds=_int("BRIDGE_POLL_SECONDS", 5),
            notion_version=_env("NOTION_VERSION", "2022-06-28") or "2022-06-28",
            dry_run=_bool("BRIDGE_DRY_RUN", False),
        )


def load_dotenv(path: Path | None = None) -> None:
    """Minimal .env loader so the bridge has no hard dependency on python-dotenv."""
    candidate = path or Path.cwd() / ".env"
    if not candidate.is_file():
        return
    for raw_line in candidate.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        # Real environment variables always win over the file.
        os.environ.setdefault(key, value)
