from __future__ import annotations

import argparse
import base64
import json
import re
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import requests
import torch
from ais_bench.infer.interface import InferSession

from det_utils import letterbox, nms, scale_coords


DEFAULT_CFG = {
    "conf_thres": 0.4,
    "iou_thres": 0.5,
    "input_shape": [640, 640],
}
DEFAULT_LOAD_THRESHOLD = 2.0


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_labels(path: str | Path) -> dict[int, str]:
    labels: dict[int, str] = {}
    with Path(path).open(encoding="utf-8") as f:
        for index, line in enumerate(f):
            labels[index] = line.strip()
    return labels


def preprocess_image(image: np.ndarray, cfg: dict[str, Any], bgr2rgb: bool = True):
    img, scale_ratio, pad_size = letterbox(image, new_shape=cfg["input_shape"])
    if bgr2rgb:
        img = img[:, :, ::-1]
    img = img.transpose(2, 0, 1)
    img = np.ascontiguousarray(img, dtype=np.float32)
    return img, scale_ratio, pad_size


def draw_detections(image: np.ndarray, detections: list[dict[str, Any]]) -> np.ndarray:
    output = image.copy()
    for index, item in enumerate(detections):
        x1, y1, x2, y2 = [int(round(value)) for value in item["bbox"]]
        label = f"{index} {item['class_name']} {item['confidence']:.4f}"
        cv2.rectangle(output, (x1, y1), (x2, y2), (0, 255, 0), 2)
        cv2.putText(output, label, (x1, max(18, y1 + 18)), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 255), 2)
    return output


def summarize(detections: list[dict[str, Any]]) -> dict[str, Any]:
    counts: dict[str, int] = {}
    for item in detections:
        class_name = str(item.get("class_name") or "unknown")
        counts[class_name] = counts.get(class_name, 0) + 1
    return {
        "total_count": sum(counts.values()),
        "class_counts": counts,
        "person_count": counts.get("person", 0),
        "vehicle_count": sum(counts.get(name, 0) for name in ("car", "bus", "truck", "motorcycle", "bicycle")),
    }


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
    load_1m = loadavg.get("1m", 0) if isinstance(loadavg, dict) else 0
    try:
        load_1m = float(load_1m)
    except (TypeError, ValueError):
        load_1m = 0
    if load_1m > load_threshold:
        return {
            "handled_locally": False,
            "need_cloud_analysis": True,
            "reason": f"边端负载较高（loadavg 1m={load_1m:.1f}，阈值={load_threshold:.1f}），卸载至云端处理。",
        }

    return {
        "handled_locally": True,
        "need_cloud_analysis": False,
        "reason": f"检测到 {total} 个目标（人:{persons} 车:{vehicles}），置信度充足，本地处理即可。",
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
    except Exception:
        pass
    return metrics


def run_yolo(image_or_path: Path | np.ndarray, model_path: Path, label_path: Path, cfg: dict[str, Any]) -> tuple[list[dict[str, Any]], float]:
    if isinstance(image_or_path, Path):
        image = cv2.imread(str(image_or_path))
        if image is None:
            raise FileNotFoundError(f"Could not read image: {image_or_path}")
    else:
        image = image_or_path

    labels = load_labels(label_path)
    model = InferSession(0, str(model_path))

    started = time.perf_counter()
    img, scale_ratio, pad_size = preprocess_image(image, cfg)
    output = model.infer([img])[0]
    latency_ms = (time.perf_counter() - started) * 1000

    output_tensor = torch.tensor(output)
    boxout = nms(output_tensor, conf_thres=cfg["conf_thres"], iou_thres=cfg["iou_thres"])
    pred_all = boxout[0].numpy()
    if pred_all.size:
        scale_coords(cfg["input_shape"], pred_all[:, :4], image.shape, ratio_pad=(scale_ratio, pad_size))

    detections: list[dict[str, Any]] = []
    for row in pred_all:
        confidence = float(row[4])
        class_id = int(row[5])
        if confidence < cfg["conf_thres"]:
            continue
        detections.append(
            {
                "class_id": class_id,
                "class_name": labels.get(class_id, str(class_id)),
                "confidence": confidence,
                "bbox": [float(row[0]), float(row[1]), float(row[2]), float(row[3])],
            }
        )
    return detections, latency_ms


def build_event(
    args: argparse.Namespace,
    detections: list[dict[str, Any]],
    summary: dict[str, Any],
    latency_ms: float,
    annotated_image_path: Path | None = None,
    image_id: str | None = None,
    image_path_str: str | None = None,
) -> dict[str, Any]:
    fps = 1000.0 / latency_ms if latency_ms > 0 else None
    system_metrics = collect_system_metrics()
    edge_decision = compute_scheduling_decision(
        summary, detections, system_metrics,
        force_cloud=args.force_cloud,
        load_threshold=args.load_threshold,
    )
    if args.reason:
        edge_decision["reason"] = args.reason

    resolved_image_id = image_id or (Path(args.image).name if args.image else "camera_frame.jpg")
    resolved_image_path = image_path_str or (str(Path(args.image).resolve()) if args.image else "camera")

    event = {
        "device_id": args.device_id,
        "hostname": socket.gethostname(),
        "timestamp": utc_now(),
        "image_id": resolved_image_id,
        "image_path": resolved_image_path,
        "source_type": "camera_stream" if args.camera else "uploaded_image",
        "inference": {
            "model": Path(args.model).name,
            "latency_ms": round(latency_ms, 2),
            "fps": round(fps, 2) if fps else None,
            "conf_thres": args.conf_thres,
            "iou_thres": args.iou_thres,
        },
        "detections": detections,
        "summary": summary,
        "system_metrics": system_metrics,
        "edge_decision": edge_decision,
        "scheduling_config": {
            "load_threshold": args.load_threshold,
        },
    }
    if annotated_image_path and annotated_image_path.exists() and not args.no_image_payload:
        event["annotated_image"] = {
            "filename": annotated_image_path.name,
            "mime_type": "image/jpeg",
            "base64": base64.b64encode(annotated_image_path.read_bytes()).decode("ascii"),
        }
    return event


PENDING_DIR = Path("pending_events")


def post_json(url: str, payload: dict[str, Any], timeout: int, max_retries: int = 3) -> dict[str, Any]:
    last_error = None
    for attempt in range(1, max_retries + 1):
        try:
            response = requests.post(url, json=payload, timeout=timeout)
            response.raise_for_status()
            return response.json()
        except requests.RequestException as exc:
            last_error = exc
            if attempt < max_retries:
                delay = 2 ** attempt
                print(f"[retry] POST failed (attempt {attempt}/{max_retries}), retrying in {delay}s: {exc}", file=sys.stderr)
                time.sleep(delay)
    raise last_error  # type: ignore[misc]


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
            result = post_json(server_url + "/api/edge/events", event, timeout)
            path.unlink()
            print(f"[pending] retry success: {path.name} -> task_id={result.get('task_id', '')}")
            success += 1
        except requests.RequestException as exc:
            print(f"[pending] retry failed: {path.name}: {exc}", file=sys.stderr)
    print(f"[pending] retry complete: {success}/{len(pending)} succeeded")
    return 0 if success == len(pending) else 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run Atlas YOLO image inference and optionally upload result to laptop cloud service.")
    parser.add_argument("--image", default="", help="Input image path")
    parser.add_argument("--camera", default=None, help="Camera index (e.g. 0) or RTSP stream URL to process real-time frame stream.")
    parser.add_argument("--interval-sec", type=float, default=5.0, help="Interval in seconds between processing camera frames.")
    parser.add_argument("--model", default="yolo.om", help="Atlas OM model path")
    parser.add_argument("--labels", default="coco_names.txt", help="Label file path")
    parser.add_argument("--server", default="", help="Laptop cloud base URL, for example http://192.168.0.101:5000")
    parser.add_argument("--device-id", default="atlas-200i-dk-a2-01")
    parser.add_argument("--conf-thres", type=float, default=0.4)
    parser.add_argument("--iou-thres", type=float, default=0.5)
    parser.add_argument("--output-json", default="detections.json")
    parser.add_argument("--summary-json", default="summary.json")
    parser.add_argument("--annotated-image", default="annotated.jpg")
    parser.add_argument("--upload", action="store_true")
    parser.add_argument("--analyze", action="store_true", help="Deprecated: upload already triggers analysis by default")
    parser.add_argument("--no-analyze", action="store_true", help="Upload only, do not trigger cloud agent analysis")
    parser.add_argument("--no-image-payload", action="store_true", help="Do not include annotated image base64 in uploaded event")
    parser.add_argument("--force-cloud", action="store_true")
    parser.add_argument("--load-threshold", type=float, default=DEFAULT_LOAD_THRESHOLD, help="loadavg 1m threshold for cloud offload decisions")
    parser.add_argument("--reason", default="")
    parser.add_argument("--timeout", type=int, default=60)
    parser.add_argument("--retry-pending", action="store_true", help="Retry all pending events from pending_events/ directory")
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    # --retry-pending: flush saved events without running YOLO
    if args.retry_pending:
        if not args.server:
            raise ValueError("--server is required when --retry-pending is set")
        return retry_pending_events(args.server.rstrip("/"), args.timeout)

    # Validate image or camera
    if not args.camera and not args.image:
        raise ValueError("Either --image or --camera must be provided when not in --retry-pending mode")

    cfg = {
        **DEFAULT_CFG,
        "conf_thres": args.conf_thres,
        "iou_thres": args.iou_thres,
    }

    model_path = Path(args.model)
    label_path = Path(args.labels)
    annotated_image_path = Path(args.annotated_image)

    # 1. Camera Stream Mode
    if args.camera:
        camera_source: int | str = args.camera
        try:
            camera_source = int(args.camera)
        except ValueError:
            pass

        print(f"[camera] Opening video capture source: {camera_source}")
        cap = cv2.VideoCapture(camera_source)
        if not cap.isOpened():
            print(f"[camera] Error: Could not open video source {camera_source}", file=sys.stderr)
            return 1

        print(f"[camera] Starting real-time YOLO loop. Interval: {args.interval_sec}s. Press Ctrl+C to stop.")
        try:
            while True:
                # Flush the HTTP MJPEG buffer: grab all queued frames without
                # decoding, so retrieve() returns the freshest frame from the
                # camera instead of one buffered seconds ago.
                for _ in range(30):
                    cap.grab()
                ret, frame = cap.retrieve()
                if not ret:
                    print("[camera] Error: Could not read frame from camera. Retrying in 1s...", file=sys.stderr)
                    time.sleep(1.0)
                    continue

                started_time = datetime.now()
                timestamp_str = started_time.strftime("%Y%m%d_%H%M%S")
                image_id = f"frame_{timestamp_str}.jpg"

                detections, latency_ms = run_yolo(frame, model_path, label_path, cfg)
                summary = summarize(detections)

                # Save local JSONs and annotated images
                Path(args.output_json).write_text(json.dumps(detections, ensure_ascii=False, indent=2), encoding="utf-8")
                Path(args.summary_json).write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
                cv2.imwrite(str(annotated_image_path), draw_detections(frame, detections))

                event = build_event(
                    args, detections, summary, latency_ms,
                    annotated_image_path=annotated_image_path,
                    image_id=image_id,
                    image_path_str=f"camera_{camera_source}",
                )

                print(f"[camera] Frame processed. Latency: {latency_ms:.1f}ms, targets: {summary['total_count']}")

                if args.upload:
                    if not args.server:
                        print("[camera] Error: --server is required for uploading", file=sys.stderr)
                    else:
                        server_url = args.server.rstrip("/")
                        try:
                            result = post_json(server_url + "/api/edge/events", event, args.timeout)
                            print(f"[camera] Event uploaded successfully. task_id: {result.get('task_id')}")
                            should_analyze = not args.no_analyze
                            if should_analyze and result.get("task_id"):
                                try:
                                    analysis = post_json(
                                        server_url + "/api/edge/analyze",
                                        {"task_id": result["task_id"]},
                                        max(args.timeout, 120),
                                    )
                                    print(f"[camera] Cloud analysis complete for {result.get('task_id')}")
                                except requests.RequestException as exc:
                                    print(f"[camera] Warning: analysis trigger failed: {exc}", file=sys.stderr)
                        except requests.RequestException as exc:
                            saved = save_pending_event(event)
                            print(f"[camera] Upload failed. Event saved to retry queue: {saved}. Error: {exc}", file=sys.stderr)

                time.sleep(max(0.1, args.interval_sec))
        except KeyboardInterrupt:
            print("\n[camera] Loop stopped by user.")
        finally:
            cap.release()
        return 0

    # 2. Static Image Mode
    image_path = Path(args.image)
    detections, latency_ms = run_yolo(image_path, model_path, label_path, cfg)
    summary = summarize(detections)

    Path(args.output_json).write_text(json.dumps(detections, ensure_ascii=False, indent=2), encoding="utf-8")
    Path(args.summary_json).write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    image = cv2.imread(str(image_path))
    cv2.imwrite(str(annotated_image_path), draw_detections(image, detections))

    event = build_event(args, detections, summary, latency_ms, annotated_image_path=annotated_image_path)
    print(json.dumps(event, ensure_ascii=False, indent=2))

    if args.upload:
        if not args.server:
            raise ValueError("--server is required when --upload is set")
        server_url = args.server.rstrip("/")
        try:
            result = post_json(server_url + "/api/edge/events", event, args.timeout)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            should_analyze = not args.no_analyze
            if should_analyze and result.get("task_id"):
                try:
                    analysis = post_json(
                        server_url + "/api/edge/analyze",
                        {"task_id": result["task_id"]},
                        max(args.timeout, 120),
                    )
                    print(json.dumps(analysis, ensure_ascii=False, indent=2))
                except requests.RequestException as exc:
                    print(f"事件已成功上传 (task_id: {result.get('task_id')})，但触发云端分析失败或超时: {exc}", file=sys.stderr)
        except requests.RequestException as exc:
            saved = save_pending_event(event)
            print(f"上传失败，事件已保存到 {saved}。稍后使用 --retry-pending 重传。错误: {exc}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
