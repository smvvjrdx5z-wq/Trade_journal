from __future__ import annotations

import json

import pytest

from tradejournal import notion as N
from tradejournal.spool import Spool

from test_models import ea_payload


@pytest.fixture
def spool(tmp_path):
    s = Spool(tmp_path / "spool", tmp_path / "spool" / "processed")
    s.ensure()
    return s


def write_trade(spool: Spool, position_id: int, *, with_screenshot: bool = True) -> None:
    payload = ea_payload()
    payload["trade"]["position_id"] = position_id
    name = f"trade_{position_id}_h4.png"
    payload["trade"]["screenshot"] = name if with_screenshot else ""
    (spool.dir / f"trade_{position_id}.json").write_text(json.dumps(payload), encoding="utf-8")
    if with_screenshot:
        (spool.dir / name).write_bytes(b"\x89PNG\r\n\x1a\n fake")


class TestSpool:
    def test_ensure_creates_directories(self, tmp_path):
        s = Spool(tmp_path / "a", tmp_path / "a" / "processed")
        s.ensure()
        assert s.dir.is_dir() and s.processed.is_dir()

    def test_reads_pending_payloads(self, spool):
        write_trade(spool, 101)
        write_trade(spool, 102)
        items = list(spool.pending())
        assert len(items) == 2
        assert {i.payload["trade"]["position_id"] for i in items} == {101, 102}

    def test_pending_is_ordered(self, spool):
        for pid in (300, 100, 200):
            write_trade(spool, pid)
        names = [i.path.name for i in spool.pending()]
        assert names == sorted(names)

    def test_ignores_non_trade_files(self, spool):
        (spool.dir / "account.json").write_text('{"type":"account"}', encoding="utf-8")
        (spool.dir / "processed.csv").write_text("123\n", encoding="utf-8")
        assert list(spool.pending()) == []

    def test_skips_half_written_json(self, spool):
        (spool.dir / "trade_999.json").write_text('{"type": "trade", "tra', encoding="utf-8")
        write_trade(spool, 101)
        items = list(spool.pending())
        assert len(items) == 1
        assert items[0].payload["trade"]["position_id"] == 101

    def test_screenshot_name(self, spool):
        write_trade(spool, 101)
        item = next(iter(spool.pending()))
        assert item.screenshot_name == "trade_101_h4.png"

    def test_screenshot_name_is_none_when_absent(self, spool):
        write_trade(spool, 101, with_screenshot=False)
        item = next(iter(spool.pending()))
        assert item.screenshot_name is None

    def test_archive_moves_json_and_png(self, spool):
        write_trade(spool, 101)
        item = next(iter(spool.pending()))
        spool.archive(item)

        assert not (spool.dir / "trade_101.json").exists()
        assert not (spool.dir / "trade_101_h4.png").exists()
        assert (spool.processed / "trade_101.json").is_file()
        assert (spool.processed / "trade_101_h4.png").is_file()
        assert list(spool.pending()) == []

    def test_archive_tolerates_a_missing_screenshot(self, spool):
        write_trade(spool, 101)
        (spool.dir / "trade_101_h4.png").unlink()
        item = next(iter(spool.pending()))
        spool.archive(item)  # must not raise
        assert (spool.processed / "trade_101.json").is_file()

    def test_account_snapshot(self, spool):
        (spool.dir / "account.json").write_text(
            json.dumps({"type": "account", "login": 42, "balance": 5000.0}), encoding="utf-8"
        )
        snap = spool.account_snapshot()
        assert snap["login"] == 42

    def test_account_snapshot_absent(self, spool):
        assert spool.account_snapshot() is None

    def test_handles_utf8_bom(self, spool):
        """MQL5's FileWriteString can emit a BOM depending on the file flags."""
        payload = ea_payload()
        (spool.dir / "trade_101.json").write_text(
            json.dumps(payload), encoding="utf-8-sig"
        )
        assert len(list(spool.pending())) == 1


class TestNotionProperties:
    def test_title_truncates(self):
        prop = N.title("x" * 5000)
        assert len(prop["title"][0]["text"]["content"]) == 2000

    def test_empty_rich_text(self):
        assert N.rich_text(None) == {"rich_text": []}
        assert N.rich_text("") == {"rich_text": []}

    def test_number_none_is_preserved(self):
        assert N.number(None) == {"number": None}
        assert N.number(0) == {"number": 0.0}

    def test_select_none(self):
        assert N.select(None) == {"select": None}
        assert N.select("Win") == {"select": {"name": "Win"}}

    def test_relation_accepts_a_bare_string(self):
        assert N.relation("abc") == {"relation": [{"id": "abc"}]}
        assert N.relation(None) == {"relation": []}

    def test_files_from_upload(self):
        prop = N.files_from_upload("upload-123", "chart.png")
        assert prop["files"][0]["file_upload"]["id"] == "upload-123"
        assert prop["files"][0]["type"] == "file_upload"

    def test_files_from_upload_without_an_id(self):
        assert N.files_from_upload(None, "chart.png") == {"files": []}

    def test_date_accepts_date_and_datetime(self):
        from datetime import date, datetime, timezone

        assert N.date_prop(date(2026, 3, 2))["date"]["start"] == "2026-03-02"
        stamp = datetime(2026, 3, 2, 9, 0, tzinfo=timezone.utc)
        assert N.date_prop(stamp)["date"]["start"].startswith("2026-03-02T09:00")
        assert N.date_prop(None) == {"date": None}

    def test_multi_select_filters_blanks(self):
        assert N.multi_select(["a", "", None, "b"]) == {
            "multi_select": [{"name": "a"}, {"name": "b"}]
        }

    def test_block_builders_shape(self):
        assert N.heading("Hi", 2)["type"] == "heading_2"
        assert N.heading("Hi", 9)["type"] == "heading_3"  # clamped
        assert N.todo("do it")["to_do"]["checked"] is False
        assert N.image_from_upload("u1")["image"]["file_upload"]["id"] == "u1"
        assert N.divider()["type"] == "divider"
