# server/vision_analyzer.py
"""
多模态视觉分析模块。
使用 SenseNova 6.7 Flash-Lite 对 Atlas YOLO 标注图进行：
  - 静态图片的像素级场景理解
  - 多帧序列的视频级场景理解
与 DeepSeek 文本分析路径完全独立。
"""

from __future__ import annotations

import base64
import os
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from langchain_openai import ChatOpenAI

from server.bootstrap import PROJECT_ROOT
from travel_agent.storage import get_edge_task   # 视频分析需要从 DB 读取多 task

EDGE_ARTIFACT_DIR = PROJECT_ROOT / "data" / "edge_artifacts"


# ============================================================
# 配置类
# ============================================================

class VisionConfig:
    """从 .env 加载多模态视觉模型配置，与主 LLMConfig 完全独立。"""

    def __init__(self) -> None:
        load_dotenv()
        self.api_key: str = os.getenv("VISION_API_KEY", "").strip()
        self.base_url: str = os.getenv(
            "VISION_BASE_URL", "https://token.sensenova.cn/v1"
        ).strip()
        self.model: str = os.getenv(
            "VISION_MODEL", "sensenova-6.7-flash-lite"
        ).strip()
        self.temperature: float = float(os.getenv("VISION_TEMPERATURE", "0.3"))
        self.timeout_image: int = int(os.getenv("VISION_TIMEOUT_IMAGE", "120"))
        self.timeout_video: int = int(os.getenv("VISION_TIMEOUT_VIDEO", "300"))
        self.max_video_frames: int = int(os.getenv("VISION_MAX_VIDEO_FRAMES", "16"))

    @property
    def is_available(self) -> bool:
        return bool(self.api_key)


def load_vision_config() -> VisionConfig:
    return VisionConfig()


# ============================================================
# 图片分析
# ============================================================

def _read_image_base64(task: dict[str, Any]) -> tuple[str | None, str]:
    """读取任务的任务标注图并返回 (base64_string, mime_type)。
    返回 (None, "") 表示无可用图片。
    """
    event = task.get("event") or {}
    filename = event.get("annotated_image_filename") or ""

    if not filename:
        url = event.get("annotated_image_url", "")
        if url.startswith("/api/edge/artifacts/"):
            filename = url.replace("/api/edge/artifacts/", "")

    if not filename:
        return None, ""

    image_path = EDGE_ARTIFACT_DIR / Path(filename).name
    if not image_path.exists():
        return None, ""

    image_bytes = image_path.read_bytes()
    suffix = image_path.suffix.lower()
    mime = {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".png": "image/png", ".webp": "image/webp",
    }.get(suffix, "image/jpeg")

    return base64.b64encode(image_bytes).decode("ascii"), mime


def build_image_vision_prompt(task: dict[str, Any]) -> str:
    event = task.get("event") or {}
    inference = event.get("inference") or {}
    summary = event.get("summary") or {}

    return f"""你正在查看一张由 Atlas 200I DK A2 昇腾边缘计算设备上 YOLOv5 模型生成的**标注图像**。
图像上已经用绿色框绘制了检测目标，红色文字标注了类别名称和置信度。

边端 YOLO 检测的元数据（帮助你理解标注框的语义）：
- 总目标数: {summary.get('total_count', 0)}
- 人数: {summary.get('person_count', 0)}
- 车辆数: {summary.get('vehicle_count', 0)}
- 推理模型: {inference.get('model', 'unknown')}
- 推理延迟: {inference.get('latency_ms', 'N/A')} ms

请你**基于你亲眼看到的图像内容**（而不仅仅是上面的标签数字），直接输出以下三部分：

## 💡 场景视觉分析
[描述你从图像中实际观察到的场景。注意：人物位置关系、环境背景（室内/室外）、光照条件、遮挡情况、物体之间的空间关系等——这些都是 YOLO 标签无法传达的视觉信息。]

## ⚠️ 风险等级评估
**风险评级**：[低风险 / 中风险 / 高风险]
**判定依据**：[基于视觉观察判断安全隐患。例如人员密集度、交通状况、异常行为等。]

## 🛠️ 智能处置建议
1. [基于视觉理解给出边端调度指令]
2. [是否需要人工复核或触发告警]

请保持简洁，直接输出三部分内容。"""


def analyze_with_vision(task: dict[str, Any]) -> dict[str, Any]:
    """单张标注图的多模态分析。"""
    config = load_vision_config()
    if not config.is_available:
        return {"answer": "", "model": "", "error": "VISION_API_KEY 未配置", "media_type": "image"}

    image_b64, mime_type = _read_image_base64(task)
    if not image_b64:
        return {"answer": "", "model": "", "error": "无标注图", "media_type": "image"}

    prompt = build_image_vision_prompt(task)
    data_url = f"data:{mime_type};base64,{image_b64}"

    print(f"[vision_analyzer] IMG calling {config.model} via {config.base_url}...", flush=True)

    llm = ChatOpenAI(
        model=config.model,
        api_key=config.api_key,
        base_url=config.base_url,
        temperature=config.temperature,
        timeout=config.timeout_image,
    )

    message: dict[str, Any] = {
        "role": "user",
        "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": data_url, "detail": "high"}},
        ],
    }

    response = llm.invoke([message])
    content: str = response.content if hasattr(response, "content") else str(response)
    answer = content.strip() if content else ""

    print(f"[vision_analyzer] IMG done: answer_len={len(answer)}", flush=True)
    # 从 ChatOpenAI 响应中提取真实 token 用量
    usage_meta = getattr(response, "usage_metadata", None) or {}
    resp_meta = getattr(response, "response_metadata", {}) or {}
    real_tokens = (
        usage_meta.get("total_tokens")
        or resp_meta.get("token_usage", {}).get("total_tokens")
        or (len(answer) // 3 if answer else 0)
    )
    print(f"[vision_analyzer] IMG tokens={real_tokens}", flush=True)

    return {
        "answer": answer,
        "model": config.model,
        "error": None,
        "media_type": "image",
        "frame_count": 1,
        "usage": {"total_tokens": real_tokens},
        "trace": [
            {
                "type": "vision_analysis",
                "model": config.model,
                "media_type": "image",
                "frame_count": 1,
                "status": "success" if answer else "empty",
                "duration_ms": None,
                "usage": {"total_tokens": real_tokens},
                "result": answer[:300] if answer else "",
            }
        ],
    }


# ============================================================
# 视频分析（多帧聚合）
# ============================================================

def build_video_vision_prompt(
    tasks: list[dict[str, Any]],
    session_id: str = "",
) -> str:
    """构造多帧视频分析提示词。

    将每帧的 YOLO 摘要汇总成丰富的时序上下文，
    包括帧间数量变化趋势、动态事件检测、累计统计等，
    让模型真正理解视频的时间维度信息。
    """
    frame_infos: list[str] = []
    timeline_rows: list[str] = []
    total_persons = 0
    total_vehicles = 0
    all_objects: set[str] = set()
    prev_pc = None
    prev_vc = None
    total_per_frame: list[int] = []

    for i, task in enumerate(tasks):
        event = task.get("event") or {}
        summary = event.get("summary") or {}
        inference = event.get("inference") or {}
        pc = summary.get("person_count", 0)
        vc = summary.get("vehicle_count", 0)
        tc = summary.get("total_count", 0)
        total_persons += pc
        total_vehicles += vc
        total_per_frame.append(tc)
        counts = summary.get("class_counts", {})
        if isinstance(counts, dict):
            for k in counts:
                if k not in ("person", "car", "bus", "truck", "motorcycle", "bicycle"):
                    all_objects.add(str(k))

        # 构建帧描述
        frame_desc = (
            f"帧 {i+1}: 总目标={tc}, 人={pc}, 车={vc}"
        )
        # 检测帧间变化
        changes = []
        if prev_pc is not None:
            pc_delta = pc - prev_pc
            vc_delta = vc - prev_vc if prev_vc is not None else 0
            if pc_delta > 0:
                changes.append(f"新增 {pc_delta} 人")
            elif pc_delta < 0:
                changes.append(f"减少 {abs(pc_delta)} 人")
            if vc_delta > 0:
                changes.append(f"新增 {vc_delta} 辆车")
            elif vc_delta < 0:
                changes.append(f"减少 {abs(vc_delta)} 辆车")
        prev_pc = pc
        prev_vc = vc
        if changes:
            frame_desc += f" | 变化: {', '.join(changes)}"
        frame_desc += f" | 延迟={inference.get('latency_ms','?')}ms"
        frame_infos.append(frame_desc)
        timeline_rows.append(
            f"| {i+1} | {tc} | {pc} | {vc} | {', '.join(changes) if changes else '—'} |"
        )

    frame_summary = "\n".join(frame_infos)
    timeline = "\n".join(timeline_rows)

    # 时序趋势分析
    trend_parts = []
    if len(total_per_frame) >= 3:
        first_half_avg = sum(total_per_frame[:len(total_per_frame)//2]) / max(1, len(total_per_frame)//2)
        second_half_avg = sum(total_per_frame[len(total_per_frame)//2:]) / max(1, len(total_per_frame) - len(total_per_frame)//2)
        if second_half_avg > first_half_avg * 1.3:
            trend_parts.append("目标数量呈上升趋势，后半段明显多于前半段")
        elif first_half_avg > second_half_avg * 1.3:
            trend_parts.append("目标数量呈下降趋势，前半段明显多于后半段")
        else:
            trend_parts.append("目标数量整体稳定，未出现明显的增减趋势")
    if max(total_per_frame) - min(total_per_frame) >= 3:
        trend_parts.append(f"帧间波动较大（最低 {min(total_per_frame)} → 最高 {max(total_per_frame)}），视频中存在显著的场景变化")

    trend_text = "\n".join(f"- {t}" for t in trend_parts) if trend_parts else "帧间变化不显著"

    return f"""你正在查看一段由 Atlas 200I DK A2 昇腾边缘设备采集的**完整视频帧序列**。
以下 {len(tasks)} 帧标注图是**从视频中自适应抽取的关键帧**（覆盖视频开头、中间和结尾，并额外选取了画面变化最剧烈的片段）。
每张图上已用绿色框绘制检测目标，红色文字标注了类别名称和置信度。

---

## 📊 帧间检测数据时序表

| 帧序号 | 总目标数 | 人数 | 车辆数 | 帧间变化 |
|--------|---------|------|--------|---------|
{timeline}

---

## 📈 时序趋势分析

{trend_text}

检测到的非人/车的其他类别汇总：{', '.join(sorted(all_objects)) if all_objects else '无其他类别'}
累计检测人次：{total_persons}，累计车辆次：{total_vehicles}

---

请你**综合以上全部帧的标注图像内容和检测数据**（不要只盯着某一帧），输出以下四部分分析：

## 💡 视频场景视觉分析
[请描述你从帧序列标注图中实际观察到的完整场景。重点分析：
1. 整体环境是什么（室内/室外、白天/夜晚、城市/野外等）
2. 画面中有哪些值得注意的视觉细节（物体空间关系、光照、遮挡等）
3. **帧间变化趋势**：从早期帧到后期帧，场景中的人和物是如何变化的——哪些目标出现/消失、哪些保持不变、有没有移动轨迹
4. 这些信息是 YOLO 数字标签无法传达的]

## ⚠️ 风险等级评估
**风险评级**：[低风险 / 中风险 / 高风险]
**判定依据**：
- 基于全部 {len(tasks)} 帧的综合判断
- 是否需要关注某些帧中的异常聚集/快速移动/危险行为
- 帧间趋势是否暗示潜在风险（如人数持续增多、车辆突然出现等）

## 🛠️ 智能处置建议
1. [基于完整的视频理解给出边端设备调度指令——是否继续监控、调整监控频率等]
2. [是否需要人工复核或触发告警]
3. [针对该场景类型的长期建议]

## 📋 视频摘要
用 1-2 句话总结这段视频的主要内容（便于管理平台概览展示）。

请保持分析严谨全面，直接输出四部分内容。"""


def analyze_video_with_vision(task_ids: list[str]) -> dict[str, Any]:
    """多帧标注图的视频级多模态分析。

    Args:
        task_ids: 要分析的 task_id 列表（按时间排序）

    Returns:
        与 analyze_with_vision 相同结构的 dict，额外带 frame_count / frame_task_ids
    """
    config = load_vision_config()
    if not config.is_available:
        return {
            "answer": "", "model": "",
            "error": "VISION_API_KEY 未配置",
            "media_type": "video", "frame_count": 0,
        }

    # 从 DB 取出 task：支持两种格式
    tasks: list[dict[str, Any]] = []
    parent_task = get_edge_task(str(task_ids[0]))
    if not parent_task:
        print(f"[vision_analyzer] ERROR: parent task not found: {task_ids[0]}", flush=True)
        return {
            "answer": "", "model": "",
            "error": f"父任务 {task_ids[0]} 不存在",
            "media_type": "video", "frame_count": 0,
        }

    event = parent_task.get("event") or {}
    frames = event.get("frames")
    print(f"[vision_analyzer] parent_task_id={task_ids[0]}, has_frames={bool(frames)}, frame_count={len(frames) if frames else 0}, media_type={event.get('media_type')}", flush=True)

    if frames and isinstance(frames, list) and len(frames) > 0:
        for frame in frames:
            url = frame.get("annotated_image_url") or ""
            filename = frame.get("annotated_image_filename") or ""
            if not filename and url:
                filename = url.split("/")[-1] if "/" in url else ""
            tasks.append({
                "id": parent_task.get("id"),
                "event": {
                    "annotated_image_filename": filename,
                    "annotated_image_url": url,
                    "summary": frame.get("summary", {}),
                    "inference": frame.get("inference", {}),
                    "detections": frame.get("detections", []),
                    "frame_index": frame.get("frame_index", 0),
                }
            })
    else:
        # 旧版兼容：多个独立 task_id
        for tid in task_ids:
            task = get_edge_task(str(tid))
            if task:
                tasks.append(task)
    if not tasks:
        return {
            "answer": "", "model": "",
            "error": "无法加载任何视频帧标注图",
            "media_type": "video", "frame_count": 0,
        }

    # 限制帧数
    max_frames = config.max_video_frames
    if len(tasks) > max_frames:
        # 保留前后各 3 帧 + 中间均匀采样，确保不丢失开头和结尾信息
        keep_front = min(3, len(tasks))
        keep_back = min(3, len(tasks) - keep_front)
        middle_count = max_frames - keep_front - keep_back
        if middle_count > 0 and len(tasks) - keep_front - keep_back > 1:
            middle_start = keep_front
            middle_end = len(tasks) - keep_back
            step = (middle_end - middle_start - 1) / (middle_count - 1) if middle_count > 1 else 0
            sampled = list(tasks[:keep_front])
            for i in range(middle_count):
                sampled.append(tasks[middle_start + int(i * step)])
            sampled.extend(tasks[-keep_back:] if keep_back else [])
            tasks = sampled
        elif middle_count <= 0:
            tasks = tasks[:keep_front] + (tasks[-keep_back:] if keep_back else [])

    # 收集所有帧的 base64
    frame_blocks: list[dict[str, Any]] = []
    loaded_count = 0
    for task in tasks:
        image_b64, mime_type = _read_image_base64(task)
        if image_b64:
            frame_blocks.append({
                "type": "image_url",
                "image_url": {
                    "url": f"data:{mime_type};base64,{image_b64}",
                    "detail": "high",
                },
            })
            loaded_count += 1

    if not frame_blocks:
        return {
            "answer": "", "model": "",
            "error": "所有帧均无标注图，无法分析",
            "media_type": "video", "frame_count": 0,
        }

    prompt = build_video_vision_prompt(tasks)
    content_blocks: list[dict[str, Any]] = [
        {"type": "text", "text": prompt},
    ] + frame_blocks

    print(f"[vision_analyzer] VID calling {config.model} via {config.base_url}, frames={loaded_count}...", flush=True)

    llm = ChatOpenAI(
        model=config.model,
        api_key=config.api_key,
        base_url=config.base_url,
        temperature=config.temperature,
        timeout=config.timeout_video,
    )

    message: dict[str, Any] = {
        "role": "user",
        "content": content_blocks,
    }

    response = llm.invoke([message])
    content: str = response.content if hasattr(response, "content") else str(response)
    answer = content.strip() if content else ""

    usage_meta = getattr(response, "usage_metadata", None) or {}
    resp_meta = getattr(response, "response_metadata", {}) or {}
    real_tokens = (
        usage_meta.get("total_tokens")
        or resp_meta.get("token_usage", {}).get("total_tokens")
        or (len(answer) // 3 if answer else 0)
    )

    return {
        "answer": answer,
        "model": config.model,
        "error": None,
        "media_type": "video",
        "frame_count": loaded_count,
        "frame_task_ids": [t.get("id") for t in tasks],
        "usage": {"total_tokens": real_tokens},
        "trace": [
            {
                "type": "vision_analysis",
                "model": config.model,
                "media_type": "video",
                "frame_count": loaded_count,
                "status": "success" if answer else "empty",
                "duration_ms": None,
                "usage": {"total_tokens": real_tokens},
                "result": answer[:300] if answer else "",
            }
        ],
    }
