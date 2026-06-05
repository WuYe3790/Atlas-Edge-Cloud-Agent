from __future__ import annotations

import argparse
import json
import re
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import urllib.request
import urllib.error

class RequestException(Exception):
    pass

DEFAULT_LOAD_THRESHOLD = 2.0


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
    try:
        load1, load5, load15 = (float(value) for value in Path("/proc/loadavg").read_text().split()[:3])
        metrics["loadavg"] = {"1m": load1, "5m": load5, "15m": load15}
    except Exception:
        pass
    try:
        meminfo: dict[str, int] = {}
        for line in Path("/proc/meminfo").read_text().splitlines():
            key, value = line.split(":", 1)
            meminfo[key] = int(value.strip().split()[0])
        total = meminfo.get("MemTotal")
        available = meminfo.get("MemAvailable")
        if available is None:
            available = meminfo.get("MemFree", 0) + meminfo.get("Buffers", 0) + meminfo.get("Cached", 0)
            
        if total and available is not None:
            used = total - available
            metrics["memory"] = {
                "total_mb": round(total / 1024, 1),
                "available_mb": round(available / 1024, 1),
                "used_percent": round(used / total * 100, 1),
            }
    except Exception:
        pass
    try:
        uptime_seconds = float(Path("/proc/uptime").read_text().split()[0])
        metrics["uptime_seconds"] = round(uptime_seconds, 1)
    except Exception:
        pass
    try:
        res = subprocess.run(["npu-smi", "info"], capture_output=True, text=True, timeout=2.0)
        if res.returncode == 0:
            stdout = res.stdout
            parsed = False
            for line in stdout.splitlines():
                if "310B4" in line and "|" in line:
                    try:
                        npu_name_match = re.search(r"\|\s*\d+\s+([A-Za-z0-9\-\_]+)\s*\|", line)
                        npu_name = npu_name_match.group(1) if npu_name_match else "310B4"
                        
                        health_match = re.search(r"\|\s*(OK|Warning|Error|Alarm|NA)\s*\|", line, re.IGNORECASE)
                        health = health_match.group(1).upper() if health_match else "OK"
                        
                        mem_matches = re.findall(r"(\d+)\s+(\d+)\s*/\s*(\d+)", line)
                        if mem_matches:
                            last_match = mem_matches[-1]
                            aicore = int(last_match[0])
                            mem_used = int(last_match[1])
                            mem_total = int(last_match[2])
                        else:
                            continue
                            
                        pow_temp_match = re.search(r"\|\s*(?:OK|Warning|Error|Alarm|NA)\s*\|\s*([\d\.]+)\s+([\d\.]+)", line, re.IGNORECASE)
                        if pow_temp_match:
                            power = float(pow_temp_match.group(1))
                            temp = float(pow_temp_match.group(2))
                        else:
                            power, temp = 0.0, 0.0
                            
                        metrics["npu"] = {
                            "npu_id": 0,
                            "name": npu_name,
                            "health": health,
                            "temperature_c": temp,
                            "power_w": power,
                            "utilization_percent": aicore,
                            "memory_used_mb": mem_used,
                            "memory_total_mb": mem_total,
                            "memory_used_percent": round(mem_used / mem_total * 100, 1) if mem_total else 0.0,
                        }
                        parsed = True
                        break
                    except Exception:
                        pass
                        
            if not parsed and stdout.strip():
                metrics["npu"] = {
                    "raw_available": True,
                    "raw_preview": "\n".join(stdout.strip().splitlines()[:8]),
                }
        elif res.stderr.strip():
            metrics["npu"] = {
                "raw_available": False,
                "error": res.stderr.strip().splitlines()[0],
            }
    except Exception:
        pass
    return metrics


def compute_scheduling_decision(
    summary: dict[str, Any],
    detections: list[dict[str, Any]],
    system_metrics: dict[str, Any],
    force_cloud: bool = False,
    load_threshold: float = DEFAULT_LOAD_THRESHOLD,
) -> dict[str, Any]:
    """Multi-factor scheduling decision for edge-cloud task dispatch.

    Rules (evaluated in order):
    1. --force-cloud → always cloud
    2. total_count == 0 → local only
    3. person detected → cloud scene understanding
    4. vehicle detected → cloud traffic analysis
    5. avg confidence too low → cloud review
    6. edge system load too high → offload to cloud
    7. default → local only (few targets, good confidence)
    """
    if force_cloud:
        return {
            "handled_locally": False,
            "need_cloud_analysis": True,
            "reason": "用户指定强制云端分析（--force-cloud）。",
        }

    total = summary.get("total_count", 0)
    if total == 0:
        return {
            "handled_locally": True,
            "need_cloud_analysis": False,
            "reason": "YOLO 未检测到任何目标，本地完成无需上云。",
        }

    persons = summary.get("person_count", 0)
    vehicles = summary.get("vehicle_count", 0)

    if persons > 0:
        return {
            "handled_locally": False,
            "need_cloud_analysis": True,
            "reason": f"检测到 {persons} 人，触发云端场景理解与风险评估。",
        }

    if vehicles >= 1:
        return {
            "handled_locally": False,
            "need_cloud_analysis": True,
            "reason": f"检测到 {vehicles} 辆车，触发云端交通场景分析。",
        }

    confidences = [
        d.get("confidence", 0)
        for d in detections
        if isinstance(d.get("confidence"), (int, float))
    ]
    avg_conf = sum(confidences) / len(confidences) if confidences else 0
    if avg_conf < 0.7 and confidences:
        return {
            "handled_locally": False,
            "need_cloud_analysis": True,
            "reason": f"平均置信度 {avg_conf:.2f} 偏低，需云端复核检测结果。",
        }

    loadavg = system_metrics.get("loadavg", {}) if isinstance(system_metrics, dict) else {}
    if isinstance(loadavg, str):
        try:
            load_1m_val = float(loadavg.split()[0])
        except (ValueError, IndexError):
            load_1m_val = 0
    elif isinstance(loadavg, dict):
        load_1m_val = loadavg.get("1m", 0)
        try:
            load_1m_val = float(load_1m_val)
        except (TypeError, ValueError):
            load_1m_val = 0
    else:
        load_1m_val = 0
    if load_1m_val > load_threshold:
        return {
            "handled_locally": False,
            "need_cloud_analysis": True,
            "reason": f"边端负载较高（loadavg 1m={load_1m_val:.1f}，阈值={load_threshold:.1f}），卸载至云端处理。",
        }

    return {
        "handled_locally": True,
        "need_cloud_analysis": False,
        "reason": f"检测到 {total} 个目标（人:{persons} 车:{vehicles}），置信度充足，本地处理即可。",
    }


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

    system_metrics = collect_system_metrics()
    edge_decision = compute_scheduling_decision(
        summary, detections, system_metrics,
        force_cloud=args.force_cloud,
        load_threshold=args.load_threshold,
    )
    if args.reason:
        edge_decision["reason"] = args.reason
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
        "system_metrics": system_metrics,
        "edge_decision": edge_decision,
        "scheduling_config": {
            "load_threshold": args.load_threshold,
        },
    }


def check_health(server: str, timeout: int) -> None:
    url = server.rstrip("/") + "/api/health"
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as response:
            data = json.loads(response.read().decode("utf-8"))
            print(json.dumps(data, ensure_ascii=False, indent=2))
    except Exception as e:
        raise RequestException(str(e)) from e


def post_event(server: str, event: dict[str, Any], timeout: int, max_retries: int = 3) -> dict[str, Any]:
    last_error = None
    for attempt in range(1, max_retries + 1):
        try:
            url = server.rstrip("/") + "/api/edge/events"
            req = urllib.request.Request(
                url,
                data=json.dumps(event).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST"
            )
            with urllib.request.urlopen(req, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except Exception as exc:
            last_error = RequestException(str(exc))
            if attempt < max_retries:
                delay = 2 ** attempt
                print(f"[retry] POST failed (attempt {attempt}/{max_retries}), retrying in {delay}s: {exc}", file=sys.stderr)
                time.sleep(delay)
    raise last_error  # type: ignore[misc]


PENDING_DIR = Path("pending_events")


def save_pending_event(event: dict[str, Any]) -> Path:
    PENDING_DIR.mkdir(exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    filename = f"event_{timestamp}.json"
    path = PENDING_DIR / filename
    path.write_text(json.dumps(event, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[pending] event saved to {path}", file=sys.stderr)
    return path


def load_pending_events() -> list[tuple[Path, dict[str, Any]]]:
    if not PENDING_DIR.exists():
        return []
    events: list[tuple[Path, dict[str, Any]]] = []
    for path in sorted(PENDING_DIR.iterdir()):
        if path.suffix == ".json":
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                events.append((path, data))
            except (json.JSONDecodeError, OSError):
                print(f"[pending] skipping unreadable file: {path}", file=sys.stderr)
    return events


def retry_pending_events(server_url: str, timeout: int) -> int:
    pending = load_pending_events()
    if not pending:
        print("没有待重试的事件。")
        return 0
    success = 0
    for path, event in pending:
        try:
            result = post_event(server_url, event, timeout)
            path.unlink()
            print(f"[pending] retry success: {path.name} -> task_id={result.get('task_id', '')}")
            success += 1
        except RequestException as exc:
            print(f"[pending] retry failed: {path.name}: {exc}", file=sys.stderr)
    print(f"[pending] retry complete: {success}/{len(pending)} succeeded")
    return 0 if success == len(pending) else 1


def analyze_task(server: str, task_id: str, timeout: int) -> dict[str, Any]:
    url = server.rstrip("/") + "/api/edge/analyze"
    try:
        req = urllib.request.Request(
            url,
            data=json.dumps({"task_id": task_id}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except Exception as e:
        raise RequestException(str(e)) from e


def send_heartbeat(server: str, args: argparse.Namespace) -> dict[str, Any]:
    url = server.rstrip("/") + "/api/edge/heartbeat"
    payload = {
        "device_id": args.device_id,
        "hostname": socket.gethostname(),
        "system_metrics": collect_system_metrics(),
        "pending_events": len(load_pending_events()),
        "note": args.reason or "manual heartbeat",
    }
    try:
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=args.timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except Exception as e:
        raise RequestException(str(e)) from e


def watch_heartbeat(server: str, args: argparse.Namespace) -> int:
    print(f"[heartbeat] watching {server.rstrip('/')} every {args.interval}s. Press Ctrl+C to stop.", file=sys.stderr)
    while True:
        try:
            result = send_heartbeat(server, args)
            device = result.get("device", {}) if isinstance(result.get("device"), dict) else {}
            status = device.get("latest_status", "heartbeat")
            print(
                json.dumps(
                    {
                        "ok": result.get("ok", False),
                        "device_id": args.device_id,
                        "status": status,
                        "pending_events": len(load_pending_events()),
                        "time": utc_now(),
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        except RequestException as exc:
            print(f"[heartbeat] failed: {exc}", file=sys.stderr)
        time.sleep(max(1, args.interval))


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
    parser.add_argument("--load-threshold", type=float, default=DEFAULT_LOAD_THRESHOLD, help="loadavg 1m threshold for cloud offload decisions")
    parser.add_argument("--analyze", action="store_true", help="Ask cloud agent to analyze the task after upload")
    parser.add_argument("--health", action="store_true", help="Only check /api/health")
    parser.add_argument("--heartbeat", action="store_true", help="Send device heartbeat to /api/edge/heartbeat")
    parser.add_argument("--watch", action="store_true", help="Keep sending heartbeat until interrupted. Use with --heartbeat.")
    parser.add_argument("--interval", type=int, default=10, help="Heartbeat watch interval in seconds")
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--save-event", help="Save outgoing event JSON for debugging")
    parser.add_argument("--retry-pending", action="store_true", help="Retry all pending events from pending_events/ directory")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if args.health:
            check_health(args.server, args.timeout)
            return 0
        if args.heartbeat:
            if args.watch:
                return watch_heartbeat(args.server, args)
            result = send_heartbeat(args.server, args)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0
        if args.retry_pending:
            return retry_pending_events(args.server.rstrip("/"), args.timeout)

        event = build_event(args)
        if args.save_event:
            Path(args.save_event).write_text(json.dumps(event, ensure_ascii=False, indent=2), encoding="utf-8")

        started = time.time()
        try:
            result = post_event(args.server, event, args.timeout)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            if args.analyze and result.get("task_id"):
                try:
                    analysis = analyze_task(args.server, result["task_id"], max(args.timeout, 90))
                    print(json.dumps(analysis, ensure_ascii=False, indent=2))
                except RequestException as exc:
                    print(f"事件已成功上传 (task_id: {result.get('task_id')})，但触发云端分析失败或超时: {exc}", file=sys.stderr)
            print(f"elapsed_seconds={time.time() - started:.2f}", file=sys.stderr)
            return 0
        except RequestException as exc:
            saved = save_pending_event(event)
            print(f"上传失败，事件已保存到 {saved}。稍后使用 --retry-pending 重传。错误: {exc}", file=sys.stderr)
            return 1
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
