# Atlas Edge-Cloud Agent

基于 **Atlas 200I DK A2** 昇腾开发板的边云协同智能体系统。

`"简单任务边缘处理，复杂任务云端决策"`

---

## 项目简介

本系统采用 **端-边-云** 三层架构，实现了一套完整的 AI 视觉检测与智能分析链路：

- **摄像头采集**：笔电/USB 摄像头 MJPEG 实时推流
- **边缘推理**：Atlas 运行 YOLOv5 OM 模型，40ms/帧实时目标检测，>15 FPS
- **云端智能体**：LangChain Agent (DeepSeek V4 Pro) 多轮推理 + SenseNova 多模态视觉分析 + 22 个工具链
- **管理平台**：Vue 3 单页应用，双模式界面，一键启动完整边云协同流程

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            管理平台 (Vue 3)                                  │
│  http://localhost:5000                                                      │
│  ┌──────────────────────┐    ┌──────────────────────────────────────────┐  │
│  │    出行助手模式        │    │         边云协同监控模式                   │  │
│  │  · Agent 多轮对话     │    │  · 实时摄像头预览 + YOLO 标注帧            │  │
│  │  · 22 工具调用        │    │  · 任务管道：推理 → 调度 → 云端分析        │  │
│  │  · 结构化卡片渲染     │    │  · SSH 板端控制面板                       │  │
│  │  · SSE 流式输出       │    │  · 终端抽屉实时日志                       │  │
│  └──────────────────────┘    └──────────────────────────────────────────┘  │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │ HTTP/RESTful API + SSE
┌──────────────────────────────────┴──────────────────────────────────────────┐
│                       笔记本云端 (Flask + LangChain)                          │
│  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────────────────┐ │
│  │ LangChain Agent  │  │ SenseNova 多模态  │  │ FAISS RAG 本地知识库       │ │
│  │ DeepSeek V4 Pro  │  │ 6.7 Flash-Lite   │  │ (4 个 .md 知识文件)        │ │
│  └─────────────────┘  └──────────────────┘  └────────────────────────────┘ │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ 22 个 LangChain Tools: 天气×4 · 交通×6 · 航班 · 火车票×3 · 酒店 ·     │  │
│  │ POI×3 · RAG · 预算 · 联网搜索 · Skill×2                               │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────┐  ┌─────────────────────────────────────────────┐ │
│  │ SQLite 持久化 (4 表)   │  │ SSH 远程板端控制 (paramiko)                 │ │
│  └──────────────────────┘  └─────────────────────────────────────────────┘ │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │ HTTP/RESTful JSON
┌──────────────────────────────────┴──────────────────────────────────────────┐
│               Atlas 200I DK A2 边端 (192.168.0.2)                            │
│  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────────────────┐ │
│  │ YOLOv5 OM 推理   │  │ 多因子调度决策     │  │ NPU/CPU/内存指标采集        │ │
│  │ ~40ms/帧, ~25FPS │  │ 6 条优先级规则     │  │ npu-smi + loadavg + meminfo│ │
│  └─────────────────┘  └──────────────────┘  └────────────────────────────┘ │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ 离线重传队列 (pending_events/) · 持续心跳 · 零外部依赖                  │  │
│  │ 视频自适应抽帧 (8-30 帧) · 断网恢复自动清理队列                          │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 快速开始

### 环境要求

| 组件 | 要求 |
|------|------|
| Python | 3.11+ |
| Node.js | 18+（用于 12306 火车票 MCP 工具） |
| 大模型 API | DeepSeek API Key（或任一 OpenAI-compatible 端点） |
| 多模态 API | SenseNova / OpenAI Vision API Key |
| 地图 API | 高德地图 Web API Key |
| 天气 API | 和风天气 JWT Key（或 API Key） |
| 边端设备 | Atlas 200I DK A2 + 相机（笔电/UVC/IP摄像头/视频文件） |

### 启动（本地开发）

```powershell
# 1. 克隆项目
git clone https://github.com/WuYe3790/Atlas-Edge-Cloud-Agent.git
cd Atlas-Edge-Cloud-Agent

# 2. 创建并激活虚拟环境
python -m venv venv
venv\Scripts\activate  # Windows
# source venv/bin/activate  # Linux/macOS

# 3. 安装依赖
pip install -r requirements.txt

# 4. 配置环境变量
copy .env.example .env
# 编辑 .env，填入各 API Key

# 5. 启动服务
python app.py
```

访问 **http://127.0.0.1:5000**

### 启动（Docker）

```bash
# 构建并启动
docker compose up -d

# 查看日志
docker compose logs -f

# 停止
docker compose down
```

### 启动边端（Atlas）

Atlas 需通过 USB RNDIS 或局域网与笔记本互通。确认互联后：

```bash
# 方式 1：管理平台一键启动（推荐）
# 浏览器打开管理平台 → 切换到"边云协同"模式 → 点击"开启笔电摄像头"

# 方式 2：Atlas 手动执行
ssh root@192.168.0.2
cd /home/HwHiAiUser/samples/notebooks/01-yolov5
python3 /home/HwHiAiUser/atlas_yolo_detect_and_upload.py \
  --camera http://192.168.0.101:5000/camera/stream \
  --model yolo.om --labels coco_names.txt \
  --server http://192.168.0.101:5000 --upload --force-cloud
```

---

## 核心功能

### 1. 边端 YOLO 实时推理

| 功能 | 说明 |
|------|------|
| 模型 | YOLOv5 OM（昇腾 ACL 离线模型） |
| 性能 | ~40ms/帧，实测 25.14 FPS |
| 输入 | 笔电摄像头 MJPEG / USB UVC / RTSP / 本地视频文件 |
| 输出 | 边界框、类别、置信度、标注图、结构化 JSON |
| 调度 | 6 条优先级规则自动判断是否上云分析 |

### 2. 云端智能体分析

| 路径 | 模型 | 说明 |
|------|------|------|
| 文本推理 | DeepSeek V4 Pro | Agent 多轮对话 + 22 工具链 + 结构化输出 |
| 图片分析 | SenseNova 6.7 Flash-Lite | 单帧 YOLO 标注图 → 场景理解 + 风险评估 |
| 视频分析 | SenseNova + 帧拼接 | 多帧时序关联 + 动态事件识别 |
| 双模并行 | DeepSeek + SenseNova | ThreadPoolExecutor 同时运行 |

### 3. 22 个 LangChain 工具

| 类别 | 工具 | 数据源 |
|------|------|--------|
| 天气 | 实时天气、空气质量、天气预警、生活指数 | 和风天气 JWT |
| 交通 | 驾车路径、公交地铁、步行、骑行、实时路况 | 高德地图 |
| 航班 | `search_flight_options` | LetsFG |
| 火车票 | 直达查询、中转查询、经停时刻 | 12306 MCP |
| 酒店 | `search_hotel_prices` | RapidAPI Booking → 降级高德 POI |
| 地点 | POI 搜索、周边搜索、位置解析、地图标注 | 高德地图 |
| 知识 | `search_local_knowledge` | FAISS 向量检索 |
| 技能 | 市内交通 Skill、跨城交通 Skill | 组合编排上述工具 |
| 搜索 | `web_search` | DuckDuckGo |
| 预算 | `calculate_trip_budget` | 纯计算 |

### 4. 管理平台

- **出行助手模式**：Agent 对话、输入联想、结构化卡片（天气/交通/行程/酒店/POI）
- **边云协同模式**：实时视频预览、YOLO 标注帧、SSH 板端控制、任务管道可视化
- **摄像头推流**：一键启动笔电摄像头 → 自动 SSH 部署 YOLO 到 Atlas → 实时双画面
- **术语终端**：滑出式终端抽屉，实时显示 SSH 操作日志

---

## 配置说明

复制 `.env.example` 为 `.env`，填写以下配置：

```ini
# ── 大语言模型 (DeepSeek) ──
LLM_API_KEY=sk-your-deepseek-key
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-v4-flash
LLM_THINKING_MODEL=deepseek-v4-pro

# ── 多模态视觉大模型 (SenseNova) ──
VISION_API_KEY=sk-your-sensenova-key
VISION_BASE_URL=https://token.sensenova.cn/v1
VISION_MODEL=sensenova-6.7-flash-lite

# ── 高德地图 ──
AMAP_API_KEY=your-amap-key

# ── 和风天气 ──
QWEATHER_JWT_KEY_ID=your-key-id
QWEATHER_JWT_PROJECT_ID=your-project-id
QWEATHER_JWT_PRIVATE_KEY=your-private-key

# ── 酒店价格 (RapidAPI Booking) ──
RAPIDAPI_KEY=your-rapidapi-key
RAPIDAPI_HOST=booking-com15.p.rapidapi.com

# ── Atlas 开发板连接 ──
ATLAS_BOARD_IP=192.168.0.2
ATLAS_BOARD_USER=root
ATLAS_BOARD_PASSWORD=Mind@123
```

---

## 项目结构

```
atlas-work/
├── app.py                              # Flask 启动入口
├── requirements.txt                    # Python 依赖
├── Dockerfile                          # Docker 镜像定义
├── docker-compose.yml                  # Docker 编排
├── .env.example                        # 环境变量模板
├── README.md
│
├── server/                             # Flask 服务层
│   ├── __init__.py                     # 蓝图注册
│   ├── edge_routes.py                  # ★ 边云通信核心 (~1900 行, 20+ 路由)
│   ├── camera_stream.py                # ★ 摄像头 MJPEG + SSE + SSH YOLO 一键部署
│   ├── vision_analyzer.py              # ★ SenseNova 多模态视觉分析
│   ├── chat_routes.py                  # Agent SSE 流式对话
│   ├── core_routes.py                  # 健康检查 / 状态 / 图片代理
│   ├── conversation_routes.py          # 会话 CRUD
│   └── amap_routes.py / amap_client.py / context.py / bootstrap.py
│
├── edge/                               # Atlas 边端脚本
│   ├── atlas_yolo_detect_and_upload.py # YOLO + 摄像头 + NPU + 调度 + 上传
│   └── atlas_upload_client.py          # 手工上传 + 心跳 + 离线重传
│
├── src/travel_agent/                   # LangChain 智能体
│   ├── agent.py                        # Agent 构建 + SSE 流式 + trace
│   ├── config.py                       # LLMConfig (DeepSeek)
│   ├── prompts.py                      # System Prompt
│   ├── tools.py                        # 22 工具注册
│   ├── skills.py                       # Skill 编排
│   ├── storage.py                      # SQLite 持久化 (4 表)
│   ├── trace.py / structured.py
│   ├── tool_rag.py                     # FAISS RAG 知识库
│   ├── tool_web_search.py              # DuckDuckGo 联网搜索
│   ├── train_tools.py                  # 12306 MCP (60s 冷却期重试)
│   └── tool_*.py                       # 天气/交通/POI/酒店/航班
│
├── static/                             # Vue 3 前端
│   ├── app.js                          # Vue 3 入口 (~1013 行)
│   ├── travel_helpers.js               # 基础工具/POI/markdown/酒店 (640 行)
│   ├── map_helpers.js                  # 高德交互地图 (283 行)
│   ├── chat_helpers.js                 # 聊天/SSE/Trace (440 行)
│   ├── cards_helpers.js                # 结构化卡片渲染 (732 行)
│   ├── components/
│   │   ├── SidebarComponent.js         # 侧栏 + SSH 控制面板 (364 行)
│   │   ├── EdgeMonitor.js              # 边云任务流 + 直播预览 (560+ 行)
│   │   ├── TaskModal.js                # 任务详情弹窗 (322 行)
│   │   └── TravelAssistant.js          # 出行对话面板 (236 行)
│   └── styles/
│       ├── base.css                    # 变量/重置/基础布局 (526 行)
│       ├── chat.css                    # 聊天面板 (786 行)
│       ├── cards.css                   # 结构化卡片 (1324 行)
│       └── edge.css                    # 边云 Dashboard (2170+ 行)
│
├── templates/index.html                # Vue 3 挂载点
│
├── data/                               # 运行时数据 (gitignore)
│   ├── travel_agent.db                 # SQLite
│   ├── edge_artifacts/                 # 标注图存储
│   └── uploads/                        # 文件缓存
│
├── knowledge/                          # RAG 知识库
│   ├── edge_cloud.md                   # 边云协同知识
│   ├── agent_architecture.md           # Agent 架构说明
│   ├── travel_tips.md                  # 旅游出行建议
│   └── history_insights.md             # 历史城市经验
│
├── docs/                               # 设计文档
│   ├── design.md / api.md / demo.md
│   └── plan_vision_multimodal.md
│
└── scripts/validate_edge_cloud.py      # 后端集成测试
```

---

## API 端点

### 边云通信

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/health` | GET | 服务健康检查 |
| `/api/edge/events` | POST | 接收边端检测事件 |
| `/api/edge/heartbeat` | POST | 设备心跳上报 |
| `/api/edge/tasks` | GET | 任务列表 |
| `/api/edge/tasks/<id>` | GET | 任务详情 |
| `/api/edge/tasks/<id>/report` | GET | Markdown 报告导出 |
| `/api/edge/status` | GET | 设备在线状态 + 指标 |
| `/api/edge/analyze` | POST | 触发云端分析 |
| `/api/edge/control` | POST | SSH 远程控制开发板 |
| `/api/edge/yolo-status` | GET | YOLO 推理状态查询 |

### 摄像头与实时预览

| 端点 | 方法 | 说明 |
|------|------|------|
| `/camera/stream` | GET | MJPEG 推流（Atlas 拉流输入） |
| `/api/edge/latest-frame` | GET | 最新 YOLO 标注帧元数据 |
| `/api/edge/latest-frame/image` | GET | 标注帧 JPEG（内存直出，零磁盘 I/O） |
| `/api/edge/latest-frame/stream` | GET | SSE 实时推送帧更新 |
| `/api/edge/camera/status` | GET | 摄像头状态 |
| `/api/edge/camera/start` | POST | 开启摄像头 |
| `/api/edge/camera/start-yolo` | POST | 开启摄像头 + SSH 部署 YOLO |
| `/api/edge/camera/stop` | POST | 关闭摄像头 + 终止 YOLO |

### Agent 对话

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/chat/stream` | POST | Agent SSE 流式对话 |
| `/api/conversations` | GET/POST | 会话列表/创建 |
| `/api/conversations/<id>/messages` | GET | 历史消息 |

---

## 边端调度决策

Atlas 上的 `compute_scheduling_decision()` 按优先级评估 6 条规则：

```
1. --force-cloud → 强制上云分析
2. 检测到 0 目标 → 本地完成
3. 检测到行人 → 上云（场景理解 + 风险评估）
4. 检测到车辆 → 上云（交通场景分析）
5. 平均置信度 < 0.7 → 上云（需大模型复核）
6. Atlas 负载过高 (loadavg 1m > 阈值) → 卸载至云端
7. 默认 → 本地完成
```

通过 `--load-threshold` 参数可调整负载阈值（Atlas 空闲负载约 17，建议设为 20+）。

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 边端 | Python 3.9, OpenCV, YOLOv5 OM (ACL), 零外部依赖客户端 |
| 云端 | Python 3.11, Flask, LangChain, SQLite, FAISS, paramiko |
| 前端 | Vue 3 (ES module), EventSource (SSE), native CSS modules |
| 多模态 | SenseNova 6.7 Flash-Lite (OpenAI-compatible Vision API) |
| 通信 | HTTP/RESTful JSON, MJPEG, SSE |
| 部署 | Docker, docker-compose |

---

## 许可证

MIT
