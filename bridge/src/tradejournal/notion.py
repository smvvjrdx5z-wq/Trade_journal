"""Thin Notion REST client: querying, upserting, and direct file upload."""

from __future__ import annotations

import logging
import time
from datetime import date, datetime
from pathlib import Path
from typing import Any, Iterator

import requests

log = logging.getLogger(__name__)

API = "https://api.notion.com/v1"

# Notion's published guidance is an average of three requests per second.
_MIN_INTERVAL = 1.0 / 3.0
_MAX_ATTEMPTS = 5


class NotionError(RuntimeError):
    pass


class NotionClient:
    def __init__(self, token: str, *, version: str = "2022-06-28", dry_run: bool = False):
        self.dry_run = dry_run
        self._version = version
        self._last_call = 0.0
        self._session = requests.Session()
        self._session.headers.update(
            {
                "Authorization": f"Bearer {token}",
                "Notion-Version": version,
            }
        )

    # ------------------------------------------------------------------
    def _throttle(self) -> None:
        elapsed = time.monotonic() - self._last_call
        if elapsed < _MIN_INTERVAL:
            time.sleep(_MIN_INTERVAL - elapsed)
        self._last_call = time.monotonic()

    def _request(self, method: str, path: str, **kwargs: Any) -> dict:
        url = path if path.startswith("http") else f"{API}{path}"
        last_error: Exception | None = None

        for attempt in range(1, _MAX_ATTEMPTS + 1):
            self._throttle()
            try:
                response = self._session.request(method, url, timeout=60, **kwargs)
            except requests.RequestException as exc:
                last_error = exc
                backoff = min(2**attempt, 30)
                log.warning("Notion %s %s failed (%s), retry in %ss", method, path, exc, backoff)
                time.sleep(backoff)
                continue

            if response.status_code == 429:
                retry_after = float(response.headers.get("Retry-After", 2))
                log.warning("Notion rate limited, sleeping %.1fs", retry_after)
                time.sleep(retry_after)
                continue

            if response.status_code >= 500:
                backoff = min(2**attempt, 30)
                log.warning("Notion %s, retry in %ss", response.status_code, backoff)
                time.sleep(backoff)
                continue

            if not response.ok:
                raise NotionError(
                    f"{method} {path} -> {response.status_code}: {response.text[:600]}"
                )

            return response.json() if response.content else {}

        raise NotionError(f"{method} {path} failed after {_MAX_ATTEMPTS} attempts: {last_error}")

    # ------------------------------------------------------------------
    def query(self, database_id: str, payload: dict | None = None) -> Iterator[dict]:
        """Yield every page in a database, following pagination."""
        body = dict(payload or {})
        cursor: str | None = None
        while True:
            if cursor:
                body["start_cursor"] = cursor
            data = self._request("POST", f"/databases/{database_id}/query", json=body)
            yield from data.get("results", [])
            if not data.get("has_more"):
                return
            cursor = data.get("next_cursor")

    def find_by_number(
        self, database_id: str, prop: str, value: float
    ) -> dict | None:
        results = list(
            self.query(
                database_id,
                {"filter": {"property": prop, "number": {"equals": value}}, "page_size": 1},
            )
        )
        return results[0] if results else None

    def find_by_title(self, database_id: str, title_prop: str, value: str) -> dict | None:
        results = list(
            self.query(
                database_id,
                {
                    "filter": {"property": title_prop, "title": {"equals": value}},
                    "page_size": 1,
                },
            )
        )
        return results[0] if results else None

    def index_by_title(self, database_id: str, title_prop: str) -> dict[str, str]:
        """Map every page title in a database to its page id."""
        index: dict[str, str] = {}
        for page in self.query(database_id):
            prop = page.get("properties", {}).get(title_prop, {})
            parts = prop.get("title") or []
            name = "".join(p.get("plain_text", "") for p in parts).strip()
            if name:
                index[name] = page["id"]
        return index

    # ------------------------------------------------------------------
    def create_page(
        self, database_id: str, properties: dict, children: list | None = None
    ) -> dict:
        if self.dry_run:
            log.info("[dry-run] create page in %s", database_id)
            return {"id": "dry-run"}
        body: dict[str, Any] = {
            "parent": {"database_id": database_id},
            "properties": properties,
        }
        if children:
            body["children"] = children
        return self._request("POST", "/pages", json=body)

    def update_page(self, page_id: str, properties: dict) -> dict:
        if self.dry_run:
            log.info("[dry-run] update page %s", page_id)
            return {"id": page_id}
        return self._request("PATCH", f"/pages/{page_id}", json={"properties": properties})

    def append_blocks(self, page_id: str, children: list) -> dict:
        if self.dry_run:
            log.info("[dry-run] append %d block(s) to %s", len(children), page_id)
            return {}
        return self._request("PATCH", f"/blocks/{page_id}/children", json={"children": children})

    # ------------------------------------------------------------------
    def upload_file(self, path: Path) -> str | None:
        """Direct upload. Returns a file_upload id ready to attach to a page.

        Notion archives uploads that are not attached within an hour, so callers
        should attach immediately.
        """
        if self.dry_run:
            log.info("[dry-run] upload %s", path.name)
            return None
        if not path.is_file():
            log.warning("Screenshot missing: %s", path)
            return None

        size = path.stat().st_size
        if size > 20 * 1024 * 1024:
            log.warning("Screenshot %s is %.1f MB, above the 20 MB single-part limit", path, size / 1e6)
            return None

        created = self._request(
            "POST",
            "/file_uploads",
            json={"filename": path.name, "content_type": "image/png"},
        )
        upload_id = created.get("id")
        upload_url = created.get("upload_url") or f"{API}/file_uploads/{upload_id}/send"
        if not upload_id:
            raise NotionError(f"file_uploads returned no id: {created}")

        # The send endpoint takes multipart/form-data, so the JSON content-type
        # header from the session must not leak into this call.
        with path.open("rb") as handle:
            self._throttle()
            response = self._session.post(
                upload_url,
                headers={"Notion-Version": self._version},
                files={"file": (path.name, handle, "image/png")},
                timeout=120,
            )
        if not response.ok:
            raise NotionError(f"file upload send failed {response.status_code}: {response.text[:400]}")

        return upload_id


# ----------------------------------------------------------------------
# Property builders
# ----------------------------------------------------------------------


def title(value: str) -> dict:
    return {"title": [{"text": {"content": value[:2000]}}]}


def rich_text(value: str | None) -> dict:
    if not value:
        return {"rich_text": []}
    return {"rich_text": [{"text": {"content": value[:2000]}}]}


def number(value: float | int | None) -> dict:
    if value is None:
        return {"number": None}
    return {"number": round(float(value), 6)}


def select(value: str | None) -> dict:
    if not value:
        return {"select": None}
    return {"select": {"name": value}}


def multi_select(values: list[str] | None) -> dict:
    return {"multi_select": [{"name": v} for v in (values or []) if v]}


def checkbox(value: bool) -> dict:
    return {"checkbox": bool(value)}


def date_prop(value: datetime | date | None) -> dict:
    if value is None:
        return {"date": None}
    if isinstance(value, datetime):
        return {"date": {"start": value.isoformat()}}
    return {"date": {"start": value.isoformat()}}


def relation(page_ids: list[str] | str | None) -> dict:
    if not page_ids:
        return {"relation": []}
    if isinstance(page_ids, str):
        page_ids = [page_ids]
    return {"relation": [{"id": pid} for pid in page_ids]}


def files_from_upload(upload_id: str | None, name: str) -> dict:
    if not upload_id:
        return {"files": []}
    return {
        "files": [
            {"type": "file_upload", "name": name, "file_upload": {"id": upload_id}}
        ]
    }


# ----------------------------------------------------------------------
# Block builders
# ----------------------------------------------------------------------


def heading(text: str, level: int = 2) -> dict:
    key = f"heading_{max(1, min(3, level))}"
    return {"object": "block", "type": key, key: {"rich_text": [{"text": {"content": text}}]}}


def paragraph(text: str = "") -> dict:
    return {
        "object": "block",
        "type": "paragraph",
        "paragraph": {"rich_text": [{"text": {"content": text}}] if text else []},
    }


def todo(text: str, checked: bool = False) -> dict:
    return {
        "object": "block",
        "type": "to_do",
        "to_do": {"rich_text": [{"text": {"content": text}}], "checked": checked},
    }


def callout(text: str, emoji: str = "💡") -> dict:
    return {
        "object": "block",
        "type": "callout",
        "callout": {
            "rich_text": [{"text": {"content": text}}],
            "icon": {"type": "emoji", "emoji": emoji},
        },
    }


def divider() -> dict:
    return {"object": "block", "type": "divider", "divider": {}}


def image_from_upload(upload_id: str) -> dict:
    return {
        "object": "block",
        "type": "image",
        "image": {"type": "file_upload", "file_upload": {"id": upload_id}},
    }
