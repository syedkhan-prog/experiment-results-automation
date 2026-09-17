"""Daily driver for the Delivery experiment results automation.

n8n cannot reach this Mac (no working inbound tunnel on this network), so the
Mac drives the run instead. Everything here is outbound HTTPS, which works.

  1. ask n8n which tracker rows still need a report
  2. resolve the bulk group / test link through the local Admin API
  3. pull the scorecard through the local Admin API
  4. post the payload back to n8n, which writes the Google Doc and the tracker

Runs under launchd every 30 minutes. It does nothing until 12:00 Europe/Tallinn
and records a marker so a full pass happens once per day, which also means a
missed slot (laptop asleep) is picked up at the next wake.
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).parent
SECRETS = json.loads((HERE / "webhook_secrets.json").read_text())
STATE_DIR = Path.home() / "Library" / "Application Support" / "AMBot" / "experiment_results"
MARKER = STATE_DIR / "last_run.txt"
LOG = STATE_DIR / "runner.log"

ADMIN_API = "http://127.0.0.1:8077"
ADMIN_TOKEN = "NLPiHt2ijTw1sXejn311P7l9vCDL63cF"
RUN_HOUR_TALLINN = 12
TZ = ZoneInfo("Europe/Tallinn")


def log(msg: str) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    line = f"{datetime.now(TZ).isoformat(timespec='seconds')} {msg}"
    print(line, flush=True)
    with LOG.open("a") as fh:
        fh.write(line + "\n")


def request(url: str, *, headers: dict, payload: dict | None = None, timeout: int = 300) -> dict:
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method="POST" if data else "GET")
    if data:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode()
    return json.loads(body) if body.strip() else {}


def n8n(path_key: str, payload: dict) -> dict:
    url = f"{SECRETS['base_url']}/{SECRETS[path_key]}"
    return request(url, headers={"x-automation-token": SECRETS["token"]}, payload=payload)


def admin(path: str, params: dict, *, timeout: int = 300) -> dict:
    url = f"{ADMIN_API}{path}?" + urllib.parse.urlencode(params)
    return request(url, headers={"Authorization": f"Bearer {ADMIN_TOKEN}"}, timeout=timeout)


def _http_error_body(exc: urllib.error.HTTPError) -> str:
    try:
        return exc.read().decode("utf-8", errors="replace")
    except Exception:
        return str(exc)


def _looks_like_dbx_auth(text: str) -> bool:
    lowered = text.lower()
    return any(
        marker in lowered
        for marker in ("access_token", "invalid_grant", "refresh_token", "oauth")
    )


def ensure_databricks_session() -> None:
    setup = Path.home() / "Downloads" / "databricks-setup"
    sys.path.insert(0, str(setup))
    from dbx import ensure_session  # noqa: PLC0415

    if not ensure_session(until_ok=True, max_wait_s=1800, log=log):
        raise RuntimeError("Databricks OAuth did not recover within 30 minutes")


def admin_scorecard(test_id: int) -> dict:
    delay = 5
    deadline = time.time() + 1800
    while True:
        try:
            return admin("/experiment/scorecard", {"test_id": test_id}, timeout=360)
        except urllib.error.HTTPError as exc:
            body = _http_error_body(exc)
            if exc.code != 502 or not _looks_like_dbx_auth(body) or time.time() >= deadline:
                raise RuntimeError(f"scorecard HTTP {exc.code}: {body[:400]}") from exc
            log("scorecard hit a dead Databricks token, refreshing then retrying")
            ensure_databricks_session()
            time.sleep(delay)
            delay = min(delay * 2, 60)


def admin_alive() -> bool:
    try:
        admin("/experiment/resolve", {"url": "https://admin-panel.bolt.eu/campaign-targeting/tests/delivery/1"})
    except urllib.error.HTTPError:
        return True  # reachable, just an unknown test id
    except Exception:
        return False
    return True


def process(row: dict) -> str:
    link = str(row.get("Experiment Link") or "").strip()
    resolved = admin("/experiment/resolve", {"url": link})
    if resolved.get("status") != "resolved" or not resolved.get("test_id"):
        return f"skip (unresolved: {resolved.get('note') or resolved.get('status')})"

    source = {
        **row,
        "test_id": resolved["test_id"],
        "resolver_status": resolved.get("status"),
        "resolver_note": resolved.get("note"),
        "source_type": resolved.get("source_type"),
        "source_id": resolved.get("source_id"),
        "treatments": resolved.get("treatments") or [],
    }
    scorecard = admin_scorecard(resolved["test_id"])
    result = n8n("report_path", {"source": source, "scorecard": scorecard})
    link_out = result.get("Results Link") or result.get("Results Summary (1 line)") or "written"
    return f"test {resolved['test_id']}: {link_out}"


def main() -> int:
    now = datetime.now(TZ)
    force = "--force" in sys.argv
    if not force:
        if now.hour < RUN_HOUR_TALLINN:
            return 0
        if MARKER.exists() and MARKER.read_text().strip() == now.date().isoformat():
            return 0

    if not admin_alive():
        log("admin API on 127.0.0.1:8077 is not responding, will retry next slot")
        return 1

    try:
        ensure_databricks_session()
    except Exception as exc:
        log(f"databricks oauth not ready, will retry next slot: {exc}")
        return 1

    try:
        eligible = n8n("eligible_path", {"requested_at": now.isoformat()})
    except Exception as exc:
        log(f"could not fetch eligible rows: {exc}")
        return 1

    rows = eligible.get("rows") or []
    log(f"run start, {len(rows)} eligible row(s)")
    failures = 0
    for row in rows:
        label = str(row.get("Test Description (1 line)") or row.get("Experiment Link") or "row")[:70]
        try:
            log(f"  {label}: {process(row)}")
        except Exception as exc:
            failures += 1
            log(f"  {label}: FAILED {exc}")
        time.sleep(2)

    STATE_DIR.mkdir(parents=True, exist_ok=True)
    if failures == 0:
        MARKER.write_text(now.date().isoformat())
    log(f"run done, {len(rows) - failures} ok, {failures} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
