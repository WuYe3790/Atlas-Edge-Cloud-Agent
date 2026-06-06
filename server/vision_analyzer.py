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
        self.max_video_frames: int = int(os.getenv("VISION_MAX_VIDEO_FRAMES", "10"))

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

    return {
        "answer": content.strip() if content else "",
        "model": config.model,
        "error": None,
        "media_type": "image",
        "frame_count": 1,
    }


# ============================================================
# 视频分析（多帧聚合）
# ============================================================

def build_video_vision_prompt(
    tasks: list[dict[str, Any]],
    session_id: str = "",
) -> str:
    """构造多帧视频分析提示词。

    把每帧的 YOLO 摘要汇总成时序上下文，让模型理解帧间变化。
    """
    frame_infos: list[str] = []
    total_persons = 0
    total_vehicles = 0
    all_objects: set[str] = set()

    for i, task in enumerate(tasks):
        event = task.get("event") or {}
        summary = event.get("summary") or {}
        inference = event.get("inference") or {}
        pc = summary.get("person_count", 0)
        vc = summary.get("vehicle_count", 0)
        total_persons += pc
        total_vehicles += vc
        counts = summary.get("class_counts", {})
        if isinstance(counts, dict):
            for k in counts:
                all_objects.add(str(k))

        frame_infos.append(
            f"帧 {i+1} ({task.get('id','')[:16]}...): "
            f"总目标={summary.get('total_count',0)}, "
            f"人={pc}, 车={vc}, "
            f"延迟={inference.get('latency_ms','?')}ms"
        )

    frame_summary = "\n".join(frame_infos)

    return f"""你正在查看一段由 Atlas 200I DK A2 昇腾边缘设备摄像头采集的**视频帧序列**。
以下 {len(tasks)} 帧是按时间顺序排列的 YOLO 标注图（每帧间隔约数秒）。
每张图上已绘制绿色检测框和红色类别标签。

帧序列摘要（帮助你理解时间变化）：
{frame_summary}

检测到的目标类别汇总：{', '.join(sorted(all_objects)) if all_objects else '无'}
跨帧累计人数：{total_persons}，累计车辆数：{total_vehicles}

请你**基于亲眼看到的帧序列内容**（时序变化 + 帧间关系），直接输出以下三部分：

## 💡 场景视觉分析
[描述你从帧序列中观察到的场景。注意：不同帧之间的变化趋势（人/车增多还是减少）、整体环境判断、是否有动态事件发生（如人员移动、车辆驶入驶出）。这些都是单帧无法提供的时序信息。]

## ⚠️ 风险等级评估
**风险评级**：[低风险 / 中风险 / 高风险]
**判定依据**：[综合全部帧判断。注意是否有异常聚集、快速移动、危险行为等动态风险。]

## 🛠️ 智能处置建议
1. [基于视频理解给出边端调度指令]
2. [是否需要人工复核或触发告警]

请保持简洁，直接输出三部分内容。"""


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

    # 从 DB 取出 task 并在有 frames 字段时提取为模拟 task 列表
    tasks: list[dict[str, Any]] = []
    first_task = get_edge_task(str(task_ids[0]))
    if first_task:
        event = first_task.get("event") or {}
        frames = event.get("frames")
        if frames:
            for frame in frames:
                url = frame.get("annotated_image_url") or ""
                filename = url.split("/")[-1] if "/" in url else ""
                sim_task = {
                    "id": first_task.get("id"),
                    "event": {
                        "annotated_image_filename": filename,
                        "annotated_image_url": url,
                        "summary": frame.get("summary", {}),
                        "inference": frame.get("inference", {}),
                    }
                }
                tasks.append(sim_task)
        else:
            # 兼容旧的多 task 帧路径
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
        # 均匀采样
        step = len(tasks) / max_frames
        tasks = [tasks[int(i * step)] for i in range(max_frames)]

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

    return {
        "answer": content.strip() if content else "",
        "model": config.model,
        "error": None,
        "media_type": "video",
        "frame_count": loaded_count,
        "frame_task_ids": [t.get("id") for t in tasks],
    }
