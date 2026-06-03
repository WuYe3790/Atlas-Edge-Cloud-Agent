from __future__ import annotations

import json
import base64
from pathlib import Path
from typing import Any

from flask import Blueprint, jsonify, request, send_from_directory

from server.bootstrap import PROJECT_ROOT
from travel_agent.agent import run_agent_with_trace
from travel_agent.config import load_llm_config
from travel_agent.storage import (
    create_edge_task,
    get_edge_task,
    list_edge_tasks,
    update_edge_task_analysis,
    update_edge_task_event,
)


edge_bp = Blueprint("edge", __name__)
EDGE_ARTIFACT_DIR = PROJECT_ROOT / "data" / "edge_artifacts"


@edge_bp.post("/api/edge/events")
def receive_edge_event():
    event = request.get_json(silent=True) or {}
    if not isinstance(event, dict):
        return jsonify({"ok": False, "error": "JSON body must be an object"}), 400

    event = _normalize_edge_event(event)
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


@edge_bp.get("/api/edge/tasks")
def edge_tasks():
    raw_limit = request.args.get("limit", "30")
    try:
        limit = min(100, max(1, int(raw_limit)))
    except ValueError:
        limit = 30
    return jsonify({"ok": True, "tasks": list_edge_tasks(limit=limit)})


@edge_bp.get("/api/edge/tasks/<task_id>")
def edge_task_detail(task_id: str):
    task = get_edge_task(task_id)
    if not task:
        return jsonify({"ok": False, "error": "Task not found"}), 404
    return jsonify({"ok": True, "task": task})


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
