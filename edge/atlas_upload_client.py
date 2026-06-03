from __future__ import annotations

import argparse
import json
import socket
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_json(path: str | None) -> Any:
    if not path:
        return None
    return json.loads(Path(path).read_text(encoding="utf-8"))


def summarize_detections(detections: list[dict[str, Any]]) -> dict[str, Any]:
    counts: dict[str, int] = {}
    for item in detections:
        class_name = str(item.get("class_name") or item.get("label") or "unknown")
        counts[class_name] = counts.get(class_name, 0) + 1
    return {
        "total_count": sum(counts.values()),
        "class_counts": counts,
        "person_count": counts.get("person", 0),
        "vehicle_count": sum(counts.get(name, 0) for name in ("car", "bus", "truck", "motorcycle", "bicycle")),
    }


def collect_system_metrics() -> dict[str, Any]:
    metrics: dict[str, Any] = {}
    for path, key in (("/proc/loadavg", "loadavg"), ("/proc/uptime", "uptime")):
        try:
            raw = Path(path).read_text().strip()
        except Exception:
            raw = ""
        if raw:
            metrics[key] = raw
    return metrics


def build_event(args: argparse.Namespace) -> dict[str, Any]:
    detections = load_json(args.detections_json)
    if detections is None:
        detections = []
    if isinstance(detections, dict):
        detections = detections.get("detections", [])
    if not isinstance(detections, list):
        raise ValueError("detections JSON must be a list or an object with a detections field")

    summary = load_json(args.summary_json)
    if not isinstance(summary, dict):
        summary = summarize_detections(detections)

    need_cloud_analysis = args.force_cloud or summary.get("total_count", 0) > 0
    return {
        "device_id": args.device_id,
        "hostname": socket.gethostname(),
        "timestamp": utc_now(),
        "image_id": Path(args.image).name if args.image else args.image_id,
        "image_path": args.image or "",
        "source_type": args.source_type,
        "inference": {
            "model": args.model,
            "latency_ms": args.latency_ms,
            "fps": args.fps,
        },
        "detections": detections,
        "summary": summary,
        "system_metrics": collect_system_metrics(),
        "edge_decision": {
            "handled_locally": True,
            "need_cloud_analysis": need_cloud_analysis,
            "reason": args.reason or ("detected objects need semantic analysis" if need_cloud_analysis else "no target detected"),
        },
    }


def check_health(server: str, timeout: int) -> None:
    url = server.rstrip("/") + "/api/health"
    response = requests.get(url, timeout=timeout)
    response.raise_for_status()
    print(json.dumps(response.json(), ensure_ascii=False, indent=2))


def post_event(server: str, event: dict[str, Any], timeout: int) -> dict[str, Any]:
    url = server.rstrip("/") + "/api/edge/events"
    response = requests.post(url, json=event, timeout=timeout)
    response.raise_for_status()
    return response.json()


def analyze_task(server: str, task_id: str, timeout: int) -> dict[str, Any]:
    url = server.rstrip("/") + "/api/edge/analyze"
    response = requests.post(url, json={"task_id": task_id}, timeout=timeout)
    response.raise_for_status()
    return response.json()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Upload Atlas YOLO edge detection results to the laptop cloud service.")
    parser.add_argument("--server", required=True, help="Laptop cloud service base URL, for example http://192.168.0.101:5000")
    parser.add_argument("--device-id", default="atlas-200i-dk-a2-01")
    parser.add_argument("--image", default="", help="Input image path on Atlas")
    parser.add_argument("--image-id", default="manual-test-image")
    parser.add_argument("--source-type", default="uploaded_image")
    parser.add_argument("--model", default="yolov5")
    parser.add_argument("--detections-json", help="Path to YOLO detections JSON")
    parser.add_argument("--summary-json", help="Optional path to summary JSON")
    parser.add_argument("--latency-ms", type=float, default=None)
    parser.add_argument("--fps", type=float, default=None)
    parser.add_argument("--reason", default="")
    parser.add_argument("--force-cloud", action="store_true", help="Always mark this event as needing cloud analysis")
    parser.add_argument("--analyze", action="store_true", help="Ask cloud agent to analyze the task after upload")
    parser.add_argument("--health", action="store_true", help="Only check /api/health")
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--save-event", help="Save outgoing event JSON for debugging")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if args.health:
            check_health(args.server, args.timeout)
            return 0

        event = build_event(args)
        if args.save_event:
            Path(args.save_event).write_text(json.dumps(event, ensure_ascii=False, indent=2), encoding="utf-8")

        started = time.time()
        result = post_event(args.server, event, args.timeout)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if args.analyze and result.get("task_id"):
            analysis = analyze_task(args.server, result["task_id"], max(args.timeout, 90))
            print(json.dumps(analysis, ensure_ascii=False, indent=2))
        print(f"elapsed_seconds={time.time() - started:.2f}", file=sys.stderr)
        return 0
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
