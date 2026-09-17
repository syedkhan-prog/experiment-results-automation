"""Rewire the experiment-results workflow so the Mac drives the run.

The Mac cannot be reached from n8n on this network: the Tailscale funnel
hostname stopped resolving, cloudflared needs outbound 7844 (blocked) and the
ngrok free quota is spent. Outbound Mac -> n8n always works, so the direction is
inverted: n8n exposes two webhooks and daily_runner.py on the Mac calls them.

  POST /webhook/<ELIGIBLE_PATH>  -> { rows: [...] }   eligible tracker rows
  POST /webhook/<REPORT_PATH>    <- { source, scorecard }  builds one report

Run once, then publish the workflow.
"""

from __future__ import annotations

import importlib.util
import json
import uuid
from pathlib import Path

HERE = Path(__file__).parent
WORKFLOW_ID = "mv6B2DjlniE27ZWk"
SECRETS = HERE / "webhook_secrets.json"

spec = importlib.util.spec_from_file_location(
    "deploy_helper", Path.home() / "Downloads" / "AM Bot" / "_deploy_approval_workflows.py"
)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
api = helper.api

DROP = {
    "Daily 12:00 EE",
    "Resolve Delivery Test ID",
    "Query Scorecard",
    "Test ID Resolved?",
    "Process One Test At A Time",
    "Run Complete",
}


def load_secrets() -> dict:
    if SECRETS.exists():
        return json.loads(SECRETS.read_text())
    secrets = {
        "eligible_path": "growth-exp-eligible-" + uuid.uuid4().hex[:12],
        "report_path": "growth-exp-report-" + uuid.uuid4().hex[:12],
        "token": uuid.uuid4().hex + uuid.uuid4().hex,
        "base_url": "https://n8n.automation.boltint.net/webhook",
    }
    SECRETS.write_text(json.dumps(secrets, indent=2))
    SECRETS.chmod(0o600)
    return secrets


def webhook(name: str, path: str, position: list[int]) -> dict:
    return {
        "name": name,
        "type": "n8n-nodes-base.webhook",
        "typeVersion": 2,
        "position": position,
        "webhookId": str(uuid.uuid5(uuid.NAMESPACE_URL, path)),
        "parameters": {
            "httpMethod": "POST",
            "path": path,
            "responseMode": "responseNode",
            "options": {},
        },
    }


def code(name: str, position: list[int], js: str, each_item: bool = False) -> dict:
    params = {"jsCode": js}
    if each_item:
        params["mode"] = "runOnceForEachItem"
    return {
        "name": name,
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": position,
        "parameters": params,
    }


def respond(name: str, position: list[int]) -> dict:
    return {
        "name": name,
        "type": "n8n-nodes-base.respondToWebhook",
        "typeVersion": 1.1,
        "position": position,
        "parameters": {"respondWith": "json", "responseBody": "={{ JSON.stringify($json) }}", "options": {}},
    }


def main() -> None:
    s = load_secrets()
    token = s["token"]

    wf = api("GET", f"/workflows/{WORKFLOW_ID}")
    nodes = [n for n in wf["nodes"] if n["name"] not in DROP]
    by_name = {n["name"]: n for n in nodes}

    guard = (
        "const h = $('%s').first().json.headers || {};\n"
        "if ((h['x-automation-token'] || '') !== '" + token + "') throw new Error('unauthorized');\n"
    )

    # Branch A: return the tracker rows that still need a report.
    by_name["Select Eligible Rows"]["parameters"]["jsCode"] = (
        "const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Tallinn', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());\n"
        "const truthy = (v) => v === true || String(v || '').trim().toUpperCase() === 'TRUE';\n"
        "const rows = [];\n"
        "for (const [i, item] of $input.all().entries()) {\n"
        "  const row = item.json || {};\n"
        "  const link = String(row['Experiment Link'] || '').trim();\n"
        "  const resultsLink = String(row['Results Link'] || '').trim();\n"
        "  if (!truthy(row['Test Ended']) || !link || resultsLink) continue;\n"
        "  const plannedRaw = row['End Date (Planned)'];\n"
        "  const parsed = plannedRaw ? new Date(plannedRaw) : null;\n"
        "  const plannedIso = parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;\n"
        "  const sheetRow = Number(row.row_number || row.rowNumber || (i + 2));\n"
        "  rows.push({ ...row, tracker_row_number: sheetRow, run_date: today, planned_end_iso: plannedIso, report_status: plannedIso && plannedIso > today ? 'INTERIM' : 'FINAL' });\n"
        "}\n"
        "return [{ json: { run_date: today, count: rows.length, rows } }];"
    )

    # Branch B: the Mac has already resolved the test and pulled the scorecard.
    by_name["Prepare Resolved Test"]["parameters"] = {
        "jsCode": (
            guard % "Webhook Build Report"
            + "const body = $('Webhook Build Report').first().json.body || {};\n"
            "const source = body.source || {};\n"
            "if (!source.test_id) throw new Error('source.test_id missing');\n"
            "if (!source['Experiment Link']) throw new Error('source Experiment Link missing');\n"
            "return [{ json: source }];"
        )
    }

    new_nodes = [
        webhook("Webhook Eligible Rows", s["eligible_path"], [0, 700]),
        code("Check Eligible Token", [240, 700], guard % "Webhook Eligible Rows" + "return $input.all();"),
        respond("Respond With Eligible Rows", [960, 700]),
        webhook("Webhook Build Report", s["report_path"], [720, 320]),
        code(
            "Extract Scorecard Payload",
            [1680, 320],
            "const body = $('Webhook Build Report').first().json.body || {};\n"
            "return [{ json: body.scorecard || {} }];",
        ),
        respond("Respond Report Done", [3840, 300]),
    ]
    for node in new_nodes:
        if node["name"] in by_name:
            by_name[node["name"]].update(node)
        else:
            nodes.append(node)
            by_name[node["name"]] = node

    by_name["Read Growth Team Tracker"]["position"] = [480, 700]
    by_name["Select Eligible Rows"]["position"] = [720, 700]
    by_name["Prepare Resolved Test"]["position"] = [960, 320]
    by_name["Normalize Scorecard"]["position"] = [1920, 320]

    chain = [
        ("Webhook Eligible Rows", "Check Eligible Token"),
        ("Check Eligible Token", "Read Growth Team Tracker"),
        ("Read Growth Team Tracker", "Select Eligible Rows"),
        ("Select Eligible Rows", "Respond With Eligible Rows"),
        ("Webhook Build Report", "Prepare Resolved Test"),
        ("Prepare Resolved Test", "Extract Scorecard Payload"),
        ("Extract Scorecard Payload", "Normalize Scorecard"),
        ("Build Bolt Report", "Create Result Document"),
        ("Create Result Document", "Apply Bolt Report Formatting"),
        ("Apply Bolt Report Formatting", "Fetch Document Structure"),
        ("Fetch Document Structure", "Build Table Fill Requests"),
        ("Build Table Fill Requests", "Fill Report Tables"),
        ("Fill Report Tables", "Prepare Tracker Update"),
        ("Prepare Tracker Update", "Write Results To Tracker"),
        ("Write Results To Tracker", "Respond Report Done"),
        ("Prepare No-Data Note", "Write No-Data Note"),
        ("Write No-Data Note", "Respond Report Done"),
    ]
    conns = {src: {"main": [[{"node": dst, "type": "main", "index": 0}]]} for src, dst in chain}
    conns["Normalize Scorecard"] = {"main": [[{"node": "Scorecard Data Available?", "type": "main", "index": 0}]]}
    conns["Scorecard Data Available?"] = {
        "main": [
            [{"node": "Build Bolt Report", "type": "main", "index": 0}],
            [{"node": "Prepare No-Data Note", "type": "main", "index": 0}],
        ]
    }

    api(
        "PUT",
        f"/workflows/{WORKFLOW_ID}",
        {"name": wf["name"], "nodes": nodes, "connections": conns, "settings": wf.get("settings", {})},
    )
    print("nodes:", len(nodes))
    print("eligible:", f"{s['base_url']}/{s['eligible_path']}")
    print("report:  ", f"{s['base_url']}/{s['report_path']}")


if __name__ == "__main__":
    main()
