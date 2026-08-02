"""Command line entry point for the sync bridge."""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from .config import Config, ConfigError, load_dotenv
from .sync import Journal


def _configure_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s  %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )
    logging.getLogger("urllib3").setLevel(logging.WARNING)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="tradejournal",
        description="Sync MetaTrader 5 trades and 4H chart screenshots into Notion.",
    )
    parser.add_argument("--env", type=Path, help="Path to a .env file")
    parser.add_argument("-v", "--verbose", action="store_true")

    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("watch", help="Run continuously, syncing trades as they close")
    sub.add_parser("sync", help="Drain the spool once and exit")
    sub.add_parser("refresh", help="Recompute the dashboard from cached trades")
    sub.add_parser("doctor", help="Check configuration and connectivity")

    imp = sub.add_parser("import", help="Backfill history from the terminal (Windows only)")
    imp.add_argument("--days", type=int, default=3650, help="How far back to import")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    _configure_logging(args.verbose)

    load_dotenv(args.env)

    try:
        cfg = Config.load()
    except ConfigError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 2

    if cfg.dry_run:
        logging.warning("BRIDGE_DRY_RUN is on — nothing will be written to Notion")

    journal = Journal(cfg)

    if args.command == "doctor":
        return _doctor(cfg, journal)

    try:
        if args.command == "watch":
            journal.watch()
        elif args.command == "sync":
            count = journal.run_once()
            print(f"Synced {count} trade(s)")
        elif args.command == "refresh":
            journal.refresh_dashboard()
            print("Dashboard refreshed")
        elif args.command == "import":
            count = journal.import_history(days=args.days)
            print(f"Imported {count} trade(s)")
    except KeyboardInterrupt:
        print("\nStopped")
        return 0

    return 0


def _doctor(cfg: Config, journal: Journal) -> int:
    ok = True

    print(f"Spool directory : {cfg.spool_dir}")
    if cfg.spool_dir.is_dir():
        pending = len(list(cfg.spool_dir.glob("trade_*.json")))
        print(f"                  exists, {pending} pending payload(s)")
    else:
        print("                  MISSING — attach the EA once to create it")
        ok = False

    print(f"Timezone        : {cfg.timezone}")
    print(f"Cached trades   : {len(journal.store.trades)}")

    checks = {
        "Trades": cfg.trades_db,
        "Accounts": cfg.accounts_db,
        "Daily Journal": cfg.daily_db,
        "Playbooks": cfg.playbooks_db,
        "Tags": cfg.tags_db,
        "Performance": cfg.performance_db,
    }
    for name, db_id in checks.items():
        try:
            next(journal.notion.query(db_id, {"page_size": 1}), None)
            print(f"Notion {name:<14}: reachable")
        except Exception as exc:  # noqa: BLE001
            print(f"Notion {name:<14}: FAILED — {exc}")
            ok = False

    print("\nAll good." if ok else "\nSome checks failed.")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
