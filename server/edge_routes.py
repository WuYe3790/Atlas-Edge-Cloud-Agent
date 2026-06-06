from __future__ import annotations

import json
import base64
from pathlib import Path
from datetime import datetime, timezone
from typing import Any

from flask import Blueprint, Response, jsonify, request, send_from_directory
import os
import socket
import time
import paramiko

from server.bootstrap import PROJECT_ROOT
from server.vision_analyzer import (
    analyze_with_vision,
    analyze_video_with_vision,
    load_vision_config,
)
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
    complete_edge_task_only,
)


edge_bp = Blueprint("edge", __name__)
EDGE_ARTIFACT_DIR = PROJECT_ROOT / "data" / "edge_artifacts"
DEFAULT_LOAD_THRESHOLD = 2.0


import threading

yolo_status_lock = threading.Lock()
YOLO_STATUS = {
    "state": "idle",       # "idle", "running_board", "running_cloud"
    "file_path": None
}

def set_yolo_status(state: str, file_path: str | None = None):
    with yolo_status_lock:
        YOLO_STATUS["state"] = state
        if file_path is not None:
            YOLO_STATUS["file_path"] = file_path
        elif state == "idle":
            YOLO_STATUS["file_path"] = None



@edge_bp.after_request
def add_cache_control_headers(response):
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response



@edge_bp.post("/api/edge/events")
def receive_edge_event():
    event = request.get_json(silent=True) or {}
    if not isinstance(event, dict):
        return jsonify({"ok": False, "error": "JSON body must be an object"}), 400

    event = _normalize_edge_event(event)
    
    device_id_raw = str(event.get("device_id") or "unknown-device")
    parent_task_id = None
    if "|" in device_id_raw:
        device_id, parent_task_id = device_id_raw.split("|", 1)
        event["device_id"] = device_id
    else:
        device_id = device_id_raw

    upsert_edge_device(
        device_id,
        str(event.get("hostname") or ""),
        {
            "source": "edge_event",
            "system_metrics": event.get("system_metrics") if isinstance(event.get("system_metrics"), dict) else {},
        },
    )
    
    if parent_task_id:
        parent_task = get_edge_task(parent_task_id)
        if parent_task:
            parent_event = parent_task.get("event") or {}
            parent_event["source_type"] = "video"
            if "frames" not in parent_event:
                parent_event["frames"] = []
            
            event = _save_embedded_artifacts(parent_task_id, event)
            
            frame_idx = len(parent_event["frames"])
            frame_item = {
                "frame_index": frame_idx,
                "image_id": event.get("image_id"),
                "annotated_image_url": event.get("annotated_image_url"),
                "detections": event.get("detections", []),
                "summary": event.get("summary", {}),
                "inference": event.get("inference", {}),
                "edge_decision": event.get("edge_decision", {}),
                "timestamp": event.get("timestamp") or datetime.now().isoformat(),
            }
            parent_event["frames"].append(frame_item)
            
            # Update parent metadata to reflect the latest frame
            parent_event["image_id"] = event.get("image_id")
            parent_event["annotated_image_url"] = event.get("annotated_image_url")
            parent_event["detections"] = event.get("detections", [])
            parent_event["summary"] = event.get("summary", {})
            parent_event["inference"] = event.get("inference", {})
            
            task = update_edge_task_event(parent_task_id, parent_event) or parent_task
            need_cloud_analysis = bool(event.get("edge_decision", {}).get("need_cloud_analysis", True))
            return jsonify(
                {
                    "ok": True,
                    "task_id": parent_task_id,
                    "cloud_analysis_required": need_cloud_analysis,
                    "message": f"Frame aggregated into video task {parent_task_id}.",
                }
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
    source = "dashboard_manual_heartbeat" if payload.get("source") == "dashboard_manual" else "heartbeat"
    status = {
        "source": source,
        "system_metrics": payload.get("system_metrics") if isinstance(payload.get("system_metrics"), dict) else {},
        "note": payload.get("note") or "",
        "pending_events": payload.get("pending_events", 0) if isinstance(payload.get("pending_events"), int) else 0,
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
            "online": age_seconds is not None and age_seconds <= 20,
            "age_seconds": age_seconds,
            "last_seen": device.get("updated_at"),
            "latest_task_id": "",
            "latest_image_id": "",
            "latest_status": status.get("source") or "heartbeat",
            "latest_fps": None,
            "latest_latency_ms": None,
            "system_metrics": status.get("system_metrics") if isinstance(status.get("system_metrics"), dict) else {},
            "pending_events": status.get("pending_events", 0),
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
            "online": age_seconds is not None and age_seconds <= 20,
            "age_seconds": age_seconds,
            "last_seen": updated_at,
            "latest_task_id": task.get("id"),
            "latest_image_id": task.get("image_id"),
            "latest_status": task.get("status"),
            "latest_fps": inference.get("fps"),
            "latest_latency_ms": inference.get("latency_ms"),
            "system_metrics": event.get("system_metrics") if isinstance(event.get("system_metrics"), dict) else {},
            "pending_events": (devices.get(device_id, {}) if device_id in devices else {}).get("pending_events", 0),
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
        mimetype="text/markdown",
        headers={"Content-Disposition": f"attachment; filename={task_id}-report.md"},
    )


@edge_bp.get("/api/edge/tasks/<task_id>/report/html")
def edge_task_report_html(task_id: str):
    task = get_edge_task(task_id)
    if not task:
        return jsonify({"ok": False, "error": "Task not found"}), 404

    event = task.get("event") or {}
    inference = event.get("inference") if isinstance(event.get("inference"), dict) else {}
    summary = event.get("summary") if isinstance(event.get("summary"), dict) else {}
    detections = event.get("detections") if isinstance(event.get("detections"), list) else []
    system_metrics = event.get("system_metrics") if isinstance(event.get("system_metrics"), dict) else {}
    edge_decision = event.get("edge_decision") if isinstance(event.get("edge_decision"), dict) else {}
    analysis = task.get("analysis") if isinstance(task.get("analysis"), dict) else {}
    trace = analysis.get("trace") if isinstance(analysis.get("trace"), list) else []
    annotated_url = event.get("annotated_image_url", "")

    from flask import render_template_string

    html_template = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>边云协同任务报告 - {{ task_id }}</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+SC:wght@400;500;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg: #f8fafc;
            --text: #0f172a;
            --muted: #64748b;
            --line: #e2e8f0;
            --primary: #3b82f6;
            --success: #10b981;
            --warning: #f59e0b;
        }
        body {
            font-family: 'Inter', 'Noto Sans SC', sans-serif;
            background: var(--bg);
            color: var(--text);
            margin: 0;
            padding: 40px 20px;
            display: flex;
            justify-content: center;
        }
        .report-card {
            background: #ffffff;
            width: 100%;
            max-width: 850px;
            padding: 40px;
            border-radius: 16px;
            box-shadow: 0 10px 25px rgba(15, 23, 42, 0.05);
            border: 1px solid var(--line);
        }
        .report-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            border-bottom: 2px solid var(--line);
            padding-bottom: 20px;
            margin-bottom: 24px;
        }
        .report-title h1 {
            margin: 0;
            font-size: 24px;
            font-weight: 700;
        }
        .report-title p {
            margin: 5px 0 0;
            color: var(--muted);
            font-size: 13px;
        }
        .status-badge {
            padding: 4px 12px;
            border-radius: 999px;
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
        }
        .status-badge.completed { background: #d1fae5; color: #065f46; }
        .status-badge.received { background: #dbeafe; color: #1e40af; }
        
        .info-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 16px;
            margin-bottom: 30px;
        }
        .info-item {
            background: #f1f5f9;
            padding: 12px 16px;
            border-radius: 8px;
        }
        .info-item span {
            display: block;
            font-size: 11px;
            color: var(--muted);
            text-transform: uppercase;
            margin-bottom: 4px;
        }
        .info-item strong {
            font-size: 14px;
            color: var(--text);
            word-break: break-all;
        }
        
        .section-title {
            font-size: 16px;
            font-weight: 700;
            border-bottom: 1px solid var(--line);
            padding-bottom: 8px;
            margin: 30px 0 16px;
        }
        
        .annotated-img {
            width: 100%;
            border-radius: 12px;
            border: 1px solid var(--line);
            margin-bottom: 20px;
        }
        
        table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 20px;
        }
        th, td {
            text-align: left;
            padding: 10px 12px;
            border-bottom: 1px solid var(--line);
            font-size: 13px;
        }
        th { background: #f8fafc; font-weight: 600; }
        
        .metric-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 12px;
            font-size: 13px;
        }
        .metric-label { width: 120px; font-weight: 500; }
        .metric-bar-bg {
            flex: 1;
            background: #e2e8f0;
            height: 10px;
            border-radius: 999px;
            margin: 0 16px;
            overflow: hidden;
        }
        .metric-bar-fill {
            height: 100%;
            border-radius: 999px;
        }
        .metric-bar-fill.cpu { background: var(--primary); }
        .metric-bar-fill.memory { background: var(--success); }
        .metric-bar-fill.npu { background: var(--warning); }
        .metric-value { width: 140px; text-align: right; color: var(--muted); }
        
        .analysis-content {
            line-height: 1.6;
            font-size: 14px;
        }
        .analysis-content p { margin: 0 0 12px; }
        .analysis-content ul, .analysis-content ol { margin: 0 0 12px; padding-left: 20px; }
        .analysis-content li { margin-bottom: 4px; }
        
        .trace-timeline {
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
        .trace-node {
            display: flex;
            gap: 12px;
            padding: 10px 14px;
            border-radius: 8px;
            border: 1px solid var(--line);
            background: #fafbfc;
            font-size: 13px;
        }
        .trace-node.tool_call { border-left: 4px solid var(--primary); }
        .trace-node.llm_response { border-left: 4px solid var(--success); }
        .trace-node-icon { font-size: 16px; }
        .trace-node-body { flex: 1; }
        .trace-node-header { display: flex; justify-content: space-between; margin-bottom: 4px; }
        .trace-node-name { font-weight: 600; }
        .trace-node-duration { font-size: 11px; color: var(--muted); }
        .trace-node-details { font-size: 12px; color: var(--muted); margin-top: 4px; }
        
        @media print {
            body { padding: 0; background: #fff; }
            .report-card { border: 0; box-shadow: none; padding: 0; max-width: 100%; }
            .trace-timeline, .section-title:last-of-type, .trace-timeline + * { page-break-inside: avoid; }
        }
    </style>
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
</head>
<body>
    <div class="report-card">
        <header class="report-header">
            <div class="report-title">
                <h1>边云协同任务报告</h1>
                <p>Task ID: {{ task_id }}</p>
            </div>
            <span class="status-badge {{ status_class }}">{{ status }}</span>
        </header>
        
        <div class="info-grid">
            <div class="info-item"><span>设备 ID</span><strong>{{ device_id }}</strong></div>
            <div class="info-item"><span>主机名</span><strong>{{ hostname }}</strong></div>
            <div class="info-item"><span>更新时间</span><strong>{{ updated_at }}</strong></div>
            <div class="info-item"><span>图片 ID</span><strong>{{ image_id }}</strong></div>
        </div>
        
        <h2 class="section-title">推理性能</h2>
        <div class="info-grid">
            <div class="info-item"><span>模型</span><strong>{{ inference.model }}</strong></div>
            <div class="info-item"><span>推理延迟</span><strong>{{ inference.latency_ms }} ms</strong></div>
            <div class="info-item"><span>FPS</span><strong>{{ inference.fps }}</strong></div>
            <div class="info-item"><span>调度决策</span><strong>{{ edge_decision.handled_locally and '本地处理' or '云端决策' }}</strong></div>
        </div>
        
        {% if annotated_url %}
        <h2 class="section-title">标注图像</h2>
        <img class="annotated-img" src="{{ annotated_url }}" alt="标注图像">
        {% endif %}
        
        <h2 class="section-title">目标检测明细 (共 {{ detections|length }} 个目标)</h2>
        {% if detections %}
        <table>
            <thead>
                <tr>
                    <th>#</th>
                    <th>类别</th>
                    <th>类别 ID</th>
                    <th>置信度</th>
                    <th>边界框 (x1, y1, x2, y2)</th>
                </tr>
            </thead>
            <tbody>
                {% for d in detections %}
                <tr>
                    <td>{{ loop.index }}</td>
                    <td><strong>{{ d.class_name }}</strong></td>
                    <td>{{ d.class_id }}</td>
                    <td>{{ (d.confidence * 100)|round(1) }}%</td>
                    <td>{{ d.bbox|map('round', 1)|join(', ') }}</td>
                </tr>
                {% endfor %}
            </tbody>
        </table>
        {% else %}
        <p style="color: var(--muted); font-size: 13px;">无检测目标</p>
        {% endif %}
        
        <h2 class="section-title">系统指标</h2>
        {% if system_metrics %}
        <div style="margin-bottom: 24px;">
            {% if system_metrics.memory %}
            <div class="metric-row">
                <span class="metric-label">内存使用率</span>
                <div class="metric-bar-bg">
                    <div class="metric-bar-fill memory" style="width: {{ system_metrics.memory.used_percent }}%"></div>
                </div>
                <span class="metric-value">{{ system_metrics.memory.used_percent }}% ({{ system_metrics.memory.available_mb }}MB 可用)</span>
            </div>
            {% endif %}
            
            {% if system_metrics.loadavg %}
            <div class="metric-row">
                <span class="metric-label">系统负载 (1m)</span>
                {% set load_val = (system_metrics.loadavg is string) and (system_metrics.loadavg.split()[0]|float) or (system_metrics.loadavg['1m']|float) %}
                {% set load_pct = [load_val * 33, 100]|min %}
                <div class="metric-bar-bg">
                    <div class="metric-bar-fill cpu" style="width: {{ load_pct }}%"></div>
                </div>
                <span class="metric-value">负载: {{ load_val }}</span>
            </div>
            {% endif %}
            
            {% if system_metrics.npu %}
            <div class="metric-row">
                <span class="metric-label">NPU 使用率</span>
                <div class="metric-bar-bg">
                    <div class="metric-bar-fill npu" style="width: {{ system_metrics.npu.utilization_percent }}%"></div>
                </div>
                <span class="metric-value">{{ system_metrics.npu.utilization_percent }}% ({{ system_metrics.npu.temperature_c }}℃)</span>
            </div>
            {% endif %}
        </div>
        {% else %}
        <p style="color: var(--muted); font-size: 13px;">无系统指标</p>
        {% endif %}
        
        <h2 class="section-title">云端 Agent 分析</h2>
        <div id="analysis-box" class="analysis-content">
            {{ analysis_markdown|tojson }}
        </div>
        
        {% if trace %}
        <h2 class="section-title">智能体执行追踪</h2>
        <div class="trace-timeline">
            {% for item in trace %}
            {% if item.type == 'tool_call' %}
            <div class="trace-node tool_call">
                <div class="trace-node-icon">🔧</div>
                <div class="trace-node-body">
                    <div class="trace-node-header">
                        <span class="trace-node-name">调用工具: {{ item.tool }}</span>
                        <span class="trace-node-duration">{{ item.duration_ms }}ms</span>
                    </div>
                    <div class="trace-node-details">参数: {{ item.args|tojson }}</div>
                    {% if item.result %}
                    <div class="trace-node-details" style="color:var(--text); margin-top:4px;"><strong>返回:</strong> {{ item.result[:200] }}{{ item.result|length > 200 and '...' or '' }}</div>
                    {% endif %}
                </div>
            </div>
            {% elif item.type == 'llm_response' %}
            <div class="trace-node llm_response">
                <div class="trace-node-icon">🤖</div>
                <div class="trace-node-body">
                    <div class="trace-node-header">
                        <span class="trace-node-name">模型响应: {{ item.model }}</span>
                        <span class="trace-node-duration">Token 消耗: {{ item.usage.total_tokens or '未知' }}</span>
                    </div>
                    <div class="trace-node-details">状态: {{ item.status }}</div>
                </div>
            </div>
            {% endif %}
            {% endfor %}
        </div>
        {% endif %}
    </div>
    
    <script>
        const mdText = JSON.parse(document.getElementById('analysis-box').textContent);
        document.getElementById('analysis-box').innerHTML = marked.parse(mdText || '尚未生成分析结果');
    </script>
</body>
</html>"""

    rendered = render_template_string(
        html_template,
        task_id=task.get("id"),
        status=task.get("status"),
        status_class=task.get("status", "").lower(),
        device_id=task.get("device_id"),
        hostname=event.get("hostname", ""),
        updated_at=task.get("updated_at"),
        image_id=task.get("image_id"),
        inference=inference,
        edge_decision=edge_decision,
        annotated_url=annotated_url,
        detections=detections,
        summary=summary,
        system_metrics=system_metrics,
        analysis_markdown=analysis.get("answer") or "尚未生成云端分析。",
        trace=trace
    )
    return Response(rendered, mimetype="text/html")


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

    mode = str(payload.get("mode") or "both").strip()
    thinking_mode = bool(payload.get("thinking_mode", True))
    vision_config = load_vision_config()

    text_result: dict[str, Any] | None = None
    vision_result: dict[str, Any] | None = None

    import concurrent.futures
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        futures = {}
        if mode in ("text", "both"):
            futures["text"] = executor.submit(_run_text_analysis, task, thinking_mode)
        if mode in ("vision", "both") and vision_config.is_available:
            futures["vision"] = executor.submit(analyze_with_vision, task)
        elif mode == "vision" and not vision_config.is_available:
            return jsonify({"ok": False, "error": "VISION_API_KEY 未配置"}), 400

        concurrent.futures.wait(futures.values())
        
        if "text" in futures:
            try:
                text_result = futures["text"].result()
            except Exception as exc:
                text_result = {"answer": "", "trace": [], "model": "", "error": str(exc)}
        if "vision" in futures:
            try:
                vision_result = futures["vision"].result()
            except Exception as exc:
                vision_result = {"answer": "", "model": "", "error": str(exc), "media_type": "image"}

    # Merge answers
    answer_parts: list[str] = []
    if vision_result and vision_result.get("answer"):
        answer_parts.append(vision_result["answer"])
    if text_result and text_result.get("answer"):
        label = "\n\n---\n\n## 📊 文本推理补充（DeepSeek）\n\n" if vision_result and vision_result.get("answer") else ""
        answer_parts.append(label + text_result["answer"])

    combined_answer = "\n\n".join(answer_parts) if answer_parts else "分析失败。"

    analysis = {
        "answer": combined_answer,
        "trace": (text_result or {}).get("trace", []),
        "structured_data": (text_result or {}).get("structured_data"),
        "mode": mode,
        "media_type": "image",
        "frame_count": 1,
        "text_analysis": text_result,
        "vision_analysis": vision_result,
    }

    updated = update_edge_task_analysis(task_id, analysis, status="completed")
    return jsonify({"ok": True, "task": updated, "analysis": analysis})


def _run_text_analysis(task: dict[str, Any], thinking_mode: bool = True) -> dict[str, Any]:
    prompt = _build_edge_analysis_prompt(task)
    config = load_llm_config()
    answer, trace, structured_data = run_agent_with_trace(
        prompt,
        config,
        thinking_mode=thinking_mode,
        message_history=[],
        client_context="你正在处理 Atlas 200I DK A2 边端 YOLO 检测结果，请优先给出场景理解、风险等级和调度建议。",
    )
    return {
        "answer": answer,
        "trace": trace,
        "structured_data": structured_data,
        "model": config.thinking_model if thinking_mode else config.model,
    }


@edge_bp.post("/api/edge/analyze/video")
def analyze_video_task():
    """对多个帧进行视频级别的多模态场景分析。

    POST /api/edge/analyze/video
    {
        "task_ids": ["edge-xxx", "edge-yyy", ...],
        "mode": "vision" | "both" | "text",
        "thinking_mode": true  # 仅 text 路径使用
    }
    """
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return jsonify({"ok": False, "error": "JSON body must be an object"}), 400

    task_ids = payload.get("task_ids")
    if not isinstance(task_ids, list) or len(task_ids) < 1:
        return jsonify({
            "ok": False,
            "error": "task_ids 必须是一个包含至少 1 个 task ID 的数组"
        }), 400

    mode = str(payload.get("mode") or "both").strip()
    thinking_mode = bool(payload.get("thinking_mode", True))
    vision_config = load_vision_config()

    text_result: dict[str, Any] | None = None
    vision_result: dict[str, Any] | None = None

    import concurrent.futures
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        futures = {}
        if mode in ("text", "both"):
            first_task = get_edge_task(str(task_ids[0]))
            if first_task:
                futures["text"] = executor.submit(_run_text_analysis, first_task, thinking_mode)
        if mode in ("vision", "both") and vision_config.is_available:
            futures["vision"] = executor.submit(analyze_video_with_vision, task_ids)
        elif mode == "vision" and not vision_config.is_available:
            return jsonify({"ok": False, "error": "VISION_API_KEY 未配置"}), 400

        concurrent.futures.wait(futures.values())

        if "text" in futures:
            try:
                text_result = futures["text"].result()
            except Exception as exc:
                text_result = {"answer": "", "trace": [], "model": "", "error": str(exc)}
        if "vision" in futures:
            try:
                vision_result = futures["vision"].result()
            except Exception as exc:
                vision_result = {
                    "answer": "", "model": "",
                    "error": str(exc),
                    "media_type": "video", "frame_count": 0,
                }

    # Merge answers
    answer_parts: list[str] = []
    if vision_result and vision_result.get("answer"):
        answer_parts.append(vision_result["answer"])
    if text_result and text_result.get("answer"):
        label = "\n\n---\n\n## 📊 文本推理补充（DeepSeek）\n\n" if vision_result and vision_result.get("answer") else ""
        answer_parts.append(label + text_result["answer"])

    combined_answer = "\n\n".join(answer_parts) if answer_parts else "分析失败。"

    analysis = {
        "answer": combined_answer,
        "trace": (text_result or {}).get("trace", []),
        "structured_data": (text_result or {}).get("structured_data"),
        "mode": mode,
        "media_type": "video",
        "frame_count": len(task_ids),
        "frame_task_ids": task_ids,
        "text_analysis": text_result,
        "vision_analysis": vision_result,
    }

    # 将分析结果写回第一帧 task（让前端能通过第一帧找到分析结果）
    updated = update_edge_task_analysis(str(task_ids[0]), analysis, status="completed")
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
    return {
        "total_count": sum(counts.values()),
        "class_counts": counts,
        "person_count": counts.get("person", 0),
        "vehicle_count": sum(counts.get(name, 0) for name in ("car", "bus", "truck", "motorcycle", "bicycle")),
    }


def _compute_scheduling(
    summary: dict[str, Any],
    detections: list[dict[str, Any]],
    system_metrics: dict[str, Any],
    force_cloud: bool = False,
    load_threshold: float = DEFAULT_LOAD_THRESHOLD,
) -> dict[str, Any]:
    """Server-side scheduling decision matching edge-side logic."""
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
        load_1m_val = float(loadavg.get("1m", 0) or 0)
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


@edge_bp.post("/api/edge/scheduling/validate")
def validate_scheduling():
    """Server-side validation of an edge scheduling decision."""
    body = request.get_json(silent=True) or {}
    summary = body.get("summary") if isinstance(body.get("summary"), dict) else {}
    detections = body.get("detections") if isinstance(body.get("detections"), list) else []
    system_metrics = body.get("system_metrics") if isinstance(body.get("system_metrics"), dict) else {}
    force_cloud = bool(body.get("force_cloud", False))
    try:
        load_threshold = float(body.get("load_threshold", DEFAULT_LOAD_THRESHOLD))
    except (TypeError, ValueError):
        load_threshold = DEFAULT_LOAD_THRESHOLD
    decision = _compute_scheduling(
        summary,
        detections,
        system_metrics,
        force_cloud=force_cloud,
        load_threshold=load_threshold,
    )
    return jsonify({"ok": True, "decision": decision})


def _build_edge_analysis_prompt(task: dict[str, Any]) -> str:
    event = task.get("event") or {}
    compact_event = json.dumps(event, ensure_ascii=False, indent=2)
    return f"""
请作为云端协同智能体，针对下面的 Atlas 边端 YOLO 检测事件进行高层场景理解和安全决策。
边缘侧设备仅完成了基础的目标物理特征检测（如人、车、球等），需要你利用大模型的常识推理能力进行语义级场景分析并给出具体处置建议。

请直接输出以下三部分内容（每部分使用二级标题，保持内容精简明了），使用 Markdown 格式：

## 💡 场景语义分析 (Scene Semantics)
[用一两句话，直截了当分析检测到的目标组合代表了什么高层社交/场景活动。例如：“检测到多人与球类，这代表一处户外体育运动场景，推测为足球比赛或训练。”]

## ⚠️ 风险等级评估 (Risk Evaluation)
**风险评级**：[低风险 / 中风险 / 高风险]
**判定依据**：[分析在该场景下是否存在安全隐患，例如：运动场地安全、无交通或拥堵风险等。]

## 🛠️ 智能处置建议 (Actionable Advice)
1. [给边端设备或管理人员的具体控制命令或调度指令，例如：继续保持边端本地 YOLO 常规轮巡监控。]
2. [联动建议，例如：无需触发云端高级重算或报警装置。]

请保持简明扼要，直接输出这三部分，绝对不要生成无意义的前缀标题（如“云端分析报告”），也不要复制本地设备的硬件规格、推理延迟或 FPS 等已知运行指标。

边端事件 JSON：
{compact_event}
""".strip()


def _build_task_report(task: dict[str, Any]) -> str:
    event = task.get("event") or {}
    inference = event.get("inference") if isinstance(event.get("inference"), dict) else {}
    summary = event.get("summary") if isinstance(event.get("summary"), dict) else {}
    counts = summary.get("class_counts") if isinstance(summary.get("class_counts"), dict) else {}
    detections = event.get("detections") if isinstance(event.get("detections"), list) else []
    system_metrics = event.get("system_metrics") if isinstance(event.get("system_metrics"), dict) else {}
    edge_decision = event.get("edge_decision") if isinstance(event.get("edge_decision"), dict) else {}
    analysis = task.get("analysis") if isinstance(task.get("analysis"), dict) else {}
    annotated_url = event.get("annotated_image_url", "")

    lines = [
        "# Atlas 边云协同任务报告",
        "",
        "## 基本信息",
        "",
        f"- 任务 ID: `{task.get('id')}`",
        f"- 设备 ID: `{task.get('device_id')}`",
        f"- 主机名: `{event.get('hostname', '')}`",
        f"- 图片: `{task.get('image_id')}`",
        f"- 来源类型: `{task.get('source_type', '')}`",
        f"- 状态: `{task.get('status')}`",
        f"- 创建时间: `{task.get('created_at')}`",
        f"- 更新时间: `{task.get('updated_at')}`",
        "",
        "## 推理性能",
        "",
        f"- 模型: `{inference.get('model', '')}`",
        f"- 推理延迟: `{inference.get('latency_ms', '')}` ms",
        f"- FPS: `{inference.get('fps', '')}`",
        f"- 置信度阈值: `{inference.get('conf_thres', '')}`",
        f"- IoU 阈值: `{inference.get('iou_thres', '')}`",
        "",
        "## 边端检测摘要",
        "",
        f"- 总目标数: `{summary.get('total_count', 0)}`",
        f"- 人数: `{summary.get('person_count', 0)}`",
        f"- 车辆数: `{summary.get('vehicle_count', 0)}`",
        f"- 类别统计: `{json.dumps(counts, ensure_ascii=False)}`",
        "",
        "## 标注图像",
        "",
    ]
    if annotated_url:
        lines.append(f"![标注图]({annotated_url})")
        lines.append("")
    else:
        lines.append("(未上传标注图)")
        lines.append("")

    lines.extend([
        "## 检测明细",
        "",
    ])
    if detections:
        lines.append("| # | 类别 | 类别ID | 置信度 | 边界框 (x1, y1, x2, y2) |")
        lines.append("|---|---|---|---|---|")
        for index, item in enumerate(detections, 1):
            class_name = item.get("class_name", "")
            class_id = item.get("class_id", "")
            conf_val = item.get("confidence")
            conf_str = f"{conf_val:.4f}" if isinstance(conf_val, (int, float)) else "N/A"
            bbox = item.get("bbox", [])
            bbox_str = ", ".join(f"{v:.1f}" for v in bbox) if bbox else "N/A"
            lines.append(f"| {index} | `{class_name}` | {class_id} | {conf_str} | {bbox_str} |")
    else:
        lines.append("无检测目标")
    lines.append("")

    lines.extend([
        "## 调度决策",
        "",
        f"- 本地处理: `{edge_decision.get('handled_locally', True)}`",
        f"- 需要云端分析: `{edge_decision.get('need_cloud_analysis', False)}`",
        f"- 决策原因: {edge_decision.get('reason', 'N/A')}",
        "",
    ])

    if system_metrics:
        lines.extend([
            "## 边端系统指标",
            "",
            "```json",
            json.dumps(system_metrics, ensure_ascii=False, indent=2),
            "```",
            "",
        ])

    lines.extend([
        "## 云端 Agent 分析",
        "",
        str(analysis.get("answer") or "尚未生成云端分析。"),
        "",
    ])

    trace = analysis.get("trace") if isinstance(analysis.get("trace"), list) else []
    if trace:
        lines.extend([
            "## Agent 执行追踪",
            "",
        ])
        for item in trace:
            item_type = item.get("type", "")
            tool = item.get("tool", "")
            status = item.get("status", "")
            duration = item.get("duration_ms")
            duration_str = f" | 耗时: {duration}ms" if isinstance(duration, (int, float)) else ""
            if item_type == "tool_call":
                args = item.get("args", {})
                args_str = " ".join(
                    f"{k}={v}" for k, v in args.items()
                    if isinstance(v, (str, int, float))
                )[:160]
                lines.append(f"- 🔧 调用 `{tool}` | 状态: {status}{duration_str}")
                if args_str:
                    lines.append(f"  参数: {args_str}")
            elif item_type == "llm_response":
                model = item.get("model", "unknown")
                usage = item.get("usage", {})
                usage_str = ""
                if isinstance(usage, dict):
                    parts = []
                    if usage.get("total_tokens"):
                        parts.append(f"tokens: {usage['total_tokens']}")
                    usage_str = f" | {', '.join(parts)}" if parts else ""
                lines.append(f"- 🤖 模型生成 | 模型: {model} | 状态: {status}{duration_str}{usage_str}")
        lines.append("")

    return "\n".join(lines) + "\n"


def _get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


@edge_bp.post("/api/edge/control")
def edge_control():
    payload = request.get_json(silent=True) or {}
    action = payload.get("action")
    if not action:
        return jsonify({"ok": False, "error": "缺少 action 参数"}), 400

    board_ip = os.getenv("ATLAS_BOARD_IP", "192.168.0.2").strip()
    board_user = os.getenv("ATLAS_BOARD_USER", "root").strip()
    board_password = os.getenv("ATLAS_BOARD_PASSWORD", "Mind@123").strip()
    
    # 动态确定板端主目录（如果使用 root 则指向 /home/HwHiAiUser 保证路径兼容性）
    board_home = f"/home/{board_user}" if board_user != "root" else "/home/HwHiAiUser"

    # 自动探测局域网 IP
    server_host = request.host.split(":")[0]
    if server_host in ("127.0.0.1", "localhost"):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect((board_ip, 22))
            server_host = s.getsockname()[0]
            s.close()
        except Exception:
            server_host = _get_local_ip()
            
    server_port = request.host.split(":")[1] if ":" in request.host else "5000"
    server_url = f"http://{server_host}:{server_port}"

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        ssh.connect(
            hostname=board_ip,
            username=board_user,
            password=board_password,
            timeout=8
        )
        
        # 实时自动同步本地无依赖的心跳脚本到开发板上！
        try:
            sftp = ssh.open_sftp()
            local_client_path = str(PROJECT_ROOT / "edge" / "atlas_upload_client.py")
            sftp.put(local_client_path, f"{board_home}/atlas_upload_client.py")
            sftp.close()
        except Exception as sftp_err:
            print(f"Warning: Failed to auto-sync atlas_upload_client.py via SFTP: {sftp_err}")

        if action == "start_heartbeat":
            # 1. 停止旧心跳进程
            _sin, _sout, _serr = ssh.exec_command(
                "pkill -f 'atlas_upload_client.py.*--heartbeat' || true"
            )
            _sout.read()
            time.sleep(0.5)

            # 2. 用 setsid 创建完全独立于当前 SSH 会话的后台进程。
            #    setsid → 新 session，nohup → 忽略 SIGHUP，即使 ssh.close()
            #    关闭 paramiko 通道也不会影响它。
            #    使用 setsid bash 替换 setsid sh 以支持 source 内置命令。
            log_file = f"{board_home}/atlas_heartbeat.log"
            script_path = f"{board_home}/atlas_upload_client.py"
            python_bin = "/usr/local/miniconda3/bin/python3"
            
            # 清理旧日志以防权限问题
            ssh.exec_command(f"rm -f {log_file}")
            
            run_cmd = (
                f"source /usr/local/Ascend/ascend-toolkit/set_env.sh && "
                f"nohup {python_bin} -u {script_path}"
                f" --server {server_url} --heartbeat --watch --interval 10"
            )
            daemon_cmd = (
                f"setsid bash -c '{run_cmd} >> {log_file} 2>&1 &'"
                f" < /dev/null > /dev/null 2>&1"
            )
            _sin, _sout, _serr = ssh.exec_command(daemon_cmd)
            _sin.close()
            _sout.read()
            _serr.read()
            time.sleep(2.0)

            # 3. 验证
            _sin, pgrep_out, _serr = ssh.exec_command(
                "pgrep -f 'atlas_upload_client.py.*--heartbeat' || true"
            )
            pids = pgrep_out.read().decode("utf-8", errors="ignore").strip()
            pgrep_out.close()

            if pids:
                time.sleep(1.5)
                _sin, log_out, _serr = ssh.exec_command(
                    f"tail -20 {log_file} 2>/dev/null || echo '(日志不可读)'"
                )
                log_tail = log_out.read().decode("utf-8", errors="ignore")
                log_out.close()
                return jsonify({
                    "ok": True,
                    "message": f"已在板端后台启动定时心跳（PID: {pids}），每 10 秒上报一次设备状态。",
                    "command": daemon_cmd,
                    "pid": pids,
                    "output": log_tail,
                })
            else:
                _sin, log_out, _serr = ssh.exec_command(
                    f"tail -30 {log_file} 2>/dev/null || echo '(日志文件不存在)'"
                )
                log_tail = log_out.read().decode("utf-8", errors="ignore")
                log_out.close()
                return jsonify({
                    "ok": False,
                    "error": "心跳进程未能成功启动。",
                    "command": daemon_cmd,
                    "log_tail": log_tail,
                }), 500

        elif action == "stop_heartbeat":
            _sin, _sout, _serr = ssh.exec_command(
                "pkill -f 'atlas_upload_client.py.*--heartbeat' || true"
            )
            _sout.read()
            return jsonify({"ok": True, "message": "已停止板端心跳进程。"})

        elif action == "stop_yolo":
            set_yolo_status("idle")
            _sin, _sout, _serr = ssh.exec_command(
                "pkill -f 'atlas_yolo_detect_and_upload.py' || true; pkill -f 'extract_frames.py' || true"
            )
            _sout.read()
            return jsonify({
                "ok": True,
                "message": "已成功终止开发板上的 YOLO 推理与抽帧任务流程。"
            })

        elif action == "trigger_heartbeat":
            # 显式加载 Ascend 环境变量
            cmd = (
                f"source /usr/local/Ascend/ascend-toolkit/set_env.sh && "
                f"/usr/local/miniconda3/bin/python3 -u {board_home}/atlas_upload_client.py "
                f"--server {server_url} --heartbeat"
            )
            stdin, stdout, stderr = ssh.exec_command(cmd)
            out_msg = stdout.read().decode('utf-8', errors='ignore')
            err_msg = stderr.read().decode('utf-8', errors='ignore')
            return jsonify({
                "ok": True,
                "message": "已执行单次实时心跳上报",
                "command": cmd,
                "output": out_msg,
                "error_output": err_msg
            })

        elif action == "run_yolo":
            file_path = payload.get("file_path")
            force_cloud = bool(payload.get("force_cloud", False))
            if not file_path:
                file_path = "world_cup.jpg"
                
            ext = Path(file_path).suffix.lower()
            is_video = ext in {".mp4", ".avi", ".mkv", ".mov"}
            
            task_result, task_ids, err = _process_media_inference(ssh, file_path, server_url, is_video, force_cloud)
            if err:
                return jsonify({"ok": False, "error": err}), 500
                
            return jsonify({
                "ok": True,
                "message": f"已执行板端 YOLO 推理并完成云端研判: {file_path}",
                "command": f"process_media: {file_path} (is_video={is_video})",
                "output": f"成功生成任务流: {', '.join(task_ids)}",
                "task": task_result,
                "task_ids": task_ids
            })
            
        else:
            return jsonify({"ok": False, "error": "无效的 action 参数"}), 400

    except Exception as e:
        return jsonify({"ok": False, "error": f"SSH 远程执行失败: {str(e)}"}), 500
    finally:
        ssh.close()


@edge_bp.post("/api/edge/ssh-connect")
def test_ssh_connection():
    board_ip = os.getenv("ATLAS_BOARD_IP", "192.168.0.2").strip()
    board_user = os.getenv("ATLAS_BOARD_USER", "root").strip()
    board_password = os.getenv("ATLAS_BOARD_PASSWORD", "Mind@123").strip()

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        ssh.connect(
            hostname=board_ip,
            username=board_user,
            password=board_password,
            timeout=5
        )
        _sin, stdout, _serr = ssh.exec_command("uname -a")
        uname = stdout.read().decode('utf-8', errors='ignore').strip()
        ssh.close()
        return jsonify({
            "ok": True,
            "message": f"成功连接到开发板 (SSH Connection Successful)\n系统信息: {uname}",
            "board_ip": board_ip,
            "board_user": board_user
        })
    except Exception as e:
        return jsonify({
            "ok": False,
            "error": f"无法连接到开发板: {str(e)}",
            "board_ip": board_ip,
            "board_user": board_user
        }), 500


@edge_bp.get("/api/edge/yolo-status")
def get_yolo_status():
    with yolo_status_lock:
        return jsonify({
            "ok": True,
            "state": YOLO_STATUS["state"],
            "file_path": YOLO_STATUS["file_path"]
        })


@edge_bp.get("/api/edge/board-files")
def list_board_files():
    board_ip = os.getenv("ATLAS_BOARD_IP", "192.168.0.2").strip()
    board_user = os.getenv("ATLAS_BOARD_USER", "root").strip()
    board_password = os.getenv("ATLAS_BOARD_PASSWORD", "Mind@123").strip()
    board_home = f"/home/{board_user}" if board_user != "root" else "/home/HwHiAiUser"

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        ssh.connect(
            hostname=board_ip,
            username=board_user,
            password=board_password,
            timeout=8
        )
        cmd = f"find {board_home} -maxdepth 4 -type f \\( -name \"*.jpg\" -o -name \"*.jpeg\" -o -name \"*.png\" -o -name \"*.webp\" -o -name \"*.mp4\" -o -name \"*.avi\" -o -name \"*.mkv\" -o -name \"*.mov\" \\) 2>/dev/null | sort"
        stdin, stdout, stderr = ssh.exec_command(cmd)
        files_list = stdout.read().decode('utf-8', errors='ignore').strip().splitlines()
        files_list = [f.strip() for f in files_list if f.strip()]
        return jsonify({
            "ok": True,
            "files": files_list
        })
    except Exception as e:
        return jsonify({"ok": False, "error": f"获取板端文件列表失败: {str(e)}"}), 500
    finally:
        ssh.close()


@edge_bp.post("/api/edge/upload")
def upload_media_file():
    if "file" not in request.files:
        return jsonify({"ok": False, "error": "没有文件在请求中"}), 400
    file = request.files["file"]
    if file.filename == "":
        return jsonify({"ok": False, "error": "未选择文件"}), 400
        
    filename = file.filename
    ext = Path(filename).suffix.lower()
    is_image = ext in {".jpg", ".jpeg", ".png", ".webp"}
    is_video = ext in {".mp4", ".avi", ".mkv", ".mov"}
    
    if not (is_image or is_video):
        return jsonify({"ok": False, "error": f"不支持的文件类型: {ext}"}), 400
        
    local_dir = PROJECT_ROOT / "data" / "uploads"
    local_dir.mkdir(parents=True, exist_ok=True)
    safe_filename = f"{int(time.time())}_{filename}"
    local_path = local_dir / safe_filename
    file.save(str(local_path))
    
    board_ip = os.getenv("ATLAS_BOARD_IP", "192.168.0.2").strip()
    board_user = os.getenv("ATLAS_BOARD_USER", "root").strip()
    board_password = os.getenv("ATLAS_BOARD_PASSWORD", "Mind@123").strip()
    board_home = f"/home/{board_user}" if board_user != "root" else "/home/HwHiAiUser"
    
    server_host = request.host.split(":")[0]
    if server_host in ("127.0.0.1", "localhost"):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect((board_ip, 22))
            server_host = s.getsockname()[0]
            s.close()
        except Exception:
            server_host = _get_local_ip()
            
    server_port = request.host.split(":")[1] if ":" in request.host else "5000"
    server_url = f"http://{server_host}:{server_port}"
    
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        ssh.connect(
            hostname=board_ip,
            username=board_user,
            password=board_password,
            timeout=10
        )
        
        sftp = ssh.open_sftp()
        try:
            sftp.mkdir(f"{board_home}/uploads")
        except IOError:
            pass
            
        remote_path = f"{board_home}/uploads/{safe_filename}"
        sftp.put(str(local_path), remote_path)
        sftp.close()
        
        return jsonify({
            "ok": True,
            "message": "已成功上传本地文件至开发板",
            "file_path": remote_path
        })
        
    except Exception as e:
        return jsonify({"ok": False, "error": f"上传或推理过程失败: {str(e)}"}), 500
    finally:
        ssh.close()


# ============================================================
# 辅助函数：板端推理控制与多模态分析触发
# ============================================================

EXTRACTOR_SCRIPT_CONTENT = """# -*- coding: utf-8 -*-
import cv2, os, sys

def main():
    if len(sys.argv) < 3:
        print("Usage: extract_frames.py <video_path> <out_dir> <target_count>", file=sys.stderr)
        sys.exit(1)
    video_path = sys.argv[1]
    out_dir = sys.argv[2]
    target = int(sys.argv[3]) if len(sys.argv) > 3 else 12
    os.makedirs(out_dir, exist_ok=True)
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print("Error: Could not open video " + video_path, file=sys.stderr)
        sys.exit(2)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    duration = total / max(fps, 1.0)
    if total <= 0:
        print("Error: Video has 0 frames", file=sys.stderr)
        sys.exit(3)

    # 动态抽帧：基于视频时长
    if duration < 10:     target = min(total, 8)
    elif duration < 60:   target = min(total, 12)
    else:                 target = min(total, 16)

    n = target
    step = total / n
    pick = sorted(set(int(i * step) for i in range(n)))
    saved = []
    idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if idx in pick:
            path = os.path.join(out_dir, "frame_{:06d}.jpg".format(idx))
            cv2.imwrite(path, frame)
            saved.append(path)
        idx += 1
    cap.release()
    print("SUCCESS:{}:{}:{}".format(int(fps), int(duration), ",".join(saved)))

if __name__ == '__main__':
    main()
"""

import re

def _extract_task_id(stdout_str: str) -> str | None:
    match = re.search(r'"task_id"\s*:\s*"([^"]+)"', stdout_str)
    if match:
        return match.group(1)
    return None


def _trigger_image_analysis(task_id: str, mode: str = "both", thinking_mode: bool = True) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    task = get_edge_task(task_id)
    if not task:
        return None, None
        
    vision_config = load_vision_config()
    text_result = None
    vision_result = None
    
    import concurrent.futures
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        futures = {}
        if mode in ("text", "both"):
            futures["text"] = executor.submit(_run_text_analysis, task, thinking_mode)
        if mode in ("vision", "both") and vision_config.is_available:
            futures["vision"] = executor.submit(analyze_with_vision, task)
            
        concurrent.futures.wait(futures.values())
        
        if "text" in futures:
            try:
                text_result = futures["text"].result()
            except Exception as exc:
                text_result = {"answer": "", "trace": [], "model": "", "error": str(exc)}
        if "vision" in futures:
            try:
                vision_result = futures["vision"].result()
            except Exception as exc:
                vision_result = {"answer": "", "model": "", "error": str(exc), "media_type": "image"}
                
    answer_parts = []
    if vision_result and vision_result.get("answer"):
        answer_parts.append(vision_result["answer"])
    if text_result and text_result.get("answer"):
        label = "\n\n---\n\n## 📊 文本推理补充（DeepSeek）\n\n" if vision_result and vision_result.get("answer") else ""
        answer_parts.append(label + text_result["answer"])
        
    combined_answer = "\n\n".join(answer_parts) if answer_parts else "分析失败。"
    
    combined_trace = []
    # 优先使用 vision_result 自带的真实 trace（含 token 用量等）
    if vision_result and vision_result.get("trace"):
        combined_trace.extend(vision_result["trace"])
    if text_result and text_result.get("trace"):
        combined_trace.extend(text_result["trace"])

    analysis = {
        "answer": combined_answer,
        "trace": combined_trace,
        "structured_data": (text_result or {}).get("structured_data"),
        "mode": mode,
        "media_type": "image",
        "frame_count": 1,
        "text_analysis": text_result,
        "vision_analysis": vision_result,
    }
    
    updated = update_edge_task_analysis(task_id, analysis, status="completed")
    return updated, analysis


def _trigger_video_analysis(task_ids: list[str], mode: str = "both", thinking_mode: bool = True) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    vision_config = load_vision_config()
    text_result = None
    vision_result = None
    
    import concurrent.futures
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        futures = {}
        if mode in ("text", "both"):
            first_task = get_edge_task(str(task_ids[0]))
            if first_task:
                futures["text"] = executor.submit(_run_text_analysis, first_task, thinking_mode)
        if mode in ("vision", "both") and vision_config.is_available:
            futures["vision"] = executor.submit(analyze_video_with_vision, task_ids)
            
        concurrent.futures.wait(futures.values())
        
        if "text" in futures:
            try:
                text_result = futures["text"].result()
            except Exception as exc:
                text_result = {"answer": "", "trace": [], "model": "", "error": str(exc)}
        if "vision" in futures:
            try:
                vision_result = futures["vision"].result()
            except Exception as exc:
                vision_result = {
                    "answer": "", "model": "",
                    "error": str(exc),
                    "media_type": "video", "frame_count": 0,
                }
                
    answer_parts = []
    if vision_result and vision_result.get("answer"):
        answer_parts.append(vision_result["answer"])
    if text_result and text_result.get("answer"):
        label = "\n\n---\n\n## 📊 文本推理补充（DeepSeek）\n\n" if vision_result and vision_result.get("answer") else ""
        answer_parts.append(label + text_result["answer"])
        
    combined_answer = "\n\n".join(answer_parts) if answer_parts else "分析失败。"
    
    combined_trace = []
    # 优先使用 vision_result 自带的真实 trace（含 token 用量等）
    if vision_result and vision_result.get("trace"):
        combined_trace.extend(vision_result["trace"])
    if text_result and text_result.get("trace"):
        combined_trace.extend(text_result["trace"])

    analysis = {
        "answer": combined_answer,
        "trace": combined_trace,
        "structured_data": (text_result or {}).get("structured_data"),
        "mode": mode,
        "media_type": "video",
        "frame_count": len(task_ids),
        "frame_task_ids": task_ids,
        "text_analysis": text_result,
        "vision_analysis": vision_result,
    }
    
    updated = update_edge_task_analysis(str(task_ids[0]), analysis, status="completed")
    return updated, analysis


def _process_media_inference(ssh, file_path_on_board, server_url, is_video, force_cloud=False):
    set_yolo_status("running_board", file_path_on_board)
    try:
        board_user = os.getenv("ATLAS_BOARD_USER", "root").strip()
        board_home = f"/home/{board_user}" if board_user != "root" else "/home/HwHiAiUser"
        yolo_dir = f"{board_home}/samples/notebooks/01-yolov5"
        python_bin = "/usr/local/miniconda3/bin/python3"

        if is_video:
            import time
            timestamp = int(time.time() * 1000)
            frames_dir = f"{board_home}/uploads/video_{timestamp}_frames"
            
            ssh.exec_command(f"mkdir -p {board_home}/uploads")
            
            sftp = ssh.open_sftp()
            extractor_local_temp = PROJECT_ROOT / "data" / "uploads" / "extract_frames_temp.py"
            extractor_local_temp.parent.mkdir(parents=True, exist_ok=True)
            with open(extractor_local_temp, "w", encoding="utf-8") as f:
                f.write(EXTRACTOR_SCRIPT_CONTENT)
            sftp.put(str(extractor_local_temp), f"{board_home}/uploads/extract_frames.py")
            sftp.close()
            
            with yolo_status_lock:
                if YOLO_STATUS["state"] == "idle":
                    return None, [], "YOLO 推理已终止。"
                    
            cmd = f"{python_bin} {board_home}/uploads/extract_frames.py '{file_path_on_board}' '{frames_dir}' 12"
            stdin, stdout, stderr = ssh.exec_command(cmd)
            out_msg = stdout.read().decode('utf-8', errors='ignore')
            err_msg = stderr.read().decode('utf-8', errors='ignore')

            if "SUCCESS:" not in out_msg:
                return None, [], f"板端视频抽帧失败: {err_msg or out_msg}"

            # SUCCESS:<fps>:<duration>:<paths>
            success_part = out_msg.strip().split("SUCCESS:", 1)[1]
            parts = success_part.split(":", 2)
            video_fps = 0
            video_duration = 0
            if len(parts) >= 2:
                try:
                    video_fps = int(parts[0])
                    video_duration = int(parts[1])
                except ValueError:
                    pass
                frame_paths_str = parts[2] if len(parts) >= 3 else parts[1]
            else:
                frame_paths_str = parts[0]

            frame_paths = [p.strip() for p in frame_paths_str.split(",") if p.strip()]
            if not frame_paths:
                return None, [], "视频未抽取出任何有效帧"
                
            # Create a single parent video task
            initial_event = {
                "device_id": "atlas-200i-dk-a2-01",
                "hostname": "atlas-board",
                "timestamp": datetime.now().isoformat(),
                "image_id": Path(file_path_on_board).name,
                "image_path": file_path_on_board,
                "source_type": "camera_stream",
                "media_type": "video",
                "inference": {
                    "model": "yolo.om",
                    "latency_ms": 0,
                    "fps": video_fps,
                    "conf_thres": 0.4,
                    "iou_thres": 0.5,
                },
                "detections": [],
                "summary": {
                    "total_count": 0,
                    "person_count": 0,
                    "vehicle_count": 0,
                    "class_counts": {}
                },
                "system_metrics": {},
                "edge_decision": {
                    "handled_locally": False,
                    "need_cloud_analysis": True,
                    "reason": f"视频推理分析（{len(frame_paths)} 帧自适应抽帧，FPS={video_fps}）。"
                }
            }
            parent_task = create_edge_task(initial_event, status="received")
            parent_task_id = parent_task["id"]
            
            all_frames_data: list[dict[str, Any]] = []
            all_detections: list[dict[str, Any]] = []
            total_persons = 0
            total_vehicles = 0

            # ---- 逐帧本地 YOLO（不上传，不创建独立 task）----
            for idx, frame_path in enumerate(frame_paths):
                with yolo_status_lock:
                    if YOLO_STATUS["state"] == "idle":
                        return None, [parent_task_id], "YOLO 推理已终止。"

                # 不传 --upload！纯本地推理，输出到本地 JSON/JPG
                run_cmd = (
                    f"source /usr/local/Ascend/ascend-toolkit/set_env.sh && "
                    f"cd {yolo_dir} && "
                    f"rm -f detections.json summary.json annotated.jpg && "
                    f"{python_bin} -u atlas_yolo_detect_and_upload.py"
                    f" --image '{frame_path}' --model yolo.om --labels coco_names.txt"
                )
                _sin, _sout, _serr = ssh.exec_command(run_cmd)
                _sout.read()
                _serr.read()

                # 拉取标注图 base64 并保存到本地 edge_artifacts
                _sin, img_out, _serr = ssh.exec_command(f"base64 {yolo_dir}/annotated.jpg")
                img_b64 = img_out.read().decode('utf-8', errors='ignore').replace(chr(10), '').replace(chr(13), '').strip()
                img_out.close()
                annotated_url = ""
                if img_b64:
                    try:
                        img_bytes = base64.b64decode(img_b64, validate=True)
                        if img_bytes:
                            EDGE_ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
                            art_name = f"video_{timestamp}_frame_{idx}.jpg"
                            (EDGE_ARTIFACT_DIR / art_name).write_bytes(img_bytes)
                            annotated_url = f"/api/edge/artifacts/{art_name}"
                    except Exception:
                        pass

                # 读取检测和摘要 JSON
                _sin, det_out, _serr = ssh.exec_command(f"cat {yolo_dir}/detections.json")
                det_raw = det_out.read().decode('utf-8', errors='ignore')
                _sin, sum_out, _serr = ssh.exec_command(f"cat {yolo_dir}/summary.json")
                sum_raw = sum_out.read().decode('utf-8', errors='ignore')
                try:
                    det_data = json.loads(det_raw) if det_raw.strip() else []
                except json.JSONDecodeError:
                    det_data = []
                try:
                    sum_data = json.loads(sum_raw) if sum_raw.strip() else {}
                except json.JSONDecodeError:
                    sum_data = {}

                all_frames_data.append({
                    "frame_index": idx,
                    "frame_path": frame_path,
                    "image_id": Path(frame_path).name,
                    "annotated_image_url": annotated_url,
                    "detections": det_data,
                    "summary": sum_data,
                    "inference": {},
                })
                all_detections.extend(det_data if isinstance(det_data, list) else [])
                total_persons += sum_data.get("person_count", 0)
                total_vehicles += sum_data.get("vehicle_count", 0)

            

            # 更新父任务 event 中的 frames 和汇总 summary
            parent_task = get_edge_task(parent_task_id)
            if parent_task:
                pev = dict(parent_task.get("event") or {})
                pev["frames"] = all_frames_data
                pev["all_detections"] = all_detections
                pev["frame_count"] = len(all_frames_data)
                pev["summary"] = {
                    "total_count": len(all_detections),
                    "person_count": total_persons,
                    "vehicle_count": total_vehicles,
                    "class_counts": _summarize_detections(all_detections).get("class_counts", {}),
                    "frame_count": len(all_frames_data),
                }
                pev["media_type"] = "video"
                update_edge_task_event(parent_task_id, pev)
                parent_task = get_edge_task(parent_task_id)  # re-read updated

            set_yolo_status("running_cloud")
            
            with yolo_status_lock:
                if YOLO_STATUS["state"] == "idle":
                    return None, [parent_task_id], "YOLO 推理已终止。"
            
            # 视频任务始终触发云端分析（不受 force_cloud 开关影响）
            parent_task = get_edge_task(parent_task_id)
            if parent_task:
                updated_task, _ = _trigger_video_analysis([parent_task_id])
            else:
                updated_task = complete_edge_task_only(parent_task_id)
            return updated_task, [parent_task_id], None
        else:
            with yolo_status_lock:
                if YOLO_STATUS["state"] == "idle":
                    return None, [], "YOLO 推理已终止。"
                    
            force_cloud_arg = " --force-cloud" if force_cloud else ""
            run_cmd = (
                f"source /usr/local/Ascend/ascend-toolkit/set_env.sh && "
                f"cd {yolo_dir} && "
                f"rm -f detections.json summary.json annotated.jpg && "
                f"{python_bin} -u atlas_yolo_detect_and_upload.py"
                f" --image '{file_path_on_board}' --model yolo.om --labels coco_names.txt"
                f" --server {server_url} --upload --no-analyze{force_cloud_arg}"
            )
            stdin, stdout, stderr = ssh.exec_command(run_cmd)
            out_run = stdout.read().decode('utf-8', errors='ignore')
            err_run = stderr.read().decode('utf-8', errors='ignore')
            
            tid = _extract_task_id(out_run)
            if not tid:
                return None, [], f"运行板端 YOLO 推理失败，未获取到 task_id。输出:\n{out_run}\n错误:\n{err_run}"
                
            set_yolo_status("running_cloud")
            
            with yolo_status_lock:
                if YOLO_STATUS["state"] == "idle":
                    return None, [tid], "YOLO 推理已终止。"
            
            task = get_edge_task(tid)
            is_cloud_required = force_cloud or (task and task.get("event", {}).get("edge_decision", {}).get("need_cloud_analysis", True))
            if is_cloud_required:
                updated_task, _ = _trigger_image_analysis(tid)
            else:
                updated_task = complete_edge_task_only(tid)
            return updated_task, [tid], None
    finally:
        set_yolo_status("idle")


