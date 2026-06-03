from __future__ import annotations

import argparse
import json
import socket
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


def run_yolo(image_path: Path, model_path: Path, label_path: Path, cfg: dict[str, Any]) -> tuple[list[dict[str, Any]], float]:
    image = cv2.imread(str(image_path))
    if image is None:
        raise FileNotFoundError(f"Could not read image: {image_path}")

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


def build_event(args: argparse.Namespace, detections: list[dict[str, Any]], summary: dict[str, Any], latency_ms: float) -> dict[str, Any]:
    fps = 1000.0 / latency_ms if latency_ms > 0 else None
    need_cloud = args.force_cloud or summary["total_count"] > 0
    return {
        "device_id": args.device_id,
        "hostname": socket.gethostname(),
        "timestamp": utc_now(),
        "image_id": Path(args.image).name,
        "image_path": str(Path(args.image).resolve()),
        "source_type": "uploaded_image",
        "inference": {
            "model": Path(args.model).name,
            "latency_ms": round(latency_ms, 2),
            "fps": round(fps, 2) if fps else None,
            "conf_thres": args.conf_thres,
            "iou_thres": args.iou_thres,
        },
        "detections": detections,
        "summary": summary,
        "edge_decision": {
            "handled_locally": True,
            "need_cloud_analysis": need_cloud,
            "reason": args.reason or ("YOLO detected targets; cloud semantic analysis requested." if need_cloud else "No target detected."),
        },
    }


def post_json(url: str, payload: dict[str, Any], timeout: int) -> dict[str, Any]:
    response = requests.post(url, json=payload, timeout=timeout)
    response.raise_for_status()
    return response.json()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run Atlas YOLO image inference and optionally upload result to laptop cloud service.")
    parser.add_argument("--image", required=True, help="Input image path")
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
    parser.add_argument("--analyze", action="store_true")
    parser.add_argument("--force-cloud", action="store_true")
    parser.add_argument("--reason", default="")
    parser.add_argument("--timeout", type=int, default=60)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    cfg = {
        **DEFAULT_CFG,
        "conf_thres": args.conf_thres,
        "iou_thres": args.iou_thres,
    }

    image_path = Path(args.image)
    model_path = Path(args.model)
    label_path = Path(args.labels)
    detections, latency_ms = run_yolo(image_path, model_path, label_path, cfg)
    summary = summarize(detections)

    Path(args.output_json).write_text(json.dumps(detections, ensure_ascii=False, indent=2), encoding="utf-8")
    Path(args.summary_json).write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    image = cv2.imread(str(image_path))
    cv2.imwrite(args.annotated_image, draw_detections(image, detections))

    event = build_event(args, detections, summary, latency_ms)
    print(json.dumps(event, ensure_ascii=False, indent=2))

    if args.upload:
        if not args.server:
            raise ValueError("--server is required when --upload is set")
        result = post_json(args.server.rstrip("/") + "/api/edge/events", event, args.timeout)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if args.analyze and result.get("task_id"):
            analysis = post_json(
                args.server.rstrip("/") + "/api/edge/analyze",
                {"task_id": result["task_id"]},
                max(args.timeout, 120),
            )
            print(json.dumps(analysis, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
