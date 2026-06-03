from __future__ import annotations

import json
import base64
from pathlib import Path
from datetime import datetime, timezone
from typing import Any

from flask import Blueprint, Response, jsonify, request, send_from_directory

from server.bootstrap import PROJECT_ROOT
from travel_agent.agent import run_agent_with_trace
from travel_agent.config import load_llm_config
from travel_agent.storage import (
    create_edge_task,
    get_edge_task,
    list_edge_devices,
    list_edge_tasks,
    update_edge_task_analysis,
    update_edge_task_event,
    upsert_edge_device,
)


edge_bp = Blueprint("edge", __name__)
EDGE_ARTIFACT_DIR = PROJECT_ROOT / "data" / "edge_artifacts"


@edge_bp.post("/api/edge/events")
def receive_edge_event():
    event = request.get_json(silent=True) or {}
    if not isinstance(event, dict):
        return jsonify({"ok": False, "error": "JSON body must be an object"}), 400

    event = _normalize_edge_event(event)
    upsert_edge_device(
        str(event.get("device_id") or "unknown-device"),
        str(event.get("hostname") or ""),
        {
            "source": "edge_event",
            "system_metrics": event.get("system_metrics") if isinstance(event.get("system_metrics"), dict) else {},
        },
    )
    task = create_edge_task(event, status="received")
    event = _save_embedded_artifacts(task["id"], event)
    task = update_edge_task_event(task["id"], event) or task
    need_cloud_analysis = bool(event.get("edge_decision", {}).get("need_cloud_analysis", True))
    return jsonify(
        {
            "ok": True,
            "task_id": task["id"],
            "cloud_analysis_required": need_cloud_analysis,
            "message": "Edge event received.",
        }
    )


@edge_bp.post("/api/edge/heartbeat")
def edge_heartbeat():
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return jsonify({"ok": False, "error": "JSON body must be an object"}), 400
    device_id = str(payload.get("device_id") or "atlas-200i-dk-a2-01")
    hostname = str(payload.get("hostname") or "")
    status = {
        "source": "heartbeat",
        "system_metrics": payload.get("system_metrics") if isinstance(payload.get("system_metrics"), dict) else {},
        "note": payload.get("note") or "",
    }
    device = upsert_edge_device(device_id, hostname, status)
    return jsonify({"ok": True, "device": device})


@edge_bp.get("/api/edge/tasks")
def edge_tasks():
    raw_limit = request.args.get("limit", "30")
    try:
        limit = min(100, max(1, int(raw_limit)))
    except ValueError:
        limit = 30
    return jsonify({"ok": True, "tasks": list_edge_tasks(limit=limit)})


@edge_bp.get("/api/edge/status")
def edge_status():
    tasks = list_edge_tasks(limit=200)
    devices: dict[str, dict[str, Any]] = {}
    now = datetime.now(timezone.utc)
    for device in list_edge_devices():
        age_seconds = _age_seconds(str(device.get("updated_at") or ""), now)
        status = device.get("status") if isinstance(device.get("status"), dict) else {}
        devices[str(device.get("device_id"))] = {
            "device_id": device.get("device_id"),
            "hostname": device.get("hostname") or "",
            "online": age_seconds is not None and age_seconds <= 300,
            "age_seconds": age_seconds,
            "last_seen": device.get("updated_at"),
            "latest_task_id": "",
            "latest_image_id": "",
            "latest_status": status.get("source") or "heartbeat",
            "latest_fps": None,
            "latest_latency_ms": None,
            "system_metrics": status.get("system_metrics") if isinstance(status.get("system_metrics"), dict) else {},
        }
    for task in tasks:
        event = task.get("event") or {}
        device_id = str(task.get("device_id") or event.get("device_id") or "unknown-device")
        updated_at = str(task.get("updated_at") or "")
        age_seconds = _age_seconds(updated_at, now)
        if device_id in devices and devices[device_id].get("last_seen", "") > updated_at:
            continue
        inference = event.get("inference") if isinstance(event.get("inference"), dict) else {}
        devices[device_id] = {
            "device_id": device_id,
            "hostname": event.get("hostname") or "",
            "online": age_seconds is not None and age_seconds <= 300,
            "age_seconds": age_seconds,
            "last_seen": updated_at,
            "latest_task_id": task.get("id"),
            "latest_image_id": task.get("image_id"),
            "latest_status": task.get("status"),
            "latest_fps": inference.get("fps"),
            "latest_latency_ms": inference.get("latency_ms"),
            "system_metrics": event.get("system_metrics") if isinstance(event.get("system_metrics"), dict) else {},
        }
    return jsonify({"ok": True, "devices": list(devices.values()), "task_count": len(tasks)})


@edge_bp.get("/api/edge/tasks/<task_id>")
def edge_task_detail(task_id: str):
    task = get_edge_task(task_id)
    if not task:
        return jsonify({"ok": False, "error": "Task not found"}), 404
    return jsonify({"ok": True, "task": task})


@edge_bp.get("/api/edge/tasks/<task_id>/report")
def edge_task_report(task_id: str):
    task = get_edge_task(task_id)
    if not task:
        return jsonify({"ok": False, "error": "Task not found"}), 404
    markdown = _build_task_report(task)
    return Response(
        markdown,
        mimetype="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename={task_id}-report.md"},
    )


@edge_bp.get("/api/edge/artifacts/<path:filename>")
def edge_artifact(filename: str):
    return send_from_directory(EDGE_ARTIFACT_DIR, filename)


@edge_bp.post("/api/edge/analyze")
def analyze_edge_task():
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return jsonify({"ok": False, "error": "JSON body must be an object"}), 400

    task_id = str(payload.get("task_id") or "").strip()
    task = get_edge_task(task_id) if task_id else None
    if not task:
        event = _normalize_edge_event(payload.get("event") if isinstance(payload.get("event"), dict) else payload)
        task = create_edge_task(event, status="received")
        task_id = task["id"]

    prompt = _build_edge_analysis_prompt(task)
    config = load_llm_config()
    answer, trace, structured_data = run_agent_with_trace(
        prompt,
        config,
        thinking_mode=bool(payload.get("thinking_mode", True)),
        message_history=[],
        client_context="你正在处理 Atlas 200I DK A2 边端 YOLO 检测结果，请优先给出场景理解、风险等级和调度建议。",
    )
    analysis = {
        "answer": answer,
        "trace": trace,
        "structured_data": structured_data,
    }
    updated = update_edge_task_analysis(task_id, analysis, status="completed")
    return jsonify({"ok": True, "task": updated, "analysis": analysis})


def _normalize_edge_event(event: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(event)
    normalized.setdefault("device_id", "atlas-200i-dk-a2-01")
    normalized.setdefault("source_type", "uploaded_image")
    normalized.setdefault("detections", [])
    normalized.setdefault("summary", _summarize_detections(normalized.get("detections")))
    normalized.setdefault(
        "edge_decision",
        {
            "handled_locally": True,
            "need_cloud_analysis": True,
            "reason": "Default cloud analysis request.",
        },
    )
    return normalized


def _save_embedded_artifacts(task_id: str, event: dict[str, Any]) -> dict[str, Any]:
    image_payload = event.pop("annotated_image", None)
    if not isinstance(image_payload, dict):
        return event
    raw_base64 = image_payload.get("base64")
    if not isinstance(raw_base64, str) or not raw_base64:
        return event
    try:
        image_bytes = base64.b64decode(raw_base64, validate=True)
    except Exception:
        return event
    if not image_bytes:
        return event
    EDGE_ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    filename = _safe_artifact_name(task_id, image_payload.get("filename") or "annotated.jpg")
    path = EDGE_ARTIFACT_DIR / filename
    path.write_bytes(image_bytes)
    event["annotated_image_url"] = f"/api/edge/artifacts/{filename}"
    event["annotated_image_filename"] = filename
    return event


def _safe_artifact_name(task_id: str, filename: Any) -> str:
    suffix = Path(str(filename)).suffix.lower()
    if suffix not in {".jpg", ".jpeg", ".png", ".webp"}:
        suffix = ".jpg"
    return f"{task_id}-annotated{suffix}"


def _age_seconds(value: str, now: datetime) -> float | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return round((now - dt).total_seconds(), 1)


def _summarize_detections(detections: Any) -> dict[str, Any]:
    counts: dict[str, int] = {}
    if isinstance(detections, list):
        for item in detections:
            if not isinstance(item, dict):
                continue
            class_name = str(item.get("class_name") or item.get("label") or "unknown")
            counts[class_name] = counts.get(class_name, 0) + 1
    return {"total_count": sum(counts.values()), "class_counts": counts}


def _build_edge_analysis_prompt(task: dict[str, Any]) -> str:
    event = task.get("event") or {}
    compact_event = json.dumps(event, ensure_ascii=False, indent=2)
    return f"""
请基于下面的 Atlas 200I DK A2 边端 YOLO 检测事件生成云端智能体分析报告。

要求：
1. 先说明边端本地完成了哪些简单任务。
2. 再说明为什么该任务需要或不需要云端复杂分析。
3. 给出场景理解、风险等级、处理建议。
4. 如果检测结果不足以判断，请明确说明限制，不要编造摄像头或实时视频信息。
5. 输出内容适合展示在课程大作业管理平台中。

边端事件 JSON：
{compact_event}
""".strip()


def _build_task_report(task: dict[str, Any]) -> str:
    event = task.get("event") or {}
    inference = event.get("inference") if isinstance(event.get("inference"), dict) else {}
    summary = event.get("summary") if isinstance(event.get("summary"), dict) else {}
    counts = summary.get("class_counts") if isinstance(summary.get("class_counts"), dict) else {}
    detections = event.get("detections") if isinstance(event.get("detections"), list) else []
    analysis = task.get("analysis") if isinstance(task.get("analysis"), dict) else {}
    lines = [
        f"# Atlas 边云协同任务报告",
        "",
        f"- 任务 ID: `{task.get('id')}`",
        f"- 设备 ID: `{task.get('device_id')}`",
        f"- 图片: `{task.get('image_id')}`",
        f"- 状态: `{task.get('status')}`",
        f"- 模型: `{inference.get('model', '')}`",
        f"- 推理延迟: `{inference.get('latency_ms', '')}` ms",
        f"- FPS: `{inference.get('fps', '')}`",
        "",
        "## 边端检测摘要",
        "",
        f"- 总目标数: `{summary.get('total_count', 0)}`",
        f"- 类别统计: `{json.dumps(counts, ensure_ascii=False)}`",
        "",
        "## 检测明细",
        "",
    ]
    if detections:
        for index, item in enumerate(detections, 1):
            lines.append(
                f"{index}. `{item.get('class_name')}` confidence=`{item.get('confidence')}` bbox=`{item.get('bbox')}`"
            )
    else:
        lines.append("- 无检测目标")
    lines.extend(["", "## 云端 Agent 分析", ""])
    lines.append(str(analysis.get("answer") or "尚未生成云端分析。"))
    return "\n".join(lines) + "\n"
