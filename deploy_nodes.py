"""Push the locally-developed code nodes into the n8n experiment-results workflow.

Keeps the JS in version-controllable files instead of the n8n editor. Run, then
publish the workflow so the schedule picks up the new version.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

HERE = Path(__file__).parent
WORKFLOW_ID = "mv6B2DjlniE27ZWk"
DOC_ID_EXPR = "={{ $('Create Result Document').item.json.id }}"
SHEETS_CRED = {
    "googleSheetsOAuth2Api": {
        "id": "1tM2h1l1utc9pHM8",
        "name": "MRK-GROWTH - Delivery Growth Analytics Google Sheets Service Account",
    }
}

spec = importlib.util.spec_from_file_location(
    "deploy_helper", Path.home() / "Downloads" / "AM Bot" / "_deploy_approval_workflows.py"
)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
api = helper.api


def read(name: str) -> str:
    return (HERE / name).read_text()


def http_node(name: str, position: list[int], parameters: dict) -> dict:
    return {
        "name": name,
        "type": "n8n-nodes-base.httpRequest",
        "typeVersion": 4.5,
        "position": position,
        "parameters": parameters,
        "credentials": SHEETS_CRED,
    }


def main() -> None:
    wf = api("GET", f"/workflows/{WORKFLOW_ID}")
    nodes = {n["name"]: n for n in wf["nodes"]}

    nodes["Normalize Scorecard"]["parameters"]["jsCode"] = read("normalize_scorecard.js")
    nodes["Build Bolt Report"]["parameters"]["jsCode"] = read("build_report.js")

    new_nodes = [
        http_node(
            "Fetch Document Structure",
            [2280, 0],
            {
                "method": "GET",
                "url": "=https://docs.googleapis.com/v1/documents/{{ $('Create Result Document').item.json.id }}",
                "authentication": "predefinedCredentialType",
                "nodeCredentialType": "googleSheetsOAuth2Api",
                "options": {"timeout": 60000},
            },
        ),
        {
            "name": "Build Table Fill Requests",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [2520, 0],
            "parameters": {"jsCode": read("fill_tables.js")},
        },
        http_node(
            "Fill Report Tables",
            [2760, 0],
            {
                "method": "POST",
                "url": f"=https://docs.googleapis.com/v1/documents/{{{{ $('Create Result Document').item.json.id }}}}:batchUpdate",
                "authentication": "predefinedCredentialType",
                "nodeCredentialType": "googleSheetsOAuth2Api",
                "sendBody": True,
                "specifyBody": "json",
                "jsonBody": "={{ JSON.stringify({ requests: $json.requests }) }}",
                "options": {"timeout": 120000},
            },
        ),
    ]

    existing = {n["name"] for n in wf["nodes"]}
    for node in new_nodes:
        if node["name"] in existing:
            nodes[node["name"]].update(node)
        else:
            wf["nodes"].append(node)

    chain = [
        ("Apply Bolt Report Formatting", "Fetch Document Structure"),
        ("Fetch Document Structure", "Build Table Fill Requests"),
        ("Build Table Fill Requests", "Fill Report Tables"),
        ("Fill Report Tables", "Prepare Tracker Update"),
    ]
    conns = wf["connections"]
    for src, dst in chain:
        conns[src] = {"main": [[{"node": dst, "type": "main", "index": 0}]]}

    payload = {
        "name": wf["name"],
        "nodes": wf["nodes"],
        "connections": conns,
        "settings": wf.get("settings", {}),
    }
    api("PUT", f"/workflows/{WORKFLOW_ID}", payload)
    print("updated nodes:", ", ".join(sorted({*(n for n, _ in chain), "Normalize Scorecard", "Build Bolt Report"})))
    print(json.dumps({k: [c["node"] for c in v["main"][0]] for k, v in conns.items() if k in dict(chain)}, indent=1))


if __name__ == "__main__":
    main()
