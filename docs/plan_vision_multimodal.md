# SenseNova 多模态视觉分析模块 — 实施计划（修订版）

## 零、执行前必读：当前项目实际架构

> **注意**：以下所有文件路径和行号基于 **Gemini 接手后的最新代码**（截至 commit `67751c7`）。旧计划中引用的大量行号（如 `app.js:1422`）和函数名（如 `renderEdgeTasks()`）已经过时——前端已被 Vue 3 彻底重写。

### 实际文件结构

```
server/
  edge_routes.py          # 边云路由，analyze_edge_task() 在行 535-563
  vision_analyzer.py      # 【新建】多模态分析模块

edge/
  atlas_yolo_detect_and_upload.py  # YOLO + camera + NPU + 上传
  atlas_upload_client.py           # 手工上传 + watch 心跳

src/travel_agent/
  agent.py                # LangChain Agent：build_agent(), run_agent_with_trace()
  config.py               # LLMConfig dataclass + load_llm_config()
  storage.py              # SQLite：create_edge_task, update_edge_task_analysis …
  prompts.py              # System prompt

static/
  app.js                  # Vue 3 入口，setup() 管所有状态
  components/
    SidebarComponent.js   # 侧栏：双模式切换 + 设备监控 + SSH 控制
    EdgeMonitor.js        # 边云任务管道卡片 + Agent 分析卡片
    TaskModal.js          # 任务详情弹窗：标注图、检测表、分析全文
    TravelAssistant.js    # 出行对话面板
  travel_helpers.js      # 地图/POI/酒店等辅助（从旧 app.js 提取）
  map_helpers.js         # 高德交互式地图

.env.example             # 配置模板

templates/
  index.html             # Vue 3 挂载点
```

### 实际 `POST /api/edge/analyze` 调用链路

```
EdgeMonitor 卡片按钮 → $emit('run-analysis', taskId)
TaskModal 底栏按钮    → $emit('run-analysis', taskId)
                    ↓
         app.js:481  runAnalysis(taskId)
                    ↓
         fetch POST /api/edge/analyze {task_id, thinking_mode: true}
                    ↓
         server/edge_routes.py:535  analyze_edge_task()
                    ↓
         _build_edge_analysis_prompt(task) → 纯文本 prompt
         run_agent_with_trace(prompt, config, …) → DeepSeek API
                    ↓
         update_edge_task_analysis(task_id, {answer, trace, structured_data})
                    ↓
         前端 EdgeMonitor 的 parseAgentAnalysis(answer) 解析风险等级/语义/建议
```

### 旧计划中的过时引用清单

| 旧计划写的 | 实际对应位置 |
|---|---|
| `app.js` 第 1422 行 `renderEdgeTasks()` | **不存在**。已改为 Vue 3 `EdgeMonitor.js` 模板 |
| `app.js` 第 1468-1471 行按钮事件 | **不存在**。按钮在 `EdgeMonitor.js:256` |
| `app.js` 中的 `escapeHtml()` | 在 `map_helpers.js:3` 和 `TaskModal.js:14` 各有一份 |
| `templates/index.html` 中的静态 DOM | 已改为 Vue 模板语法（`v-if` / `v-for` / `@click`） |

---

## 一、前置调研结论

### 1.1 当前"云端分析"的实现（确认不变）

```
Atlas YOLO 推理 → detection JSON + annotated.jpg
  → POST /api/edge/events → DB
  → POST /api/edge/analyze
  → _build_edge_analysis_prompt(): YOLO 标签 → 文本 prompt
  → DeepSeek API: 基于"检测到2人+1球"纯文本推断场景
  → 标注图从未发给 LLM，仅用于管理平台展示
```

### 1.2 SenseNova 6.7 Flash-Lite（确认可比）

| 项目 | 详情 |
|---|---|
| 模型 ID | `sensenova-6.7-flash-lite` |
| 能力 | 原生多模态：文本 + 图片输入 → 文本输出 |
| API 地址 | `https://token.sensenova.cn/v1` |
| 协议 | 完全 OpenAI-compatible（`/v1/chat/completions`） |
| 图片格式 | 支持 base64 data URL，遵循 OpenAI `content` 数组格式 |
| 上下文 | 256K tokens |
| 免费额度 | 每 5 小时 1500 次 |
| Python SDK | 无需额外包，`langchain-openai` 的 `ChatOpenAI` 即可 |

### 1.3 关键约束

- `langchain-openai` 已在 `requirements.txt` 中，无需新增依赖
- `concurrent.futures` 是 Python 标准库
- 视觉分析不需要 LangChain Agent（不调天气/交通等工具），直接用 `ChatOpenAI.invoke()` 一问一答

---

## 二、双模型架构设计

### 2.1 接口协议

```
POST /api/edge/analyze
  {task_id, thinking_mode, mode: "text"|"vision"|"both"}

mode 默认 "both"，不传时两条路径都跑
```

### 2.2 三条分析路径

```
mode="text"（Sentinel DeepSeek 文本推理，完全兼容旧行为）
  └─ _analyze_with_text(task)
       └─ _build_edge_analysis_prompt(task) → LangChain Agent → answer + trace

mode="vision"（SenseNova 多模态真看图）
  └─ server/vision_analyzer.py:analyze_with_vision(task)
       └─ 读取 data/edge_artifacts/ 本地标注图 → base64
       └─ 构造 multimodal prompt（图 + 引导文字）
       └─ ChatOpenAI.invoke() → answer

mode="both"（并行，默认）
  └─ ThreadPoolExecutor 同时跑 text + vision
  └─ 合并结果 → analysis.answer（vision 在前，text 在后补充）
```

### 2.3 `analysis` JSON 结构（存入 SQLite）

```python
analysis = {
    "answer": "## 👁️ 多模态视觉分析\n\n...\n\n---\n\n## 📊 文本推理补充\n\n...",
    "trace": [...],               # trace 来自 text agent（vision 没有 trace）
    "structured_data": {...},     # 来自 text agent
    "mode": "both",
    "text_analysis": {
        "answer": "...",
        "trace": [...],
        "model": "deepseek-v4-pro",
        "structured_data": {...},
    },
    "vision_analysis": {
        "answer": "...",
        "model": "sensenova-6.7-flash-lite",
    },
}
```

**关键设计决策**：顶层 `answer` / `trace` / `structured_data` 三个字段与旧格式完全兼容。所有现有前端渲染代码（`EdgeMonitor.js` `parseAgentAnalysis()`、`TaskModal.js` 的 `v-html="renderMarkdown(...)"`、报告导出的 `_build_task_report()`）都只读 `analysis.answer` 和 `analysis.trace`——不改它们就不会坏。

### 2.4 降级策略

| 场景 | 行为 |
|---|---|
| `.env` 无 `VISION_API_KEY` | `mode="both"` 自动降级为纯 text；`mode="vision"` 返回错误 |
| 任务无标注图 | vision 跳过，只跑 text |
| SenseNova API 超时/报错 | vision 异常被 catch，text 结果照常返回，`vision_analysis.error` 记录原因 |
| DeepSeek API 超时/报错 | text 异常被 catch，vision 结果照常返回 |
| 两个都失败 | 整体返回 500 error |

### 2.5 重要：前端 `parseAgentAnalysis()` 兼容性

当前 `EdgeMonitor.js:50` 的 `parseAgentAnalysis()` 用这个正则从 `answer` 中提取场景理解：

```javascript
// 行 58
const semMatch = answer.match(/(?:场景理解|场景语义分析|图像语义|场景分析)[:：\s]*\n*([^#\n]+)/);
```

这个正则**不会匹配** `"场景视觉分析"`。必须让 vision answer 的第一行能被匹配到。方案有两个：

**方案 A（推荐）：修改 `parseAgentAnalysis()` 的正则，增加 `"场景视觉分析"`**

```javascript
// EdgeMonitor.js 行 58，改为：
const semMatch = answer.match(/(?:场景理解|场景语义分析|图像语义|场景分析|场景视觉分析)[:：\s]*\n*([^#\n]+)/);
```

**方案 B：让 vision prompt 生成的标题直接用现有匹配词**

让 vision analyzer 的 prompt 要求输出标题用 `"## 💡 场景语义分析"` 而非 `"## 👁️ 场景视觉分析"`，就无需改前端。

**本计划采用方案 A**——因为"场景视觉分析"这个标题更准确地描述了"模型真正看图理解"的行为，修改一行正则的代价很小。

### 2.6 风险等级解析兼容性

```javascript
// EdgeMonitor.js 行 53-55
let riskLevel = "低风险";
if (answer.includes("高风险")) riskLevel = "高风险";
else if (answer.includes("中风险")) riskLevel = "中风险";
```

这个逻辑只匹配字符串 `"高风险"` 和 `"中风险"`——只要 vision prompt 和 text prompt 都输出 `**风险评级**：高风险` 这样的格式，就能正确解析。当前 `_build_edge_analysis_prompt()`（行 736）就是这种格式，vision prompt 保持同样格式即可。

---

## 三、需要修改的文件

### 文件 1（新建）：`server/vision_analyzer.py`

完整新建的文件。职责：封装所有多模态视觉分析逻辑，与 `edge_routes.py` 中的文本分析完全解耦。

```python
# server/vision_analyzer.py
"""
多模态视觉分析模块。
使用 SenseNova 6.7 Flash-Lite 直接对 Atlas YOLO 标注图进行像素级场景理解。
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

EDGE_ARTIFACT_DIR = PROJECT_ROOT / "data" / "edge_artifacts"


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
        self.timeout: int = int(os.getenv("VISION_TIMEOUT", "120"))

    @property
    def is_available(self) -> bool:
        return bool(self.api_key)


def load_vision_config() -> VisionConfig:
    return VisionConfig()


def get_annotated_image_base64(task: dict[str, Any]) -> tuple[str | None, str]:
    """读取任务的标注图并返回 (base64_string, mime_type)。

    返回 (None, "") 表示无可用图片。
    """
    event = task.get("event") or {}
    filename = event.get("annotated_image_filename") or ""

    # 如果事件里没有文件名，尝试从 URL 提取
    if not filename:
        url = event.get("annotated_image_url", "")
        if url.startswith("/api/edge/artifacts/"):
            filename = url.replace("/api/edge/artifacts/", "")

    if not filename:
        return None, ""

    image_path = EDGE_ARTIFACT_DIR / Path(filename).name  # 防目录穿越
    if not image_path.exists():
        return None, ""

    image_bytes = image_path.read_bytes()

    # 如果图片 > 2MB，太大的 base64 可能超出 token 限制，需要告知调用方
    # 实际上 const 256K token 足够容纳 ~10MB base64，但先留这个检查
    if len(image_bytes) > 5 * 1024 * 1024:
        # 可以在未来加 PIL 压缩逻辑
        pass

    suffix = image_path.suffix.lower()
    mime = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
    }.get(suffix, "image/jpeg")

    return base64.b64encode(image_bytes).decode("ascii"), mime


def build_vision_prompt(task: dict[str, Any]) -> str:
    """构造发给多模态模型的提示词。

    与 _build_edge_analysis_prompt 的区别：
    - 这里不罗列 YOLO 标签（模型会自己看标注图中的检测框和文字标签）
    - 引导模型观察视觉细节（位置关系、环境背景、光照等）
    - 输出格式与 _build_edge_analysis_prompt 保持一致的三段式结构，
      确保前端 EdgeMonitor.js 的 parseAgentAnalysis() 能正确提取。
    """
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

请你**基于你亲眼看到的图像内容**（而不仅仅是上面的标签数字），直接输出以下三部分：

## 💡 场景视觉分析
[描述你从图像中实际观察到的场景。注意：人物之间的位置关系、环境背景（室内/室外/城市/自然）、光照条件、是否有遮挡、标注框覆盖的物体之间的空间关系等——这些都是 YOLO 标签数字无法传达的视觉信息。]

## ⚠️ 风险等级评估
**风险评级**：[低风险 / 中风险 / 高风险]
**判定依据**：[基于视觉观察，判断该场景是否存在安全隐患。例如：人员密集度、交通状况、异常行为等。]

## 🛠️ 智能处置建议
1. [基于视觉理解给出具体的边端设备调度指令]
2. [是否需要进一步人工复核或触发告警联动]

请保持简洁，直接输出三部分内容，不要额外的前言后缀。"""


def analyze_with_vision(task: dict[str, Any]) -> dict[str, Any]:
    """核心：使用 SenseNova 多模态模型分析 YOLO 标注图。

    返回格式与文本分析路径兼容：
    {
        "answer": "Markdown 格式分析文本",
        "model": "使用的模型名",
        "error": None   # 或 str
    }
    """
    config = load_vision_config()
    if not config.is_available:
        return {"answer": "", "model": "", "error": "VISION_API_KEY 未在 .env 中配置"}

    image_b64, mime_type = get_annotated_image_base64(task)
    if not image_b64:
        return {"answer": "", "model": "", "error": "该任务无标注图，无法进行多模态视觉分析"}

    prompt_text = build_vision_prompt(task)
    data_url = f"data:{mime_type};base64,{image_b64}"

    llm = ChatOpenAI(
        model=config.model,
        api_key=config.api_key,
        base_url=config.base_url,
        temperature=config.temperature,
        timeout=config.timeout,
    )

    # OpenAI vision format
    message: dict[str, Any] = {
        "role": "user",
        "content": [
            {"type": "text", "text": prompt_text},
            {
                "type": "image_url",
                "image_url": {"url": data_url, "detail": "high"},
            },
        ],
    }

    response = llm.invoke([message])
    content: str = (
        response.content if hasattr(response, "content") else str(response)
    )

    return {
        "answer": content.strip() if content else "",
        "model": config.model,
        "error": None,
    }
```

### 文件 2（修改）：`server/edge_routes.py`

#### 2a：新增导入（在顶部 import 区域）

在行 13 `import paramiko` 之后新增两行：

```python
import concurrent.futures

from server.vision_analyzer import analyze_with_vision, load_vision_config
```

#### 2b：重写 `analyze_edge_task()`（行 535-563）

完整替换：

```python
@edge_bp.post("/api/edge/analyze")
def analyze_edge_task():
    """触发云端 Agent 对边端任务进行语义分析。

    支持三种分析模式（payload.mode）：
    - "text":   仅 DeepSeek 文本推理（YOLO 标签 → prompt → LLM）
    - "vision": 仅 SenseNova 多模态看图（标注图 base64 → VLM）
    - "both":   两者并行执行，合并结果（默认）
    """
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return jsonify({"ok": False, "error": "JSON body must be an object"}), 400

    task_id = str(payload.get("task_id") or "").strip()
    task = get_edge_task(task_id) if task_id else None
    if not task:
        event = _normalize_edge_event(
            payload.get("event") if isinstance(payload.get("event"), dict) else payload
        )
        task = create_edge_task(event, status="received")
        task_id = task["id"]

    mode = str(payload.get("mode") or "both").strip()
    vision_config = load_vision_config()
    event = task.get("event") or {}
    has_image = bool(
        event.get("annotated_image_url")
        or event.get("annotated_image_filename")
    )

    # ---- 模式路由 ----
    text_result: dict[str, Any] | None = None
    vision_result: dict[str, Any] | None = None

    # 快速校验
    if mode == "vision" and not vision_config.is_available:
        return jsonify({
            "ok": False,
            "error": "VISION_API_KEY 未在 .env 中配置，无法使用多模态视觉分析模式。"
        }), 400
    if mode == "vision" and not has_image:
        return jsonify({
            "ok": False,
            "error": "该任务没有标注图，无法进行视觉分析。"
        }), 400

    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            futures: dict[str, concurrent.futures.Future] = {}

            if mode in ("text", "both"):
                futures["text"] = executor.submit(_run_text_analysis, task)

            if mode in ("vision", "both") and vision_config.is_available and has_image:
                futures["vision"] = executor.submit(analyze_with_vision, task)

            # 收集结果
            if "text" in futures:
                try:
                    text_result = futures["text"].result(timeout=180)
                except Exception as exc:
                    text_result = {
                        "answer": "",
                        "trace": [],
                        "model": "",
                        "error": str(exc),
                    }

            if "vision" in futures:
                try:
                    vision_result = futures["vision"].result(timeout=120)
                except Exception as exc:
                    vision_result = {
                        "answer": "",
                        "model": "",
                        "error": str(exc),
                    }

            # 合并结果
            answer_parts: list[str] = []
            if vision_result and vision_result.get("answer"):
                answer_parts.append(vision_result["answer"])
            if text_result and text_result.get("answer"):
                if answer_parts:
                    answer_parts.append(
                        "\n\n---\n\n## 📊 基于检测标签的文本推理补充（DeepSeek）\n\n"
                        + text_result["answer"]
                    )
                else:
                    answer_parts.append(text_result["answer"])

            combined_answer = (
                "\n\n".join(answer_parts) if answer_parts else "分析未能生成结果。"
            )

            # 合并 trace（只来自 text agent）
            combined_trace: list[dict[str, Any]] = (
                list(text_result["trace"])
                if text_result and text_result.get("trace")
                else []
            )

            analysis = {
                "answer": combined_answer,
                "trace": combined_trace,
                "structured_data": (
                    text_result.get("structured_data")
                    if text_result
                    else None
                ),
                "mode": mode,
                "text_analysis": text_result,
                "vision_analysis": vision_result,
            }

            updated = update_edge_task_analysis(task_id, analysis, status="completed")
            return jsonify({"ok": True, "task": updated, "analysis": analysis})

    except Exception as exc:
        return jsonify({
            "ok": False,
            "error": f"分析过程异常: {str(exc)}"
        }), 500
```

#### 2c：新增 `_run_text_analysis()` 辅助函数（放在 `analyze_edge_task` 后面）

```python
def _run_text_analysis(task: dict[str, Any]) -> dict[str, Any]:
    """纯文本分析路径（DeepSeek）。

    从 analyze_edge_task 中提取为独立函数，方便在 ThreadPoolExecutor 中执行。
    使用模块级已有的 run_agent_with_trace / load_llm_config / _build_edge_analysis_prompt。
    """
    prompt = _build_edge_analysis_prompt(task)
    config = load_llm_config()
    answer, trace, structured_data = run_agent_with_trace(
        prompt,
        config,
        thinking_mode=True,
        message_history=[],
        client_context=(
            "你正在处理 Atlas 200I DK A2 边端 YOLO 检测结果，"
            "请优先给出场景理解、风险等级和调度建议。"
        ),
    )
    return {
        "answer": answer,
        "trace": trace,
        "model": config.thinking_model,
        "structured_data": structured_data,
        "error": None,
    }
```

### 文件 3（修改）：`static/components/EdgeMonitor.js`

#### 行 58：`parseAgentAnalysis()` 正则增加 `"场景视觉分析"`

找到行 58：

```javascript
const semMatch = answer.match(/(?:场景理解|场景语义分析|图像语义|场景分析)[:：\s]*\n*([^#\n]+)/);
```

改为：

```javascript
const semMatch = answer.match(/(?:场景理解|场景语义分析|图像语义|场景分析|场景视觉分析)[:：\s]*\n*([^#\n]+)/);
```

**只需要加 `|场景视觉分析` 这一个词**，其余逻辑不变。

### 文件 4（修改）：`static/app.js`

#### 行 486：`runAnalysis()` 的 fetch body 新增 `mode: "both"`

找到行 484-486：

```javascript
body: JSON.stringify({ task_id: taskId, thinking_mode: true })
```

改为：

```javascript
body: JSON.stringify({ task_id: taskId, thinking_mode: true, mode: "both" })
```

### 文件 5（修改）：`.env.example`

在文件末尾新增视觉模型配置段：

```bash
# ============================================================
# 多模态视觉分析模型（SenseNova 6.7 Flash-Lite）
# 用于对 Atlas YOLO 标注图进行像素级场景理解。
# 与主 LLM（DeepSeek）完全独立，可同时配置。
# 若不配置 VISION_API_KEY，系统自动降级为纯文本标签推理模式。
# 在商汤大模型平台 https://platform.sensenova.cn 获取 API Key。
# ============================================================
VISION_API_KEY=sk-your_sensenova_api_key_here
VISION_BASE_URL=https://token.sensenova.cn/v1
VISION_MODEL=sensenova-6.7-flash-lite
VISION_TEMPERATURE=0.3
VISION_TIMEOUT=120
```

### 文件 6（修改）：真实 `.env`（手工操作）

由执行者在本地 `.env` 末尾添加（内容不入 git）：

```bash
VISION_API_KEY=sk-i854S3w6vK22OZM8WRGsseemMDZX3mXc
VISION_BASE_URL=https://token.sensenova.cn/v1
VISION_MODEL=sensenova-6.7-flash-lite
VISION_TEMPERATURE=0.3
VISION_TIMEOUT=120
```

---

## 四、不需要改的文件（确认）

| 文件 | 原因 |
|---|---|
| `templates/index.html` | Vue 模板，只绑定组件，无分析逻辑 |
| `static/components/TaskModal.js` | 只用 `taskDetail.analysis.answer` 做 `v-html="renderMarkdown(...)"`，不解析内容结构 |
| `static/components/SidebarComponent.js` | 只有 SSH 控制按钮，不涉及分析 |
| `static/components/TravelAssistant.js` | 出行面板，无关 |
| `static/travel_helpers.js` | 辅助函数，无关 |
| `static/map_helpers.js` | 地图函数，无关 |
| `static/styles.css` | 样式表，无关 |
| `src/travel_agent/agent.py` | LangChain Agent 构建，视觉分析不经过它 |
| `src/travel_agent/config.py` | LLMConfig 仅管 DeepSeek/对话 LLM，Vision 用独立的 VisionConfig |
| `src/travel_agent/storage.py` | `update_edge_task_analysis()` 直接存 JSON dict，字段不限制 |
| `edge/atlas_yolo_detect_and_upload.py` | Atlas 端脚本，不改。上传逻辑不变 |
| `edge/atlas_upload_client.py` | 同上 |
| `server/vision_analyzer.py` | **新建**文件，不需要改 |

---

## 五、实施步骤

### Step 1：创建 `server/vision_analyzer.py`

复制第三节文件 1 的完整代码。

### Step 2：修改 `server/edge_routes.py`

执行三个修改：
1. 顶部新增 `import concurrent.futures` 和 `from server.vision_analyzer import ...`
2. 替换 `analyze_edge_task()` 函数体（行 535-563）
3. 在 `analyze_edge_task` 下方新增 `_run_text_analysis()` 函数

### Step 3：修改前端

1. `static/components/EdgeMonitor.js` 行 58：正则加 `|场景视觉分析`
2. `static/app.js` 行 484-486：body 加 `mode: "both"`

### Step 4：修改配置文件

1. `.env.example` 末尾追加视觉配置段
2. 真实 `.env` 末尾追加实际 API key（手工操作，不入 git）

### Step 5：重启服务验证

```powershell
# 停止旧服务
Get-Process -Name "python*" -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like "*anaconda3*" } |
  Stop-Process -Force

# 启动新服务
cd "C:\Users\BaoXinJie\Desktop\In NBU\计算机系统实习\atlas work"
C:\Users\BaoXinJie\anaconda3\python.exe app.py

# curl 测试
curl -X POST http://127.0.0.1:5000/api/edge/analyze \
  -H "Content-Type: application/json" \
  -d '{"task_id": "<存在的任务ID>", "mode": "both"}'
```

### Step 6：前端验证

1. 浏览器打开 `http://127.0.0.1:5000`
2. 切换到"边云协同"模式
3. 点击任一有标注图的任务的"云端分析"按钮
4. 等待完成后检查：
   - 卡片上的 Agent 分析卡片是否正确显示风险等级
   - 点击卡片打开详情弹窗，查看完整分析内容是否包含视觉分析 + 文本推理两部分
   - 导出 Markdown 报告查看是否包含完整内容

---

## 六、风险与注意事项

1. **SenseNova 免费额度限制**：每 5 小时 1500 次调用。正常使用绰绰有余，但不要频繁对同一任务重复分析。

2. **`concurrent.futures` 需要多线程**：Werkzeug 开发服务器默认开启多线程（`threaded=True`），ThreadPoolExecutor 可以正常工作。生产环境用 gunicorn 时确保 worker ≥ 2。

3. **`ChatOpenAI` 的 vision 格式**：`langchain-openai` 的 `ChatOpenAI` 支持 image_url content block——因为它底层就是 `openai` SDK。实测同一份代码可以同时用于文本 LLM（DeepSeek）和 vision LLM（SenseNova），只需改 `api_key` / `base_url` / `model`。

4. **标注图可能很大**：如果原始图 > 5MB，base64 后 > 6.7MB，虽然 SenseNova 256K token 可以容纳，但编码耗时和传输时间会明显变长。当前不做压缩处理（world_cup.jpg 约 100KB 级别，不是问题）。后续如果需要处理大图，可在 `get_annotated_image_base64()` 中加 PIL resize。

5. **Werkzeug 的 reloader 问题**：`app.py` 里 `debug=False`，不使用 reloader，所以新增文件不会被自动重载。每次改完代码必须手动重启。

6. **`paramiko` 不在 `requirements.txt`**：这是 Gemini 添加 SSH 控制时遗留的问题，不影响本任务，但后续应补上。本任务新增的文件不需要额外依赖（`langchain-openai` 和 `concurrent.futures` 已经在项目中）。

7. **前端 `parseAgentAnalysis()` 的正则改动极轻**：只在拼接串里加一个 `|场景视觉分析`，不会影响任何已有分析结果的解析。
