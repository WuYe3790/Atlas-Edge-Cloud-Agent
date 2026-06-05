# SenseNova 多模态视觉分析模块 — 详细实施计划

## 一、背景调研结论

### 1.1 当前"云端分析"的真实流程

```
Atlas YOLO 推理
  → detection JSON + annotated.jpg (标注图保存到 data/edge_artifacts/)
  → POST /api/edge/analyze
  → _build_edge_analysis_prompt(): 把 YOLO 检测标签拼成文本 prompt
  → DeepSeek API（纯文本模型）: 基于标签文字推理"检测到2人和1个球→可能是足球比赛"
  → 标注图从未发送给任何 LLM
```

**结论**：当前实现是"边端 YOLO 做视觉检测 → 云端 LLM 做文本推理"，标注图仅用于管理平台展示。这不算骗人（YOLO 确实跑了真实视觉检测），但确实不是多模态图片理解——模型从未看过图片本身。

### 1.2 SenseNova 6.7 Flash-Lite 能力确认

| 项目 | 详情 |
|---|---|
| 模型 ID | `sensenova-6.7-flash-lite` |
| 能力 | 原生多模态：文本 + 图片输入 → 文本输出 |
| API 地址 | `https://token.sensenova.cn/v1`（推荐）或 `https://api.sensenova.cn/v1` |
| 协议 | 完全 OpenAI-compatible（`/v1/chat/completions`） |
| 图片格式 | 支持 URL 和 base64，遵循 OpenAI vision content 数组格式 |
| 上下文 | 256K tokens（输入 252K + 输出 64K） |
| 免费额度 | 每 5 小时 1500 次调用 |
| 调用方式 | 与 `langchain-openai` 的 `ChatOpenAI` 完全兼容 |

### 1.3 关键发现：配置完全解耦

SenseNova 和 DeepSeek 使用不同的 API key、base_url、model name，互不影响。这意味着可以**同时配置两个模型**，在同一请求中并行或串行调用。

---

## 二、双模型架构设计

### 2.1 核心思路

```
POST /api/edge/analyze  {task_id, mode: "vision"|"text"|"both"}

  ┌─ mode="text" (DeepSeek 文本推理，兼容旧行为)
  │    └─ _analyze_with_text(task)
  │         └─ 构造 YOLO 标签文本 prompt → LangChain Agent → answer + trace
  │
  ├─ mode="vision" (SenseNova 多模态看图)
  │    └─ _analyze_with_vision(task)
  │         └─ 读取本地标注图 → base64 编码
  │         └─ 构造 multimodal prompt（图 + 文字引导）
  │         └─ ChatOpenAI 直调 SenseNova API → answer
  │
  └─ mode="both" (双模型并行，默认)
       └─ 并行调用 _analyze_with_text() + _analyze_with_vision()
       └─ 合并结果：视觉分析在前（真实看图），文本分析在后（标签补充）
       └─ 存入 analysis.answer（合并）+ analysis.text_analysis + analysis.vision_analysis
```

### 2.2 mode="both" 的结果合并策略

最终 `analysis` JSON 结构（存入 SQLite）：

```json
{
  "answer": "## 👁️ 多模态视觉分析（模型直接看图）\n\n...\n\n---\n\n## 📊 基于检测标签的文本推理（DeepSeek）\n\n...",
  "text_analysis": {
    "answer": "...",
    "trace": [...],
    "model": "deepseek-v4-flash"
  },
  "vision_analysis": {
    "answer": "...",
    "model": "sensenova-6.7-flash-lite"
  },
  "mode": "both",
  "trace": [...]
}
```

注意：`answer` 字段保持不变，确保管理平台前端完全零改动能正常工作。`text_analysis` 和 `vision_analysis` 是新增字段，前端可以后续选择性展示。

### 2.3 向后兼容

- 如果 `.env` 中未配置 `VISION_API_KEY`，自动降级为纯文本模式
- 如果任务没有标注图（手动上传事件），自动降级为纯文本模式
- `mode` 参数默认值为 `"both"`，前端按钮不传 mode 时两种分析都跑
- 旧 API 调用方（Atlas 脚本、前端控制台）完全无需修改

---

## 三、需要修改的文件

### 3.1 新建文件：`server/vision_analyzer.py`

这是核心新增模块，封装所有多模态视觉分析逻辑。独立成文件是为了职责分离——不污染已有 1000+ 行的 `edge_routes.py`。

```python
# server/vision_analyzer.py
"""
多模态视觉分析模块。
使用 SenseNova 6.7 Flash-Lite 直接对 YOLO 标注图进行像素级场景理解。
"""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from langchain_openai import ChatOpenAI

from server.bootstrap import PROJECT_ROOT

EDGE_ARTIFACT_DIR = PROJECT_ROOT / "data" / "edge_artifacts"


class VisionConfig:
    """从 .env 加载多模态视觉模型配置，与主 LLMConfig 完全独立。"""
    def __init__(self):
        load_dotenv()
        self.api_key = os.getenv("VISION_API_KEY", "").strip()
        self.base_url = os.getenv("VISION_BASE_URL", "https://token.sensenova.cn/v1").strip()
        self.model = os.getenv("VISION_MODEL", "sensenova-6.7-flash-lite").strip()
        self.enabled = bool(self.api_key)

    @property
    def is_available(self) -> bool:
        return self.enabled


def load_vision_config() -> VisionConfig:
    return VisionConfig()


def get_annotated_image_base64(task: dict[str, Any]) -> bytes | None:
    """根据任务中的 annotated_image_url 读取本地标注图文件并返回 base64 编码。"""
    event = task.get("event") or {}
    filename = event.get("annotated_image_filename") or ""
    if not filename:
        # 尝试从 URL 中提取文件名
        url = event.get("annotated_image_url", "")
        if url.startswith("/api/edge/artifacts/"):
            filename = url.replace("/api/edge/artifacts/", "")
    if not filename:
        return None
    image_path = EDGE_ARTIFACT_DIR / filename
    if not image_path.exists():
        return None
    return base64.b64encode(image_path.read_bytes()).decode("ascii")


def build_vision_prompt(task: dict[str, Any]) -> str:
    """构造发给多模态模型的提示词。
    
    与 DeepSeek 文本 prompt 不同，这里不需要罗列 YOLO 标签——
    模型会直接看标注图中的检测框和标签文字，自己理解场景。
    我们只需提供任务上下文和输出格式要求。
    """
    event = task.get("event") or {}
    inference = event.get("inference") or {}
    summary = event.get("summary") or {}
    edge_decision = event.get("edge_decision") or {}
    
    return f"""你正在查看一张由 Atlas 200I DK A2 边缘设备上的 YOLOv5 模型生成的标注图像。
图像上已经绘制了检测框和类别标签。

边端 YOLO 的检测摘要（供参考）：
- 总目标数: {summary.get('total_count', 0)}
- 人数: {summary.get('person_count', 0)}
- 车辆数: {summary.get('vehicle_count', 0)}
- 模型: {inference.get('model', 'unknown')}
- 推理延迟: {inference.get('latency_ms', 'N/A')} ms

请直接输出以下三部分内容，使用 Markdown 格式：

## 👁️ 场景视觉分析
[基于你对图片的实际观察，描述你看到的是什么场景。注意图片中的物体位置关系、环境背景、光照条件等视觉细节——这是 YOLO 标签无法传达的信息。]

## ⚠️ 风险等级评估
**风险评级**：[低风险 / 中风险 / 高风险]
**判定依据**：[基于你对图片的视觉观察，判断该场景下是否存在安全隐患。]

## 🛠️ 智能处置建议
1. [基于视觉理解给出具体建议]
2. [是否需要进一步人工复核或触发告警]

请保持简明扼要，直接输出三部分。"""


def analyze_with_vision(task: dict[str, Any]) -> dict[str, Any]:
    """核心函数：使用多模态模型分析 YOLO 标注图。
    
    返回格式与现有 agent 分析兼容：
    {
        "answer": "Markdown 格式的分析文本",
        "model": "使用的模型名称",
        "trace": []  # vision 调用不是 agent，trace 为空
    }
    """
    config = load_vision_config()
    if not config.is_available:
        return {"answer": "", "model": "", "error": "VISION_API_KEY 未配置", "trace": []}
    
    image_b64 = get_annotated_image_base64(task)
    if not image_b64:
        return {"answer": "", "model": "", "error": "任务无标注图，无法进行视觉分析", "trace": []}
    
    prompt_text = build_vision_prompt(task)
    
    llm = ChatOpenAI(
        model=config.model,
        api_key=config.api_key,
        base_url=config.base_url,
        temperature=0.3,
        timeout=120,
    )
    
    # OpenAI vision format: content is an array of text + image blocks
    message = {
        "role": "user",
        "content": [
            {"type": "text", "text": prompt_text},
            {
                "type": "image_url",
                "image_url": {
                    "url": f"data:image/jpeg;base64,{image_b64}",
                    "detail": "high"
                }
            }
        ]
    }
    
    response = llm.invoke([message])
    answer = response.content if hasattr(response, 'content') else str(response)
    
    return {
        "answer": answer.strip() if answer else "",
        "model": config.model,
        "trace": [],
    }
```

### 3.2 修改文件：`server/edge_routes.py`

改动集中在 `analyze_edge_task()` 函数（行 526-554），重写为支持双模式。

**改动点 A**：顶部导入新增

```python
# 在文件顶部 import 区域新增
from server.vision_analyzer import analyze_with_vision, load_vision_config
```

**改动点 B**：重写 `analyze_edge_task()` 函数

```python
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

    # 分析模式：vision（多模态看图）/ text（DeepSeek 文本）/ both（两者，默认）
    mode = str(payload.get("mode") or "both").strip()

    vision_config = load_vision_config()
    event = task.get("event") or {}
    has_image = bool(event.get("annotated_image_url") or event.get("annotated_image_filename"))

    # === 模式路由 ===

    vision_result = None
    text_result = None
    combined_trace = []

    try:
        # 并行执行两条分析路径（注意：Flask 默认是同步的，用 concurrent.futures 实现）
        import concurrent.futures

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            futures = {}

            # Text analysis (DeepSeek / LangChain Agent)
            if mode in ("text", "both"):
                futures["text"] = executor.submit(
                    _run_text_analysis, task
                )

            # Vision analysis (SenseNova multimodal)
            if mode in ("vision", "both") and vision_config.is_available and has_image:
                futures["vision"] = executor.submit(
                    analyze_with_vision, task
                )
            elif mode == "vision" and not vision_config.is_available:
                return jsonify({
                    "ok": False,
                    "error": "VISION_API_KEY 未在 .env 中配置，无法使用多模态视觉分析模式。"
                }), 400
            elif mode == "vision" and not has_image:
                return jsonify({
                    "ok": False,
                    "error": "该任务没有标注图，无法进行视觉分析。"
                }), 400

            # 收集结果
            if "text" in futures:
                try:
                    text_result = futures["text"].result(timeout=180)
                except Exception as exc:
                    text_result = {"answer": f"文本分析失败: {exc}", "trace": [], "model": "", "error": str(exc)}

            if "vision" in futures:
                try:
                    vision_result = futures["vision"].result(timeout=120)
                except Exception as exc:
                    vision_result = {"answer": "", "model": "", "error": str(exc), "trace": []}

            # 合并结果
            answer_parts = []
            if vision_result and vision_result.get("answer"):
                answer_parts.append(vision_result["answer"])
            if text_result and text_result.get("answer"):
                # 去掉 text_result 中可能已有的 "场景语义分析" 等标题，
                # 因为 vision 分析已经提供了同类内容。改为标记为补充分析。
                text_answer = text_result["answer"]
                if vision_result and vision_result.get("answer"):
                    answer_parts.append("\n\n---\n\n## 📊 基于检测标签的文本推理补充（DeepSeek）\n\n" + text_answer)
                else:
                    answer_parts.append(text_answer)

            combined_answer = "\n\n".join(answer_parts) if answer_parts else "分析未能生成结果。"

            # 合并 trace
            if text_result and text_result.get("trace"):
                combined_trace = list(text_result["trace"])
            if vision_result and vision_result.get("trace"):
                combined_trace = combined_trace + list(vision_result["trace"])

            analysis = {
                "answer": combined_answer,
                "trace": combined_trace,
                "mode": mode,
                "text_analysis": text_result,
                "vision_analysis": vision_result,
            }

            updated = update_edge_task_analysis(task_id, analysis, status="completed")
            return jsonify({"ok": True, "task": updated, "analysis": analysis})

    except Exception as exc:
        # 整体异常兜底
        return jsonify({"ok": False, "error": f"分析过程异常: {str(exc)}"}), 500


def _run_text_analysis(task: dict[str, Any]) -> dict[str, Any]:
    """提取为独立函数以便在线程池中执行。"""
    from travel_agent.agent import run_agent_with_trace
    from travel_agent.config import load_llm_config

    prompt = _build_edge_analysis_prompt(task)
    config = load_llm_config()
    answer, trace, structured_data = run_agent_with_trace(
        prompt,
        config,
        thinking_mode=True,
        message_history=[],
        client_context="你正在处理 Atlas 200I DK A2 边端 YOLO 检测结果，请优先给出场景理解、风险等级和调度建议。",
    )
    return {
        "answer": answer,
        "trace": trace,
        "model": config.model,
        "structured_data": structured_data,
    }
```

### 3.3 修改文件：`.env.example`

在文件末尾新增多模态视觉模型配置段：

```bash
# ============================================================
# 多模态视觉分析模型（SenseNova 6.7 Flash-Lite）
# 用于对 Atlas YOLO 标注图进行像素级场景理解。
# 与主 LLM（DeepSeek）完全独立，可同时配置。
# 若不配置 VISION_API_KEY，系统自动降级为纯文本标签推理模式。
# ============================================================
# VISION_API_KEY 在商汤大模型平台 (https://platform.sensenova.cn) 获取。
# VISION_BASE_URL 默认为商汤公测地址，通常无需修改。
# VISION_MODEL 使用免费的 sensenova-6.7-flash-lite。
VISION_API_KEY=sk-your_sensenova_api_key_here
VISION_BASE_URL=https://token.sensenova.cn/v1
VISION_MODEL=sensenova-6.7-flash-lite
```

### 3.4 修改文件：真实 `.env`

在用户本地的 `.env` 文件中（**不提交 git**），新增实际可用的 API key：

```bash
VISION_API_KEY=sk-i854S3w6vK22OZM8WRGsseemMDZX3mXc
VISION_BASE_URL=https://token.sensenova.cn/v1
VISION_MODEL=sensenova-6.7-flash-lite
```

### 3.5 修改文件：`static/components/EdgeMonitor.js`（前端按钮支持 mode 参数）

当前任务卡片上的"云端分析"按钮发送请求时没有传 `mode`。默认 `mode="both"`，所以不改也能跑。但可以给请求加 `mode` 字段，让前端能控制分析策略：

```javascript
// EdgeMonitor.js 中 runAnalysis 的 emit 触发时，app.js 中 runAnalysis 函数改为：
const runAnalysis = async (taskId, mode = "both") => {
    const response = await fetch("/api/edge/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task_id: taskId, thinking_mode: true, mode })
    });
    // ...
};
```

传入 `mode: "both"` 即可同时触发两种分析。

### 3.6 修改文件：`static/components/TaskModal.js`（展示双模型结果）

`TaskModal.js` 目前只渲染 `taskDetail.analysis?.answer`。因为 answer 中已经合并了两个模型的结果，前端**不需要改动**就能展示。但未来可以新增分栏展示两个模型各自的输出。

### 3.7 前端界面说明

**零改动即可工作**：因为分析结果仍然写入 `analysis.answer`，所有现有的展示逻辑（EdgeMonitor 卡片上的 Agent 分析卡片、TaskModal 弹窗、报告导出）都不需要修改。analyze 按钮默认 `mode="both"`，两个模型并行跑，结果自动合并到 answer 中。

---

## 四、数据流对比

### 改造前

```
Atlas YOLO → detection JSON → POST /api/edge/events → DB
                                                         ↓
                                      POST /api/edge/analyze
                                            ↓
                                      YOLO标签 → 文本prompt
                                            ↓
                                      DeepSeek(纯文本) → analysis.answer
```

### 改造后

```
Atlas YOLO → detection JSON + annotated.jpg → POST /api/edge/events → DB
                                                                          ↓
                                                       POST /api/edge/analyze {mode:"both"}
                                                                  ↓
                                          ┌───────────────────────┴───────────────────────┐
                                          ↓ (线程1)                                     ↓ (线程2)
                                    YOLO标签 → 文本prompt                  读取本地标注图 → base64编码
                                          ↓                                               ↓
                                    DeepSeek(纯文本)                      SenseNova(多模态，真看图)
                                          ↓                                               ↓
                                    text_result                                vision_result
                                          ↓                                               ↓
                                          └───────────────────┬───────────────────────────┘
                                                              ↓
                                              合并: answer = vision + text
                                                              ↓
                                                    存入 analysis JSON → DB
                                                              ↓
                                                    管理平台零改动 → 正常展示
```

---

## 五、错误处理与降级策略

| 场景 | 行为 |
|---|---|
| `VISION_API_KEY` 未配置 | vision 不可用，`mode="both"` 时只跑 text，`mode="vision"` 时返回错误 |
| 任务无标注图 | vision 不可用，降级为纯 text |
| SenseNova API 超时/报错 | vision 失败，text 结果照常返回，answer 中注明 vision 分析失败 |
| DeepSeek API 超时/报错 | text 失败，vision 结果照常返回 |
| 两个 API 都失败 | 返回整体错误 |
| 标注图文件被删除 | vision 启动前检测文件是否存在，不存在则跳过 |

---

## 六、实施步骤（按顺序）

### Step 1: 新建 `server/vision_analyzer.py`
- 复制上述完整代码
- 包含 `VisionConfig`、`load_vision_config()`、`get_annotated_image_base64()`、`build_vision_prompt()`、`analyze_with_vision()`

### Step 2: 修改 `server/edge_routes.py`
- 顶部新增 `from server.vision_analyzer import analyze_with_vision, load_vision_config`
- 新增 `import concurrent.futures`
- 重写 `analyze_edge_task()` 函数（替换第 526-554 行）
- 新增 `_run_text_analysis()` 辅助函数（放在 `analyze_edge_task` 下方）

### Step 3: 修改 `.env.example`
- 文件末尾新增 Vision 配置段

### Step 4: 更新真实 `.env`
- 写入实际的 `VISION_API_KEY`

### Step 5: 语法验证
```powershell
C:\Users\BaoXinJie\anaconda3\python.exe -c "
import sys
sys.path.insert(0, r'C:\Users\BaoXinJie\Desktop\In NBU\计算机系统实习\atlas work\src')
from server.vision_analyzer import VisionConfig, analyze_with_vision
from server.edge_routes import edge_bp
print('All imports OK')
"
```

### Step 6: 端到端测试
1. 重启 Flask 服务
2. 确保 Atlas 已上传过标注图的任务存在
3. 浏览器打开管理平台，点击任务的"云端分析"按钮
4. 验证：分析结果包含"👁️ 场景视觉分析"（来自 SenseNova 真看图）和"📊 文本推理补充"（来自 DeepSeek）
5. 或者用 curl 直接测试：
```bash
curl -X POST http://127.0.0.1:5000/api/edge/analyze \
  -H "Content-Type: application/json" \
  -d '{"task_id": "edge-xxx", "mode": "both"}'
```

---

## 七、注意事项与风险

1. **SenseNova API 是免费的但有调用频率限制**（每 5 小时 1500 次）。正常使用不会超标，但如果频繁重复分析同一任务要小心。

2. **标注图 base64 可能很大**。一张 1920×1080 的 JPEG 约 200-500KB，base64 后约 270-670KB。SenseNova 的 256K token 上下文可以容纳，但如果图片特别大可能需要先压缩。建议如果图片超过 1MB，先用 PIL 压缩到 1024px 宽再编码。

3. **并行调用需要 `concurrent.futures`**（Python 标准库，无需安装）。Flask 的默认开发服务器（Werkzeug）支持多线程，但生产环境用 gunicorn 时需确保 worker 数 ≥ 2。

4. **`analysis_json` 字段体积**：双模型结果存入同一个 JSON 字段，比之前大约增加一倍的文本。SQLite 的 TEXT 类型可以存储，但注意单个字段不要超过 1GB（实际不可能，分析文本通常 2-10KB）。

5. **向后兼容**：`analysis.answer` 只有在请求了对应模式时才会变化。如果不传 `mode` 参数，默认 `"both"`，两个模型都跑。旧的 Atlas 脚本调用 `/api/edge/analyze` 时不传 mode，因此会自动同时触发两种分析——**对 Atlas 端零改动**。

6. **必须创建新文件** `server/vision_analyzer.py`，这是为了避免 `edge_routes.py` 继续膨胀。同时保持关注点分离——视觉分析逻辑、文本分析逻辑、路由处理各司其职。
