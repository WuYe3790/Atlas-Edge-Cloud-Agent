from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import requests

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


@dataclass
class CheckResult:
    name: str
    ok: bool
    detail: str


class LocalClient:
    def __init__(self) -> None:
        from app import app

        self.client = app.test_client()

    def get(self, path: str):
        return self.client.get(path)

    def post(self, path: str, json_payload: dict[str, Any]):
        return self.client.post(path, json=json_payload)


class RemoteClient:
    def __init__(self, server: str, timeout: float) -> None:
        self.server = server.rstrip("/")
        self.timeout = timeout

    def get(self, path: str):
        return requests.get(f"{self.server}{path}", timeout=self.timeout)

    def post(self, path: str, json_payload: dict[str, Any]):
        return requests.post(f"{self.server}{path}", json=json_payload, timeout=self.timeout)


def response_json(response: Any) -> dict[str, Any]:
    if hasattr(response, "get_json"):
        return response.get_json(silent=True) or {}
    try:
        return response.json()
    except ValueError:
        return {}


def response_text(response: Any) -> str:
    if hasattr(response, "get_data"):
        return response.get_data(as_text=True)
    return response.text


def status_code(response: Any) -> int:
    return int(getattr(response, "status_code", 0))


def content_type(response: Any) -> str:
    headers = getattr(response, "headers", {}) or {}
    return str(headers.get("content-type", headers.get("Content-Type", "")))


def add_result(results: list[CheckResult], name: str, ok: bool, detail: str) -> None:
    results.append(CheckResult(name=name, ok=ok, detail=detail))


def check_health(client: Any, results: list[CheckResult]) -> None:
    response = client.get("/api/health")
    data = response_json(response)
    add_result(
        results,
        "health",
        status_code(response) == 200 and data.get("ok") is True,
        f"status={status_code(response)} service={data.get('service')}",
    )


def check_scheduling(client: Any, results: list[CheckResult]) -> None:
    cases = [
        (
            "zero target stays local",
            {
                "summary": {"total_count": 0, "class_counts": {}, "person_count": 0, "vehicle_count": 0},
                "detections": [],
                "system_metrics": {},
            },
            True,
            False,
        ),
        (
            "person goes cloud",
            {
                "summary": {"total_count": 1, "class_counts": {"person": 1}, "person_count": 1, "vehicle_count": 0},
                "detections": [{"class_name": "person", "confidence": 0.91}],
                "system_metrics": {},
            },
            False,
            True,
        ),
        (
            "low confidence goes cloud",
            {
                "summary": {"total_count": 1, "class_counts": {"sports_ball": 1}, "person_count": 0, "vehicle_count": 0},
                "detections": [{"class_name": "sports_ball", "confidence": 0.55}],
                "system_metrics": {},
            },
            False,
            True,
        ),
        (
            "high load goes cloud",
            {
                "summary": {"total_count": 1, "class_counts": {"sports_ball": 1}, "person_count": 0, "vehicle_count": 0},
                "detections": [{"class_name": "sports_ball", "confidence": 0.95}],
                "system_metrics": {"loadavg": {"1m": 17.0, "5m": 12.0, "15m": 8.0}},
            },
            False,
            True,
        ),
        (
            "calibrated high load stays local",
            {
                "summary": {"total_count": 1, "class_counts": {"sports_ball": 1}, "person_count": 0, "vehicle_count": 0},
                "detections": [{"class_name": "sports_ball", "confidence": 0.95}],
                "system_metrics": {"loadavg": {"1m": 17.0, "5m": 12.0, "15m": 8.0}},
                "load_threshold": 20.0,
            },
            True,
            False,
        ),
    ]
    for name, payload, handled_locally, need_cloud in cases:
        response = client.post("/api/edge/scheduling/validate", payload)
        data = response_json(response)
        decision = data.get("decision") if isinstance(data.get("decision"), dict) else {}
        ok = (
            status_code(response) == 200
            and data.get("ok") is True
            and decision.get("handled_locally") is handled_locally
            and decision.get("need_cloud_analysis") is need_cloud
        )
        add_result(results, f"scheduling: {name}", ok, json.dumps(decision, ensure_ascii=False))


def check_status_and_tasks(client: Any, results: list[CheckResult]) -> str | None:
    status_response = client.get("/api/edge/status")
    status_data = response_json(status_response)
    devices = status_data.get("devices") if isinstance(status_data.get("devices"), list) else []
    add_result(
        results,
        "edge status",
        status_code(status_response) == 200 and status_data.get("ok") is True,
        f"devices={len(devices)}",
    )

    tasks_response = client.get("/api/edge/tasks?limit=1")
    tasks_data = response_json(tasks_response)
    tasks = tasks_data.get("tasks") if isinstance(tasks_data.get("tasks"), list) else []
    add_result(
        results,
        "edge tasks",
        status_code(tasks_response) == 200 and tasks_data.get("ok") is True,
        f"tasks={len(tasks)}",
    )
    if tasks and isinstance(tasks[0], dict):
        return str(tasks[0].get("id") or "")
    return None


def check_task_detail(client: Any, task_id: str | None, results: list[CheckResult]) -> None:
    if not task_id:
        add_result(results, "task detail/report", True, "skipped: no existing edge task")
        return

    detail_response = client.get(f"/api/edge/tasks/{task_id}")
    detail_data = response_json(detail_response)
    add_result(
        results,
        "task detail",
        status_code(detail_response) == 200 and detail_data.get("ok") is True,
        f"task_id={task_id}",
    )

    report_response = client.get(f"/api/edge/tasks/{task_id}/report")
    report_text = response_text(report_response)
    add_result(
        results,
        "markdown report endpoint",
        status_code(report_response) == 200 and "# Atlas" in report_text,
        f"content_type={content_type(report_response)} bytes={len(report_text.encode('utf-8'))}",
    )

    html_response = client.get(f"/api/edge/tasks/{task_id}/report/html")
    html_text = response_text(html_response)
    add_result(
        results,
        "html report endpoint",
        status_code(html_response) == 200 and "<html" in html_text.lower(),
        f"content_type={content_type(html_response)} bytes={len(html_text.encode('utf-8'))}",
    )


def print_results(results: list[CheckResult]) -> int:
    failed = [item for item in results if not item.ok]
    for item in results:
        status = "PASS" if item.ok else "FAIL"
        print(f"[{status}] {item.name}: {item.detail}")
    print(f"\nsummary: {len(results) - len(failed)}/{len(results)} checks passed")
    return 1 if failed else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate the Atlas edge-cloud agent backend.")
    parser.add_argument("--server", default="", help="Live server base URL, e.g. http://192.168.0.101:5000. Omit to use Flask test client.")
    parser.add_argument("--timeout", type=float, default=10.0, help="HTTP timeout in seconds when --server is used.")
    args = parser.parse_args()

    client: Any
    if args.server:
        client = RemoteClient(args.server, args.timeout)
    else:
        client = LocalClient()

    results: list[CheckResult] = []
    try:
        check_health(client, results)
        check_scheduling(client, results)
        task_id = check_status_and_tasks(client, results)
        check_task_detail(client, task_id, results)
    except Exception as exc:
        add_result(results, "unexpected exception", False, repr(exc))
    return print_results(results)


if __name__ == "__main__":
    sys.exit(main())
