"""Orchestration: spool -> Notion, plus daily rollups and the analytics dashboard."""

from __future__ import annotations

import logging
import time
from collections import defaultdict
from datetime import date, datetime, timezone

from . import analytics, notion as N
from .config import Config
from .models import Account, Trade
from .notion import NotionClient
from .spool import Spool, SpoolItem
from .store import TradeStore

log = logging.getLogger(__name__)

GRADE_ORDER = ("A", "B", "C", "D", "F")


class Journal:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.notion = NotionClient(
            cfg.notion_token, version=cfg.notion_version, dry_run=cfg.dry_run
        )
        self.spool = Spool(cfg.spool_dir, cfg.processed_dir)
        self.store = TradeStore(cfg.state_file)
        self._account_page: str | None = None
        self._account: Account | None = None
        self._day_pages: dict[date, str] = {}

    # ==================================================================
    # Entry points
    # ==================================================================
    def run_once(self) -> int:
        """Drain the spool. Returns the number of trades synced."""
        self.spool.ensure()

        snapshot = self.spool.account_snapshot()
        if snapshot:
            self._account = _account_from_snapshot(snapshot)

        items = list(self.spool.pending())
        if not items:
            return 0

        log.info("Found %d pending trade(s)", len(items))
        account_page = self._ensure_account()
        touched_days: set[date] = set()
        synced = 0

        for item in items:
            try:
                trade = Trade.from_ea_payload(item.payload)
            except (KeyError, ValueError) as exc:
                log.error("Malformed payload %s: %s", item.path.name, exc)
                self.spool.archive(item)
                continue

            starting = self._starting_balance()
            trade.enrich(
                tz=self.cfg.timezone,
                sessions=self.cfg.sessions,
                breakeven_threshold=self.cfg.breakeven_threshold,
                default_risk_pct=self.cfg.default_risk_pct,
                balance_at_open=self.store.balance_at_open(trade, starting),
            )

            day_page = self._ensure_day(trade.trade_date, account_page)
            try:
                self._upsert_trade(trade, item, account_page, day_page)
            except Exception as exc:  # noqa: BLE001 - keep draining the queue
                log.exception("Failed to sync position %s: %s", trade.position_id, exc)
                continue

            self.store.add(trade)
            touched_days.add(trade.trade_date)
            self.spool.archive(item)
            synced += 1

        self.store.save()

        for day in sorted(touched_days):
            self._refresh_day(day, account_page)

        if synced:
            self.refresh_dashboard()
            self._update_account_page(account_page)

        return synced

    def watch(self) -> None:
        log.info("Watching %s every %ss (Ctrl-C to stop)", self.cfg.spool_dir, self.cfg.poll_seconds)
        while True:
            try:
                count = self.run_once()
                if count:
                    log.info("Synced %d trade(s)", count)
            except KeyboardInterrupt:
                raise
            except Exception as exc:  # noqa: BLE001 - a watcher must not die
                log.exception("Sync cycle failed: %s", exc)
            time.sleep(self.cfg.poll_seconds)

    def import_history(self, days: int = 3650) -> int:
        """Backfill closed positions straight from the terminal (Windows only)."""
        from . import mt5_source

        mt5 = mt5_source.connect()
        try:
            account = mt5_source.read_account(mt5)
            if account:
                self._account = account
            trades = mt5_source.fetch_closed_trades(mt5, days=days)
        finally:
            mt5.shutdown()

        fresh = [t for t in trades if not self.store.has(t.position_id)]
        if not fresh:
            log.info("Nothing new to import")
            return 0

        account_page = self._ensure_account()
        starting = self._starting_balance()
        touched: set[date] = set()

        for trade in fresh:
            trade.enrich(
                tz=self.cfg.timezone,
                sessions=self.cfg.sessions,
                breakeven_threshold=self.cfg.breakeven_threshold,
                default_risk_pct=self.cfg.default_risk_pct,
                balance_at_open=self.store.balance_at_open(trade, starting),
            )
            day_page = self._ensure_day(trade.trade_date, account_page)
            try:
                self._upsert_trade(trade, None, account_page, day_page)
            except Exception as exc:  # noqa: BLE001
                log.exception("Import failed for position %s: %s", trade.position_id, exc)
                continue
            self.store.add(trade)
            touched.add(trade.trade_date)

        self.store.save()
        for day in sorted(touched):
            self._refresh_day(day, account_page)
        self.refresh_dashboard()
        self._update_account_page(account_page)
        return len(fresh)

    # ==================================================================
    # Accounts
    # ==================================================================
    def _starting_balance(self) -> float:
        if self.store.starting_balance is not None:
            return self.store.starting_balance
        if self._account and self._account.balance:
            inferred = self.store.infer_starting_balance(self._account.balance)
            self.store.starting_balance = inferred
            return inferred
        return 0.0

    def _ensure_account(self) -> str | None:
        if self._account_page:
            return self._account_page
        if not self._account:
            log.warning("No account snapshot yet — trades will sync without an account link")
            return None

        acct = self._account
        existing = self.notion.find_by_number(self.cfg.accounts_db, "Login", acct.login)
        if existing:
            self._account_page = existing["id"]
            return self._account_page

        props = {
            "Name": N.title(acct.display_name),
            "Login": N.number(acct.login),
            "Broker": N.rich_text(acct.company),
            "Server": N.rich_text(acct.server),
            "Currency": N.select(acct.currency),
            "Account Type": N.select("Demo" if acct.is_demo else "Live"),
            "Starting Balance": N.number(self._starting_balance()),
            "Current Balance": N.number(acct.balance),
            "Current Equity": N.number(acct.equity),
            "Active": N.checkbox(True),
            "Last Synced": N.date_prop(datetime.now(timezone.utc)),
        }
        page = self.notion.create_page(self.cfg.accounts_db, props)
        self._account_page = page.get("id")
        log.info("Created account page for %s", acct.display_name)
        return self._account_page

    def _update_account_page(self, page_id: str | None) -> None:
        if not page_id or not self._account:
            return
        starting = self._starting_balance()
        trades = self.store.trades
        peak = starting
        equity = starting
        for trade in trades:
            equity += trade.net_pl
            peak = max(peak, equity)

        self.notion.update_page(
            page_id,
            {
                "Current Balance": N.number(self._account.balance),
                "Current Equity": N.number(self._account.equity),
                "Starting Balance": N.number(starting),
                "Net P&L": N.number(self.store.total_net()),
                "Peak Balance": N.number(peak),
                "Last Synced": N.date_prop(datetime.now(timezone.utc)),
            },
        )

    # ==================================================================
    # Trades
    # ==================================================================
    def _upsert_trade(
        self,
        trade: Trade,
        item: SpoolItem | None,
        account_page: str | None,
        day_page: str | None,
    ) -> None:
        existing_id = self.store.page_id(trade.position_id)
        if not existing_id:
            found = self.notion.find_by_number(
                self.cfg.trades_db, "Position ID", trade.position_id
            )
            existing_id = found["id"] if found else None

        upload_id = None
        if item and item.screenshot_name and not existing_id:
            path = self.spool.screenshot_path(item.screenshot_name)
            try:
                upload_id = self.notion.upload_file(path)
            except Exception as exc:  # noqa: BLE001 - a missing chart must not block the trade
                log.warning("Screenshot upload failed for %s: %s", trade.position_id, exc)

        props = self._trade_properties(trade, account_page, day_page, upload_id)

        if existing_id:
            # Preserve the user's own columns: only refresh machine-owned fields.
            for user_field in (
                "Playbook",
                "Tags",
                "Setup Grade",
                "Execution Grade",
                "Followed Plan",
                "Confidence",
                "Entry Reason",
                "Exit Reason",
                "Lessons",
            ):
                props.pop(user_field, None)
            if upload_id is None:
                props.pop("H4 Chart", None)
            self.notion.update_page(existing_id, props)
            self.store.set_page_id(trade.position_id, existing_id)
            return

        children = self._trade_body(trade, upload_id)
        page = self.notion.create_page(self.cfg.trades_db, props, children)
        page_id = page.get("id")
        if page_id:
            self.store.set_page_id(trade.position_id, page_id)
        log.info(
            "Synced %s %s  net %.2f  R %.2f",
            trade.symbol,
            trade.direction,
            trade.net_pl,
            trade.realized_r or 0.0,
        )

    def _trade_properties(
        self,
        trade: Trade,
        account_page: str | None,
        day_page: str | None,
        upload_id: str | None,
    ) -> dict:
        props = {
            "Trade": N.title(trade.title),
            "Position ID": N.number(trade.position_id),
            "Symbol": N.select(trade.symbol),
            "Direction": N.select(trade.direction),
            "Status": N.select("Closed"),
            "Outcome": N.select(trade.outcome),
            "Open Time": N.date_prop(trade.open_time),
            "Close Time": N.date_prop(trade.close_time),
            "Duration (min)": N.number(round(trade.duration_minutes, 1)),
            "Volume": N.number(trade.volume),
            "Entry Price": N.number(trade.entry_price),
            "Exit Price": N.number(trade.exit_price),
            "Stop Loss": N.number(trade.stop_loss or None),
            "Take Profit": N.number(trade.take_profit or None),
            "Gross P&L": N.number(trade.gross_pl),
            "Commission": N.number(trade.commission),
            "Swap": N.number(trade.swap),
            "Net P&L": N.number(trade.net_pl),
            "Risk $": N.number(trade.risk_amount or None),
            "Planned R": N.number(trade.planned_r),
            "Realized R": N.number(trade.realized_r),
            "Return %": N.number(trade.return_pct),
            "MAE": N.number(trade.mae or None),
            "MFE": N.number(trade.mfe or None),
            "Session": N.select(trade.session),
            "Day of Week": N.select(trade.day_of_week),
            "Hour": N.number(trade.hour),
            "Magic": N.number(trade.magic),
            "MT5 Comment": N.rich_text(trade.comment),
            "Synced At": N.date_prop(datetime.now(timezone.utc)),
        }
        if account_page:
            props["Account"] = N.relation(account_page)
        if day_page:
            props["Day"] = N.relation(day_page)
        if upload_id:
            props["H4 Chart"] = N.files_from_upload(
                upload_id, f"{trade.symbol}_H4_{trade.position_id}.png"
            )
        return props

    def _trade_body(self, trade: Trade, upload_id: str | None) -> list:
        risk_note = (
            f"Risk {trade.risk_amount:,.2f} (estimated — no stop was attached)"
            if trade.risk_is_estimated
            else f"Risk {trade.risk_amount:,.2f} from entry to stop"
        )
        summary = (
            f"{trade.direction} {trade.volume:g} lots on {trade.symbol}. "
            f"Entry {trade.entry_price:.{trade.digits}f}, exit {trade.exit_price:.{trade.digits}f}. "
            f"Net {trade.net_pl:,.2f}. {risk_note}."
        )

        blocks = [
            N.callout(summary, "📊" if trade.net_pl >= 0 else "📉"),
        ]

        if upload_id:
            blocks += [N.heading("4H chart", 2), N.image_from_upload(upload_id)]

        blocks += [
            N.heading("What I saw", 2),
            N.paragraph(),
            N.heading("What actually happened", 2),
            N.paragraph(),
            N.heading("Would I take this again?", 2),
            N.todo("The setup matched an active playbook"),
            N.todo("Risk was within plan"),
            N.todo("Entry trigger was respected"),
            N.todo("Exit followed the plan, not emotion"),
        ]
        return blocks

    # ==================================================================
    # Daily journal
    # ==================================================================
    def _ensure_day(self, day: date, account_page: str | None) -> str | None:
        if day in self._day_pages:
            return self._day_pages[day]

        label = day.isoformat()
        found = self.notion.find_by_title(self.cfg.daily_db, "Day", label)
        if found:
            self._day_pages[day] = found["id"]
            return found["id"]

        props = {
            "Day": N.title(label),
            "Date": N.date_prop(day),
            "Reviewed": N.checkbox(False),
        }
        if account_page:
            props["Account"] = N.relation(account_page)

        page = self.notion.create_page(self.cfg.daily_db, props, _daily_template(day))
        page_id = page.get("id")
        if page_id:
            self._day_pages[day] = page_id
        return page_id

    def _refresh_day(self, day: date, account_page: str | None) -> None:
        page_id = self._ensure_day(day, account_page)
        if not page_id:
            return

        trades = self.store.on_date(day)
        if not trades:
            return

        metrics = analytics.compute(
            trades,
            starting_balance=self._starting_balance(),
            min_sample_size=self.cfg.min_sample_size,
        )

        if metrics.net_pl > self.cfg.breakeven_threshold:
            result = "Win"
        elif metrics.net_pl < -self.cfg.breakeven_threshold:
            result = "Loss"
        else:
            result = "Breakeven"

        self.notion.update_page(
            page_id,
            {
                "Net P&L": N.number(metrics.net_pl),
                "Gross Profit": N.number(metrics.gross_profit),
                "Gross Loss": N.number(-metrics.gross_loss),
                "Costs": N.number(metrics.costs),
                "Trades Taken": N.number(metrics.trade_count),
                "Winners": N.number(metrics.winners),
                "Losers": N.number(metrics.losers),
                "Win Rate": N.number(metrics.win_rate / 100.0),
                "Total R": N.number(metrics.total_r),
                "Best Trade": N.number(metrics.largest_win),
                "Worst Trade": N.number(metrics.largest_loss),
                "Day Result": N.select(result),
            },
        )

    # ==================================================================
    # Dashboard
    # ==================================================================
    def refresh_dashboard(self) -> None:
        trades = self.store.trades
        if not trades:
            log.info("No trades cached, nothing to compute")
            return

        starting = self._starting_balance()
        annotations = self._load_annotations()
        playbook_names = _invert(self.notion.index_by_title(self.cfg.playbooks_db, "Name"))
        tag_names = _invert(self.notion.index_by_title(self.cfg.tags_db, "Name"))

        scopes: list[tuple[str, str, list[Trade]]] = [("All Time", "All Time", trades)]

        for label, bucket in analytics.group_by(
            trades, lambda t: t.trade_date.strftime("%Y-%m")
        ).items():
            scopes.append((label, "Month", bucket))

        for label, bucket in analytics.group_by(trades, lambda t: t.symbol).items():
            scopes.append((label, "Symbol", bucket))

        for label, bucket in analytics.group_by(trades, lambda t: t.session).items():
            scopes.append((label, "Session", bucket))

        for label, bucket in analytics.group_by(trades, lambda t: t.day_of_week).items():
            scopes.append((label, "Day of Week", bucket))

        # Scopes that depend on what the user filled in inside Notion.
        by_playbook: dict[str, list[Trade]] = defaultdict(list)
        by_tag: dict[str, list[Trade]] = defaultdict(list)
        by_grade: dict[str, list[Trade]] = defaultdict(list)

        for trade in trades:
            note = annotations.get(trade.position_id)
            if not note:
                continue
            for pid in note["playbooks"]:
                name = playbook_names.get(pid)
                if name:
                    by_playbook[name].append(trade)
            for tid in note["tags"]:
                name = tag_names.get(tid)
                if name:
                    by_tag[name].append(trade)
            if note["setup_grade"]:
                by_grade[note["setup_grade"]].append(trade)

        scopes += [(k, "Playbook", v) for k, v in by_playbook.items()]
        scopes += [(k, "Tag", v) for k, v in by_tag.items()]
        scopes += [(k, "Setup Grade", v) for k, v in by_grade.items()]

        existing = self.notion.index_by_title(self.cfg.performance_db, "Scope")
        now = datetime.now(timezone.utc)

        for label, scope_type, bucket in scopes:
            metrics = analytics.compute(
                bucket,
                starting_balance=starting,
                min_sample_size=self.cfg.min_sample_size,
            )
            props = _performance_properties(label, scope_type, metrics, now)
            page_id = existing.get(label)
            if page_id:
                self.notion.update_page(page_id, props)
            else:
                self.notion.create_page(self.cfg.performance_db, props)

        log.info("Dashboard refreshed across %d scope(s)", len(scopes))

    def _load_annotations(self) -> dict[int, dict]:
        """Read back the columns the trader fills in by hand."""
        out: dict[int, dict] = {}
        for page in self.notion.query(self.cfg.trades_db):
            props = page.get("properties", {})
            position = (props.get("Position ID") or {}).get("number")
            if position is None:
                continue
            grade = (props.get("Setup Grade") or {}).get("select") or {}
            out[int(position)] = {
                "playbooks": [r["id"] for r in (props.get("Playbook") or {}).get("relation", [])],
                "tags": [r["id"] for r in (props.get("Tags") or {}).get("relation", [])],
                "setup_grade": grade.get("name"),
            }
        return out


# ======================================================================
# Helpers
# ======================================================================


def _invert(mapping: dict[str, str]) -> dict[str, str]:
    return {v: k for k, v in mapping.items()}


def _account_from_snapshot(snapshot: dict) -> Account:
    return Account(
        login=int(snapshot.get("login", 0)),
        server=str(snapshot.get("server", "")),
        company=str(snapshot.get("company", "")),
        currency=str(snapshot.get("currency", "USD")),
        balance=float(snapshot.get("balance", 0.0)),
        equity=float(snapshot.get("equity", 0.0)),
        name=str(snapshot.get("name", "")),
        is_demo=bool(snapshot.get("is_demo", False)),
    )


def _performance_properties(
    label: str, scope_type: str, m: analytics.Metrics, now: datetime
) -> dict:
    return {
        "Scope": N.title(label),
        "Scope Type": N.select(scope_type),
        "Period Start": N.date_prop(m.period_start),
        "Period End": N.date_prop(m.period_end),
        "Zella Score": N.number(m.zella_score),
        "Score: Profit Factor": N.number(round(m.score_profit_factor, 1)),
        "Score: Avg Win/Loss": N.number(round(m.score_avg_win_loss, 1)),
        "Score: Max Drawdown": N.number(round(m.score_max_drawdown, 1)),
        "Score: Win Rate": N.number(round(m.score_win_rate, 1)),
        "Score: Recovery Factor": N.number(round(m.score_recovery_factor, 1)),
        "Score: Consistency": N.number(round(m.score_consistency, 1)),
        "Net P&L": N.number(m.net_pl),
        "Gross Profit": N.number(m.gross_profit),
        "Gross Loss": N.number(-m.gross_loss),
        "Costs": N.number(m.costs),
        "Profit Factor": N.number(m.profit_factor),
        "Trade Count": N.number(m.trade_count),
        "Winners": N.number(m.winners),
        "Losers": N.number(m.losers),
        "Breakeven": N.number(m.breakeven),
        "Win Rate": N.number(m.win_rate / 100.0),
        "Day Win Rate": N.number(m.day_win_rate / 100.0),
        "Avg Win": N.number(m.avg_win),
        "Avg Loss": N.number(-m.avg_loss),
        "Avg Win/Loss": N.number(m.avg_win_loss),
        "Expectancy": N.number(m.expectancy),
        "Expectancy R": N.number(m.expectancy_r),
        "Total R": N.number(m.total_r),
        "Avg R": N.number(m.avg_r),
        "Max Drawdown": N.number(-m.max_drawdown),
        "Max Drawdown %": N.number(m.max_drawdown_pct / 100.0),
        "Avg Drawdown": N.number(-m.avg_drawdown),
        "Recovery Factor": N.number(m.recovery_factor),
        "Consistency": N.number(m.consistency / 100.0),
        "Largest Win": N.number(m.largest_win),
        "Largest Loss": N.number(m.largest_loss),
        "Max Consecutive Wins": N.number(m.max_consecutive_wins),
        "Max Consecutive Losses": N.number(m.max_consecutive_losses),
        "Current Streak": N.number(m.current_streak),
        "Avg Hold (min)": N.number(round(m.avg_hold_minutes, 1)),
        "Logged Days": N.number(m.logged_days),
        "Longs": N.number(m.longs),
        "Shorts": N.number(m.shorts),
        "Long Win Rate": N.number(m.long_win_rate / 100.0),
        "Short Win Rate": N.number(m.short_win_rate / 100.0),
        "Avg Volume": N.number(round(m.avg_volume, 4)),
        "Sample Warning": N.checkbox(m.sample_warning),
        "Computed At": N.date_prop(now),
    }


def _daily_template(day: date) -> list:
    return [
        N.callout(
            "Fill the pre-market section before your first trade. "
            "Come back after the close for the review — the stats above fill in automatically.",
            "🗓️",
        ),
        N.heading("Pre-market plan", 2),
        N.todo("Checked the economic calendar for high-impact news"),
        N.todo("Marked key levels on the H4 and daily"),
        N.todo("Decided which playbooks are in play today"),
        N.todo("Set a maximum loss for the day and a maximum number of trades"),
        N.paragraph("Bias and reasoning:"),
        N.paragraph(),
        N.divider(),
        N.heading("Post-market review", 2),
        N.paragraph("What went well:"),
        N.paragraph(),
        N.paragraph("What went badly:"),
        N.paragraph(),
        N.paragraph("The one thing to do differently tomorrow:"),
        N.paragraph(),
        N.divider(),
        N.heading("Rule check", 2),
        N.todo("Every trade came from a playbook"),
        N.todo("No position exceeded the planned risk"),
        N.todo("Stopped trading at the daily loss limit"),
        N.todo("No revenge trades"),
    ]
