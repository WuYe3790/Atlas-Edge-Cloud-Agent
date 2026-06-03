# 项目转接文档

## 0. 接手范围约束

当前接手任务只包含代码、部署、联调与演示闭环维护。课程设计报告、PPT、海报、截图整理等材料撰写类任务已明确不需要继续由 AI 完成；旧版 handoff 中出现的报告类待办一律视为废弃。

## 1. 当前项目概况

项目名称：Atlas Edge Cloud Agent

GitHub 仓库：

```text
https://github.com/WuYe3790/Atlas-Edge-Cloud-Agent
```

本地工作区：

```text
C:\Users\BaoXinJie\Desktop\In NBU\计算机系统实习\atlas work
```

本地 Python：

```text
C:\Users\BaoXinJie\anaconda3\python.exe
```

项目目标是完成一套 Atlas 200I DK A2 边云协同系统：

```text
Atlas 边端 YOLO 推理
-> 上传检测结果和标注图
-> 笔记本云端服务接收
-> 云端 Agent 调用大模型生成语义分析
-> 管理平台展示设备状态、边端任务、调度链路和分析结果
```

当前采用"笔记本作为本地云端"的架构。Atlas 不需要直连外网，只要能访问笔记本：

```text
http://192.168.0.101:5000
```

## 2. 当前已完成工作

### 2.1 旧 Agent 迁移

已将旧出行规划 Agent 迁移到当前大作业工作区，并保留原 `.env` 配置。真实 `.env` 被 `.gitignore` 忽略，未上传 GitHub。

保留能力：

- Flask Web 管理平台；
- LangChain Agent；
- OpenAI-compatible LLM 调用；
- 本地 RAG 知识库；
- SQLite 会话/任务持久化；
- 地图、天气、交通、POI 等旧工具基础。

### 2.2 边云通信

Atlas 与笔记本已经双向连通，并已验证：

```bash
curl http://192.168.0.101:5000/api/health
```

返回：

```json
{"ok": true, "service": "atlas-edge-cloud-agent"}
```

### 2.3 Atlas YOLO 边端脚本

已新增：

```text
edge/atlas_yolo_detect_and_upload.py
```

部署到 Atlas 位置：

```text
/home/HwHiAiUser/samples/notebooks/01-yolov5/atlas_yolo_detect_and_upload.py
```

该脚本完成：

- 加载 `yolo.om`；
- 读取 `coco_names.txt`；
- 对图片执行 YOLO 推理；
- 调用 `det_utils.py` 中的 letterbox、NMS、scale_coords；
- 生成 `detections.json`；
- 生成 `summary.json`；
- 生成 `annotated.jpg`；
- 采集 loadavg、内存、uptime；
- 上传检测 JSON 和标注图；
- 默认触发云端 Agent 分析。

真实测试通过：

```text
image: world_cup.jpg
detections: 2 person, 1 sports_ball
latency_ms: 60.46 / 55.98 / 49.43 等
fps: 16.54 / 17.86 / 20.23 等
```

### 2.4 云端边端接口

已实现接口：

```text
GET  /api/health
POST /api/edge/events
POST /api/edge/heartbeat
GET  /api/edge/tasks
GET  /api/edge/tasks/<task_id>
GET  /api/edge/tasks/<task_id>/report
GET  /api/edge/status
GET  /api/edge/artifacts/<filename>
POST /api/edge/analyze
POST /api/edge/scheduling/validate    ← 新增
```

核心代码：

```text
server/edge_routes.py
src/travel_agent/storage.py
```

### 2.5 管理平台

状态页已包括：

- Atlas 设备状态；
- 在线/离线；
- 最近任务；
- 最近 FPS/延迟；
- 内存与负载；
- 待重传事件数量；
- YOLO 标注图；
- 检测摘要；
- 边端、调度、云端三段流程；
- 上云/本地调度标签 + 调度因子（人:N 车:N）；
- 云端分析摘要；
- 云端分析按钮；
- 导出报告链接；
- 任务详情弹窗（完整检测表、系统指标、分析结果、Agent 追踪链）。

前端相关文件：

```text
templates/index.html
static/app.js
static/styles.css
```

### 2.6 Docker 交付

已新增：

```text
Dockerfile
docker-compose.yml
.dockerignore
```

注意：当前电脑没有 `docker` 命令，因此 Docker 文件已写但尚未在本机实际构建验证。

### 2.7 文档

已新增：

```text
docs/design.md
docs/api.md
docs/demo.md
docs/handoff.md
README.md
edge/README.md
```

### 2.8 智能调度、任务详情、离线重传、RAG 与报告增强（本轮新增）

本轮（2026-06-03）新增以下功能：

**智能自动调度规则**

- 两个边端脚本（`edge/atlas_yolo_detect_and_upload.py`、`edge/atlas_upload_client.py`）中新增 `compute_scheduling_decision()` 函数。
- 6 条多因子调度规则按优先级执行：`--force-cloud` → 零目标 → 有人 → 有车 → 低置信度(<0.7) → 高负载(loadavg 1m > 2.0) → 默认本地。
- 调度决策包含 `handled_locally`、`need_cloud_analysis` 和 `reason` 三个字段。
- 服务端 `server/edge_routes.py` 新增 `POST /api/edge/scheduling/validate` 验证端点。
- 前端任务卡片新增"上云/本地"标签和调度因子 chips。

**任务详情弹窗**

- `templates/index.html` 新增 `#edgeTaskModal` 模态框。
- 点击任务卡片弹出详情，展示：基本信息、推理性能（模型/延迟/FPS/阈值）、标注图、检测明细表（类别/置信度/边界框）、调度决策、系统指标 JSON、完整云端分析（Markdown 渲染）、Agent 追踪链。
- 弹窗底部可导出报告或触发云端分析。
- 按 Escape 或点击遮罩关闭。

**断网重传队列**

- `post_json()` / `post_event()` 增加指数退避重试（3 次：2s / 4s / 8s）。
- 重试全部失败后，事件 JSON 保存到 `pending_events/event_<timestamp>.json`。
- 新增 `--retry-pending` 命令批量重传，成功后自动删除对应文件。
- `.gitignore` 已忽略 `pending_events/` 目录。
- 心跳接口支持上报 `pending_events` 计数，前端设备卡片展示待重传数量。

**RAG 边云知识库**

- 新增 `knowledge/edge_cloud.md`，内容覆盖系统架构、Atlas 硬件、YOLO 推理、调度策略、API 接口、断网重传、部署方式、管理平台和课程对应关系。
- `tool_rag.py` 自动扫描索引，Agent 分析边端任务时可检索该知识。

**报告增强**

- `_build_task_report()` 全面重写：新增基本信息表、推理性能、标注图内联链接、检测明细 Markdown 表格、调度决策详情、系统指标 JSON 块、Agent 追踪链（含工具调用和模型阶段）。

## 3. 当前运行方式

### 3.1 启动笔记本云端服务

在笔记本 PowerShell：

```powershell
cd "C:\Users\BaoXinJie\Desktop\In NBU\计算机系统实习\atlas work"
C:\Users\BaoXinJie\anaconda3\python.exe app.py
```

浏览器访问：

```text
http://127.0.0.1:5000
http://192.168.0.101:5000
```

### 3.2 上传脚本到 Atlas

上传心跳/手动 JSON 客户端：

```powershell
scp "C:\Users\BaoXinJie\Desktop\In NBU\计算机系统实习\atlas work\edge\atlas_upload_client.py" root@192.168.0.2:/home/HwHiAiUser/atlas_upload_client.py
```

上传 YOLO 检测客户端：

```powershell
scp "C:\Users\BaoXinJie\Desktop\In NBU\计算机系统实习\atlas work\edge\atlas_yolo_detect_and_upload.py" root@192.168.0.2:/home/HwHiAiUser/samples/notebooks/01-yolov5/atlas_yolo_detect_and_upload.py
```

### 3.3 Atlas 心跳

```bash
python3 /home/HwHiAiUser/atlas_upload_client.py \
  --server http://192.168.0.101:5000 \
  --heartbeat
```

### 3.4 Atlas YOLO 完整闭环

```bash
cd /home/HwHiAiUser/samples/notebooks/01-yolov5

# 不依赖 --force-cloud（让调度算法自动决策）：
python3 atlas_yolo_detect_and_upload.py \
  --image world_cup.jpg \
  --model yolo.om \
  --labels coco_names.txt \
  --server http://192.168.0.101:5000 \
  --upload

# 仍然可以强制上云：
python3 atlas_yolo_detect_and_upload.py \
  --image world_cup.jpg \
  --model yolo.om \
  --labels coco_names.txt \
  --server http://192.168.0.101:5000 \
  --upload \
  --force-cloud
```

- 默认上传后自动触发云端 Agent 分析；加 `--no-analyze` 跳过。
- 上传失败时自动重试 3 次，仍失败则保存到 `pending_events/`。
- 重传：`python3 atlas_yolo_detect_and_upload.py --server http://192.168.0.101:5000 --retry-pending`

## 4. 当前与大作业要求的对应状态

| 要求 | 当前状态 |
| --- | --- |
| 边端数据采集 | 已用静态图片上传替代摄像头 |
| YOLO 边端检测 | 已在 Atlas 上真实运行 `yolo.om` |
| 简单任务边端处理 | 已生成检测框、类别统计、FPS、内存/负载，含多因子调度决策 |
| 复杂任务云端处理 | 已将检测事件交给云端 Agent 分析 |
| 边云通信 | 已使用 HTTP/RESTful JSON 跑通 |
| 管理平台 | 已展示设备状态、任务、标注图、调度流程、分析摘要、任务详情弹窗 |
| 智能体对话 | LangChain Agent 聊天能力完整 |
| 本地知识库 RAG | 含 FAISS 本地知识库 + 边云协同专项知识（`knowledge/edge_cloud.md`） |
| 联网搜索 | Agent 工具基础保留，边端分析未强制每次搜索 |
| Docker | 文件已写，未实机验证 |
| 断网重连 | 已实现指数退避重试 + pending_events 本地队列 + --retry-pending 重传命令 |
| Demo 文档 | 已有 `docs/demo.md` |
| API 文档 | 已有 `docs/api.md` |
| 系统设计文档 | 已有 `docs/design.md` |

## 5. 仍需继续完成的工作（仅开发范围）

### 高优先级

1. **重新实机验证最新边端脚本**
   - 将 `edge/atlas_yolo_detect_and_upload.py` 和 `edge/atlas_upload_client.py` 重新上传到 Atlas；
   - 运行 `world_cup.jpg` 闭环，确认检测结果、标注图、调度决策、云端 Agent 分析和前端详情弹窗均正常；
   - 运行一次 `--retry-pending`，确认离线重传命令没有语法或路径问题。

2. **Docker 验证**
   - 在装有 Docker 的机器上执行：
     ```powershell
     docker compose up --build
     ```
   - 验证 `.env`、端口映射、SQLite volume。

### 中优先级

1. **摄像头实时流接入**
   - Atlas 脚本已经支持 `--camera` 和 `--interval-sec`；
   - 如果后续拿到 USB 摄像头或 RTSP 流，只需在 Atlas 上实测稳定性；
   - 当前无摄像头条件下继续使用静态图片上传即可完成边云协同闭环。

2. **调度阈值实测校准**
   - 默认高负载阈值为 `loadavg 1m > 2.0`；
   - 边端脚本已支持 `--load-threshold`，服务端 `/api/edge/scheduling/validate` 已支持 `load_threshold`；
   - Atlas 上空闲 loadavg 可能偏高，实测时可用 `--load-threshold 20` 等值校准，避免所有任务都因负载被强制上云。

### 低优先级

1. MQTT 通信替代 HTTP；
2. 多设备管理（多台 Atlas 同时接入）；
3. NPU 资源指标采集（昇腾芯片利用率、温度等）；
4. 公网服务器部署。

## 6. 已知问题与注意事项

1. **`.env` 不能提交**
   - 里面是真实 API Key；
   - `.gitignore` 已忽略。

2. **本地课程要求 docx 和开发计划 md 不能提交**
   - 已加入 `.gitignore`。

3. **Docker 未验证**
   - 因当前电脑没有 Docker 命令。

4. **设备在线状态是 5 分钟窗口**
   - `/api/edge/status` 中 `online=true` 的判断条件是最近更新时间小于等于 300 秒。

5. **Atlas 负载值较高**
   - 当前截图里 loadavg 约 17；
   - 可解释为开发板运行环境负载指标，不一定等同于 CPU 占用百分比；
   - 调度算法中负载阈值设为 2.0（x86 标准），Atlas 上可能需要根据实际情况调高。

6. **无摄像头**
   - 当前采用静态图片作为数据采集替代方案；
   - 后续演示时直接说明即可，不需要在本项目内继续撰写报告材料。

7. **边端脚本需重新上传**
   - `edge/atlas_yolo_detect_and_upload.py` 和 `edge/atlas_upload_client.py` 本轮有较大改动（调度逻辑、重试队列）；
   - 下次使用 Atlas 前需重新 scp 上传最新版本。

### 2.9 前端与数据流修正 (2026-06-03 本轮修复)

本轮修复了前期开发中遗留的前端布局 BUG 与测试脏数据问题，提升了项目的真实性和可用性：

**数据流与设备监控清理**
- 彻底删除了数据库 `edge_devices` 与 `edge_tasks` 中（如 `atlas-heartbeat-test` 等）因为旧有测试脚本而残留的虚假设备数据。现在的系统严格按照实际传入的有效设备进行统计，解决了面板设备列表中出现多台离线设备的灵异现象。
- 从前端与后端同步拔除了“模拟心跳”按钮与关联的 `/api/edge/mock-heartbeat` 接口，去除了会伪造 CPU/RAM 数据的演示代码，完全恢复了对设备真实上传指标的依赖。
- 修改了 `static/app.js`，当设备处于离线状态时，主动清空（置为 `null` 或零）相关的性能指标（如 FPS、延迟），以防止历史滞后数据造成“离线仍在运行”的误解。

**前端布局修复**
- 修正了 `static/styles.css` 中 `.edge-cloud-panel` 样式带来的层级遮挡灾难。重新规范了 `[hidden]` 控制流，使得大屏边云监控面板与普通出行规划 Agent 对话框能够通过左侧导航栏优雅、独立地无缝切换，不再存在按钮相互遮挡的问题。

## 7. 下一位接手 AI 的建议路线

建议按以下顺序继续：


1. 先运行当前闭环，确认没有坏：
   ```bash
   curl http://192.168.0.101:5000/api/health
   ```
   ```bash
   cd /home/HwHiAiUser/samples/notebooks/01-yolov5
   python3 atlas_yolo_detect_and_upload.py --image world_cup.jpg --model yolo.om --labels coco_names.txt --server http://192.168.0.101:5000 --upload
   ```

2. 打开管理平台检查：
   ```text
   http://192.168.0.101:5000
   ```
   检查要点：设备状态卡片、边端任务列表（含调度因子）、点击任务卡片弹出的详情弹窗、云端分析结果。

3. 不需要继续写课程设计报告、PPT 或海报。

4. 如有 Docker 环境，验证 Docker 部署。

5. 若时间允许，接入 USB 摄像头或继续优化调度阈值。

## 8. 关键文件索引

边端（运行在 Atlas）：

```text
edge/atlas_yolo_detect_and_upload.py    ← YOLO 检测 + 上传 + 调度 + 重试队列
edge/atlas_upload_client.py             ← 通用上传 / 心跳 / 重传客户端
edge/README.md
```

云端服务：

```text
app.py                                  ← 入口
web.py                                  ← Flask 工厂
server/__init__.py                      ← create_app() 蓝图注册
server/edge_routes.py                   ← 边云通信接口（10+ 个端点）
server/chat_routes.py                   ← Agent 对话 / SSE 流式
server/core_routes.py                   ← 健康检查 / 状态 / 图片代理
server/conversation_routes.py           ← 会话 CRUD
server/amap_routes.py                   ← 高德地图前端辅助接口
server/bootstrap.py                     ← 运行时配置
server/context.py                       ← 用户位置上下文
```

智能体核心：

```text
src/travel_agent/agent.py               ← Agent 构建 / 调用 / 流式
src/travel_agent/config.py              ← LLM 配置 (.env 加载)
src/travel_agent/prompts.py             ← System Prompt（工具使用规则）
src/travel_agent/tools.py               ← 工具注册
src/travel_agent/skills.py              ← Skill 编排
src/travel_agent/storage.py             ← SQLite 持久化（4 张表）
src/travel_agent/trace.py               ← 执行追踪
src/travel_agent/structured.py          ← JSON 解析 / 结构化提取
src/travel_agent/tool_rag.py            ← FAISS RAG 知识库
src/travel_agent/train_tools.py         ← 12306 MCP 火车票工具
```

前端：

```text
templates/index.html                    ← 单页应用 + 模态框
static/app.js                           ← 前端逻辑（~2900 行）
static/styles.css                       ← 样式表
```

数据与知识：

```text
data/travel_agent.db                    ← SQLite
data/edge_artifacts/                    ← 标注图存储
knowledge/edge_cloud.md                 ← 边云协同知识库（本轮新增）
knowledge/agent_architecture.md
knowledge/travel_tips.md
knowledge/cities/*.md
```

部署：

```text
Dockerfile
docker-compose.yml
.dockerignore
requirements.txt
.env.example
```

## 9. 最近提交记录

```text
（本轮改动待提交）
dd59cb3 Add heartbeat and task report export
881d0e2 Add device status monitoring and delivery docs
c5d2b58 Complete edge cloud analysis loop with artifacts
9d4deba Add Docker deployment and edge task dashboard docs
bfcdf51 Add Atlas YOLO detection upload client
909eabe Initial atlas edge cloud agent project
```
