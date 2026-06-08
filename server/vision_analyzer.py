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
        self.max_video_frames: int = int(os.getenv("VISION_MAX_VIDEO_FRAMES", "60"))

    @property
    def is_available(self) -> bool:
        return bool(self.api_key)


def load_vision_config() -> VisionConfig:
    return VisionConfig()


# ============================================================
# 图片分析
# ============================================================

def _read_image_base64(task: dict[str, Any]) -> tuple[str | None, str]:
    """读取任务的标注图，压缩后返回 (base64_string, mime_type)。
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
    # 压缩大图：超过 200KB 的标注图缩小到 900px 宽，JPEG 质量 70
    if len(image_bytes) > 200 * 1024:
        try:
            import io
            from PIL import Image
            img = Image.open(io.BytesIO(image_bytes))
            w, h = img.size
            if w > 900:
                ratio = 900.0 / w
                img = img.resize((900, int(h * ratio)), Image.LANCZOS)
            buf = io.BytesIO()
            img.convert("RGB").save(buf, format="JPEG", quality=70)
            image_bytes = buf.getvalue()
        except Exception:
            pass  # PIL 不可用时使用原图

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

def _build_detail_requirements(frame_count: int) -> str:
    """根据帧数动态生成详细度要求。帧数越多，要求越详细，分析内容越丰富。"""
    if frame_count <= 20:
        detail = f"""## 💡 视频场景视觉分析
请仔细观察帧拼接图中每一格的标注图像，分以下小节详细描述：
1. **整体环境与时段判断**：室内/室外、白天/夜晚、具体场所类型
2. **关键帧细节描述**：至少引用其中 3-5 个具体帧号，描述每帧中的人物位置、着装、姿态、物体和空间关系
3. **帧间变化趋势**：从开头到结尾，场景如何变化——哪些目标出现/消失/移动
4. **YOLO 标签无法传达的视觉信息**：光照、遮挡、镜头运动等
⚠️ 每部分内容至少 2-3 句话，总字数不少于 200 字。

## ⚠️ 风险等级评估
**风险评级**：[低风险 / 中风险 / 高风险]
**判定依据**：[综合 {frame_count} 帧判断，引用具体帧号，至少 2 句依据。注意人群聚集、交通状况、异常行为等]

## 🛠️ 智能处置建议
1. [基于完整视频理解给出边端调度指令，至少 1-2 句话]
2. [是否需要人工复核或触发告警，说明理由]

## 📋 视频摘要
用 2-3 句话总结从这 {frame_count} 帧标注图中观察到的核心内容、关键发现和整体风险判断。"""
    elif frame_count <= 40:
        detail = f"""## 💡 视频场景视觉分析
请**深入观察帧拼接图中每一格的标注图像**，分以下小节详细描述（⚠️ 总字数不少于 400 字）：
1. **整体环境与时段判断**：室内/室外、白天/夜晚、具体场所类型、是否有多个场景切换
2. **关键帧细节描述**：至少引用 8-12 个具体帧号，逐一描述每帧中的视觉细节——人物位置/数量/着装/姿态、关键物体（车/行李/设备等）的类型和颜色、空间关系（人与人/人与物之间的距离/相对位置）
3. **帧间变化趋势**：从开头到结尾，目标数量如何波动、人物出现/消失的具体帧段、物体的移动轨迹
4. **YOLO 标签无法传达的视觉信息**：光照变化（变亮/变暗）、遮挡关系、镜头运动（静止/移动/旋转）、画面模糊程度等

## ⚠️ 风险等级评估
**风险评级**：[低风险 / 中风险 / 高风险]
**判定依据**：[综合 {frame_count} 帧判断，至少 3 句具体依据。引用具体帧号说明风险来源——人群密度趋势、车辆/危险物品出现、异常行为模式等。]

## 🛠️ 智能处置建议
1. [基于完整视频理解的边端调度指令，至少 1-2 句话]
2. [是否需要人工复核或触发告警，说明理由和紧迫程度]
3. [针对该场景类型的长期监控建议]

## 📋 视频摘要
用 3-4 句话全面总结核心内容、关键发现和主要风险判断。"""
    else:
        detail = f"""## 💡 视频场景视觉分析
这是一个较长视频的 {frame_count} 帧关键帧序列。请**深入全面分析，输出至少 800 字的详细描述**，分以下小节：
1. **整体环境与时段判断**：室内/室外、白天/夜晚、具体场所类型、是否有多个场景切换。如有切换，描述每个场景的特征。
2. **分阶段帧分析**（⚠️ 每个阶段至少 150 字，引用 4-6 个具体帧号）：
   - 前段（帧 1-{frame_count//3}）：描述初始场景状态、人物位置、关键物体
   - 中段（帧 {frame_count//3+1}-{frame_count*2//3}）：描述中间变化、新出现/消失的目标、场景状态转变
   - 后段（帧 {frame_count*2//3+1}-{frame_count}）：描述最终状态、与前两阶段的对比变化
3. **全片时序变化**：人物的出现/消失和数量波动曲线、车辆/物体的出现和移动轨迹、场景切换时间点
4. **YOLO 标签无法传达的视觉细节**：光照变化/阴影、遮挡关系、空间密度变化、人物之间的互动模式、画面模糊/抖动等

## ⚠️ 风险等级评估
**风险评级**：[低风险 / 中风险 / 高风险]
**判定依据**：[分阶段评估风险。综合 {frame_count} 帧的整体趋势，至少 4 句具体依据。引用具体帧号，注意动态风险——人群聚集趋势的速率、车辆/危险物品的出现频率和位置、异常行为（跌倒/奔跑/冲突等）。如某阶段风险高于其他阶段，请明确指出。]

## 🛠️ 智能处置建议
1. [基于完整视频理解的边端调度指令——监控频率是否够、是否需要调整置信度阈值等]
2. [是否需要立即人工复核或触发告警，说明紧迫程度（立即/1小时内/24小时内）]
3. [针对该场景类型的长期建议——哪些目标类型值得持续关注、是否需要增加摄像头覆盖等]
4. [如检测到风险趋势，建议后续重点关注哪些帧段（给出具体帧号范围）]
5. [是否需要调整抽帧策略（加密/减疏）以更好地捕获风险事件]

## 📋 视频摘要
用 4-5 句话全面总结核心内容、关键发现、风险判断和主要建议。"""
    return detail


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

    return f"""你正在查看一段由 Atlas 200I DK A2 昇腾边缘设备采集的**视频帧序列**。
以下 {len(tasks)} 个帧的 YOLO 标注结果被整理在时序数据表和缩略图中。
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

{_build_detail_requirements(len(tasks))}

请直接输出以上四部分内容，用 Markdown 格式，不要额外的前言后缀。"""


def _build_frame_strip(tasks: list[dict[str, Any]], thumb_w: int = 0, cols: int = 0) -> str | None:
    """将所有标注帧拼成单张缩略图网格。

    根据帧数自适应选择参数以控制最终 base64 大小：
    - ≤40 帧: 600px/10列, Q=75（验证通过）
    - >40 帧: 400px/12列, Q=60（拆成3张，每张约20帧，单图约2000-4000 tokens）
    """
    n = len(tasks)
    if thumb_w <= 0:
        if n <= 40: thumb_w, cols, quality = 600, 10, 75
        else:       thumb_w, cols, quality = 400, 12, 60
    else:
        quality = 85
    try:
        import io
        from PIL import Image
        images: list[Image.Image] = []
        frame_labels: list[str] = []
        for t in tasks:
            evt = t.get("event") or {}
            url = evt.get("annotated_image_url") or ""
            filename = evt.get("annotated_image_filename") or url.split("/")[-1] if "/" in url else ""
            if not filename:
                continue
            img_path = EDGE_ARTIFACT_DIR / Path(filename).name
            if not img_path.exists():
                continue
            try:
                img = Image.open(img_path).convert("RGB")
                ratio = thumb_w / img.width
                img = img.resize((thumb_w, max(1, int(img.height * ratio))), Image.LANCZOS)
                images.append(img)
                fi = evt.get("frame_index", len(images) - 1)
                summary = evt.get("summary") or {}
                tc = summary.get("total_count", 0)
                frame_labels.append(f"F{fi}:{tc}")
            except Exception:
                continue
        if not images:
            return None

        # 统一行高为第一张的高度
        row_h = images[0].height
        rows = (len(images) + cols - 1) // cols
        canvas_w = cols * thumb_w
        canvas_h = rows * row_h
        canvas = Image.new("RGB", (canvas_w, canvas_h), (30, 30, 30))
        for i, img in enumerate(images):
            r = i // cols
            c = i % cols
            x = c * thumb_w
            y = r * row_h
            canvas.paste(img, (x, y))
            # 画帧号标签（白字黑底，稍大一些便于看清）
            try:
                from PIL import ImageDraw, ImageFont
                draw = ImageDraw.Draw(canvas)
                label = frame_labels[i] if i < len(frame_labels) else f"F{i}"
                draw.rectangle([x, y, x + 70, y + 18], fill=(0, 0, 0))
                draw.text((x + 3, y + 2), label, fill=(255, 255, 0))
            except Exception:
                pass

        # 自适应质量：for-loop 从高到低尝试，最大 base64 约 4MB
        for q in [quality, 60]:
            quality = q
            buf = io.BytesIO()
            canvas.save(buf, format="JPEG", quality=quality)
            raw_size = buf.tell()
            b64 = base64.b64encode(buf.getvalue()).decode("ascii")
            b64_mb = len(b64) * 3 / 4 / 1024 / 1024
            print(f"[vision_analyzer] frame_strip: {len(images)} frames, {cols}x{rows}, "
                  f"raw={raw_size/1024:.0f}KB, quality={quality}, base64~{b64_mb:.1f}MB", flush=True)
            if b64_mb < 5.0 or quality == 60:
                return b64
        return b64  # 降质到底
    except Exception as e:
        print(f"[vision_analyzer] frame_strip failed: {e}, falling back to individual frames", flush=True)
        return None


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

    # 当帧数超过 API 限制时，不再逐一发送标注图（会导致 413），
    # 改为生成单张帧拼接缩略图 + 完整的 YOLO 时序数据
    max_frames = config.max_video_frames
    if len(tasks) > max_frames:
        keep = [tasks[0]]
        middle = tasks[1:-1] if len(tasks) > 2 else []
        if middle and max_frames > 3:
            step = max(1, len(middle) / (max_frames - 3))
            for i in range(max_frames - 3):
                idx = int(i * step)
                if idx < len(middle):
                    keep.append(middle[idx])
        scored = []
        for t in tasks:
            s = (t.get("event") or {}).get("summary") or {}
            scored.append((s.get("total_count", 0), t))
        scored.sort(key=lambda x: -x[0])
        for _, t in scored:
            if len(keep) >= max_frames:
                break
            if t not in keep:
                keep.append(t)
        keep.append(tasks[-1])
        tasks = sorted(set(keep), key=lambda x: tasks.index(x))

    # ---- 生成帧拼接缩略图 ----
    # ≤40 帧：单张拼接图（已验证正常）
    # >40 帧：拆为 3 张拼接图同时发送（每张 ~20 帧，600px/10col/Q75，单图不超 token 限制）
    n = len(tasks)
    if n > 40:
        chunk_size = max(1, n // 3)
        chunks = [tasks[i:i+chunk_size] for i in range(0, n, chunk_size)]
        frame_blocks: list[dict[str, Any]] = []
        for chunk in chunks:
            b64 = _build_frame_strip(chunk, thumb_w=400, cols=8)
            if b64:
                frame_blocks.append({
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{b64}", "detail": "high"},
                })
        frame_strip_b64 = True  # 走拼接图 prompt 分支
    else:
        frame_strip_b64 = _build_frame_strip(tasks)
        if frame_strip_b64:
            frame_blocks: list[dict[str, Any]] = [{
                "type": "image_url",
                "image_url": {"url": f"data:image/jpeg;base64,{frame_strip_b64}", "detail": "high"},
            }]
        else:
            frame_blocks: list[dict[str, Any]] = []
            for task in tasks:
                image_b64, mime_type = _read_image_base64(task)
                if image_b64:
                    frame_blocks.append({
                        "type": "image_url",
                        "image_url": {"url": f"data:{mime_type};base64,{image_b64}", "detail": "high"},
                    })

    if not frame_blocks:
        return {
            "answer": "", "model": "",
            "error": "所有帧均无标注图，无法分析",
            "media_type": "video", "frame_count": 0,
        }

    loaded_count = len(tasks)

    prompt = build_video_vision_prompt(tasks)
    # 使用帧拼接缩略图时，在 prompt 开头说明
    if frame_strip_b64:
        if n > 40:
            prompt = (
                f"⚠️ 注意：以下 {len(frame_blocks)} 张图片是将全部 {n} 帧标注图**分组合并为缩略图拼接网格**"
                "（每张图内每列一帧，按时间从左到右、从上到下排列，第1张对应视频前段、第2张对应中段、第3张对应后段）。"
                "请综合所有拼接图上的视觉内容，结合下方的 YOLO 检测数据表进行全面的视频级分析。\n\n"
            ) + prompt
        else:
            prompt = (
                "⚠️ 注意：以下图片是全部标注帧的**缩略图拼接网格**（每列一帧，按时间从左到右、从上到下排列），"
                "不是单张原图。请基于这张拼接图上每一格的视觉内容，结合下方的 YOLO 检测数据表进行综合分析。\n\n"
            ) + prompt
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
