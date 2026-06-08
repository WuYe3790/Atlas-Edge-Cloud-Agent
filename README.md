# Atlas Edge Cloud Agent

基于 Atlas 200I DK A2 昇腾开发板的边云协同智能体系统课程设计项目。

- **边端**：Atlas 运行 YOLOv5 OM 模型推理 + 多因子调度 + 离线重传
- **云端**：笔记本 Flask 服务 + LangChain Agent (DeepSeek) + 图片/视频多模态分析 (SenseNova) + 本地 RAG + SQLite
- **管理平台**：Vue 3 双模式界面（出行助手对话 + 边云协同监控）

```
Atlas 200I DK A2                         笔记本云端 (192.168.0.101:5000)
  ├─ YOLO OM 推理                          ├─ Flask API (16 个路由)
  ├─ 多因子调度决策                         ├─ LangChain Agent (DeepSeek V4 Pro)
  ├─ NPU/CPU/内存指标采集                    ├─ SenseNova 6.7 Flash-Lite 多模态视觉分析
  ├─ 离线重传队列 (pending_events/)          ├─ 本地 FAISS RAG 知识库 (4 个知识文件)
  └─ HTTP JSON 上传                         ├─ SQLite 持久化 (events/analysis/tasks/decisions)
                                             ├─ Vue 3 管理平台 (5 个 ES module 组件)
                                             └─ SSH 远程板端控制 (paramiko)
```

## 项目启动

```powershell
cd "C:\Users\BaoXinJie\Desktop\In NBU\计算机系统实习\atlas work"
C:\Users\BaoXinJie\anaconda3\python.exe app.py
```

访问地址：

- 本地：**http://127.0.0.1:5000**
- 局域网 (Atlas 访问)：**http://192.168.0.101:5000**

## 已完成功能

### 边端 (Atlas)

| 功能 | 说明 | 文件 |
|---|---|---|
| YOLOv5 OM 推理 | 加载 yolo.om 对图片/视频帧进行目标检测 | `edge/atlas_yolo_detect_and_upload.py` |
| 多因子调度 | 6 条优先级规则自动判断是否需要云端分析 | 同上 `compute_scheduling_decision()` |
| 摄像头实时流 | `--camera 0` / `--camera rtsp://...` 持续采集帧 | 同上 |
| NPU 指标采集 | 解析 `npu-smi info` 输出 (AI Core 利用率/温度/功耗/内存) | 同上 `collect_system_metrics()` |
| 离线重传队列 | 上传失败时指数退避重试 (2/4/8s)，彻底失败存入 `pending_events/` | 同上 + `edge/atlas_upload_client.py` |
| 持续心跳 | `--heartbeat --watch --interval 10` 定时上报设备状态 | `edge/atlas_upload_client.py` |
| 零外部依赖 | `atlas_upload_client.py` 只用 `urllib.request` (无 `requests` 依赖) | `edge/atlas_upload_client.py` |
| 视频抽帧 | 自适应帧数 (8-30)，纯顺序读取避免 ARM OpenCV seek 问题 | `edge/atlas_yolo_detect_and_upload.py` |

### 云端 API (Flask)

| 端点 | 方法 | 功能 |
|---|---|---|
| `/api/health` | GET | 服务健康检查 |
| `/api/edge/events` | POST | 接收检测事件 (图片/视频帧) |
| `/api/edge/heartbeat` | POST | 设备心跳上报 (系统指标 + NPU + 待重传计数) |
| `/api/edge/tasks` | GET | 最近任务列表 |
| `/api/edge/tasks/<id>` | GET | 任务详情 |
| `/api/edge/tasks/<id>/report` | GET | Markdown 报告导出 |
| `/api/edge/tasks/<id>/report/html` | GET | HTML 可打印报告导出 |
| `/api/edge/status` | GET | 设备在线状态 + 性能指标 |
| `/api/edge/artifacts/<file>` | GET | 标注图/视频帧访问 |
| `/api/edge/analyze` | POST | 触发云端分析 (text/vision/both 三种模式) |
| `/api/edge/analyze/video` | POST | 视频级多帧聚合分析 |
| `/api/edge/scheduling/validate` | POST | 服务端调度决策验证 |
| `/api/edge/control` | POST | SSH 远程控制开发板 (心跳/YOLO/停止) |
| `/api/edge/board-files` | GET | SSH 扫描开发板上媒体文件列表 |
| `/api/edge/upload` | POST | 本地文件 SFTP 上传到开发板 |
| `/api/edge/ssh-connect` | POST | SSH 连接测试 |
| `/api/edge/yolo-status` | GET | YOLO 推理状态查询 |

### 智能体分析

| 路径 | 模型 | 输入 | 说明 |
|---|---|---|---|
| 文本分析 | DeepSeek V4 Pro | YOLO 检测 JSON 标签 | LangChain Agent 语义推理 |
| 图片分析 | SenseNova 6.7 Flash-Lite | 单张 YOLO 标注图 (base64) | 多模态看图理解 |
| 视频分析 | SenseNova 6.7 Flash-Lite | 多帧 YOLO 标注图 (base64) | 帧间时序关联 + 动态事件识别 |
| 双模型并行 | DeepSeek + SenseNova | 上述两者 | `mode=both` 时 ThreadPoolExecutor 并行 |

### 工具链 (18+ LangChain Tools)

| 类别 | 工具 | 数据源 |
|---|---|---|
| 天气 | `get_weather_info`, `get_air_quality_info`, `get_weather_alerts`, `get_weather_indices` | 和风天气 JWT |
| 交通 | `get_transport_advice`, `get_public_transit_plan`, `get_walking_route`, `get_bicycling_route`, `get_traffic_status` | 高德地图 |
| 航班 | `search_flight_options` | LetsFG / AviationStack |
| 火车票 | `search_train_tickets`, `search_interline_train_tickets`, `get_train_route` | 12306 MCP |
| 酒店 | `search_hotel_prices` | RapidAPI Booking.com → 降级高德 POI |
| 地点 | `search_travel_pois`, `search_nearby_pois`, `get_place_location` | 高德地图 |
| 知识 | `search_local_knowledge` | FAISS 向量检索 (4 个 .md 文件) |
| Skill | `city_transit_skill`, `intercity_transport_skill` | 组合编排上述工具 |
| ~~联网~~ | **尚未实现** → 见 `项目开发计划.md` 剩余任务 1 | DuckDuckGo (计划中) |

### 管理平台 (Vue 3)

- **双模式切换**：出行助手 (LangChain Agent 对话) / 边云协同 (设备监控 + 任务流)
- **设备状态面板**：CPU 负载/内存/NPU 利用率/NPU 大页内存进度条 + SSH 连接状态
- **历史任务流**：可展开的任务卡片，含类型标签 (图片/视频)、三步管道 (推理→调度→分析)
- **任务详情弹窗**：标注图像点击放大、检测明细表、系统指标进度条、Agent 执行追踪面板
- **SSH 板端控制面板**：启动/停止心跳、单次心跳上报、远程运行 YOLO
- **YOLO 远程推理**：从 Dashboard 选择板端文件或自定义路径，SSH 远程触发 YOLO
- **输入联想**：智能关键词提取（分隔符/触发字/忽略前缀）+ 高德输入提示 API + 收起/展开
- **强制云端大模型开关**：控制是否使用 SenseNova 多模态分析
- **4 秒自动轮询**边端状态

## 项目文件结构

```
atlas work/
├── app.py                              # Flask 启动入口
├── requirements.txt                    # Python 依赖
├── Dockerfile / docker-compose.yml     # Docker 容器化
├── .env / .env.example                 # API Key 配置
├── 项目开发计划.md                      # 后续开发计划
│
├── server/                             # Flask 服务层
│   ├── __init__.py                     # 蓝图注册
│   ├── edge_routes.py                  # ★ 边云通信核心 (1866 行, 16 路由)
│   ├── vision_analyzer.py              # ★ SenseNova 多模态分析模块
│   ├── chat_routes.py                  # Agent SSE 流式对话
│   ├── core_routes.py                  # 健康检查 / 状态 / 图片代理
│   ├── conversation_routes.py          # 会话 CRUD
│   ├── amap_routes.py                  # 高德地图前端接口
│   ├── amap_client.py / context.py / bootstrap.py
│
├── edge/                               # Atlas 边端脚本
│   ├── atlas_yolo_detect_and_upload.py # YOLO + 摄像头 + NPU + 上传
│   └── atlas_upload_client.py          # 手工上传 + watch 心跳
│
├── src/travel_agent/                   # LangChain 智能体
│   ├── agent.py                        # Agent 构建 + 流式 + trace
│   ├── config.py                       # LLMConfig (DeepSeek 配置)
│   ├── prompts.py                      # System Prompt
│   ├── tools.py                        # 18+ 工具注册
│   ├── skills.py                       # Skill 编排
│   ├── storage.py                      # ★ SQLite 持久化 (4 表)
│   ├── trace.py / structured.py
│   ├── tool_rag.py                     # FAISS RAG 知识库
│   ├── train_tools.py                  # 12306 MCP 火车票 (60s 冷却期重试)
│   └── tool_*.py                       # 天气/交通/POI/酒店/航班
│
├── static/                             # Vue 3 前端 (重构后)
│   ├── app.js                          # ★ Vue 3 入口 (setup() 状态管理, 1013 行)
│   ├── travel_helpers.js               # 基础工具/POI/markdown/酒店 (640 行)
│   ├── map_helpers.js                  # 高德交互式地图 (283 行)
│   ├── chat_helpers.js                 # 聊天/SSE/Trace 渲染 (440 行)
│   ├── cards_helpers.js                # 结构化卡片渲染 (732 行)
│   ├── components/
│   │   ├── SidebarComponent.js         # 侧栏 + SSH 控制面板 (364 行)
│   │   ├── EdgeMonitor.js              # 边云任务流展示 (520 行)
│   │   ├── TaskModal.js                # 任务详情弹窗 (322 行)
│   │   └── TravelAssistant.js          # 出行对话面板 (236 行)
│   └── styles/
│       ├── base.css                    # 变量/重置/基础布局 (526 行)
│       ├── chat.css                    # 聊天面板 (786 行)
│       ├── cards.css                   # 结构化卡片 (1324 行)
│       └── edge.css                    # 边云 Dashboard (2014 行)
│
├── templates/index.html                # Vue 3 挂载点
│
├── data/                               # 运行时数据 (gitignore)
│   ├── travel_agent.db                 # SQLite
│   ├── edge_artifacts/                 # 标注图存储
│   └── uploads/                        # 文件上传缓存
│
├── knowledge/                          # RAG 知识库 (Markdown)
│   ├── edge_cloud.md                   # 边云协同知识
│   ├── agent_architecture.md           # Agent 架构说明
│   ├── travel_tips.md                  # 旅游出行建议
│   ├── history_insights.md             # 历史城市经验
│   └── cities/*.md                     # 城市专题知识
│
├── atlas_ref/                          # 开发板参考代码 (gitignore, 612MB)
│   ├── samples/notebooks/              # 9 个 Jupyter notebook 示例
│   ├── samples/model-adapter-models/   # ACL 推理流水线
│   └── board_root/                     # 开发板配置文件
│
├── scripts/validate_edge_cloud.py      # 后端集成测试
│
└── docs/                               # 设计文档
    ├── design.md / api.md / demo.md
    └── plan_vision_multimodal.md
```

## 已知问题

### 功能缺口（详见 `项目开发计划.md`）

1. **Agent 缺少联网搜索工具** — 课程要求 3.2，当前仅限于领域 API，需新增 DuckDuckGo 搜索
2. **缺少实时视频流预览** — 课程要求 3.4，当前只能看静态帧，需 Dashboard 展示实时帧
3. **断网重连未主动恢复** — 课程要求稳定性，当前有离线队列但缺恢复后自动清理逻辑

### 技术债务

4. **`requirements.txt` 不完整** — 缺少 `paramiko`、`duckduckgo-search`（待添加）等
5. **Docker 未验证** — `Dockerfile` 和 `docker-compose.yml` 已写但未在真机测试构建
6. **无摄像头硬件** — `--camera` 功能已实现但未在真实 USB 摄像头/RTSP 流上测试
7. **调度负载阈值需要 Atlas 实测校准** — 默认 `loadavg 1m > 2.0`，Atlas 空闲约 17，需用 `--load-threshold 20`

## 重要提醒

- `.env` 中有真实 API Key，**绝对不能提交 git**
- 开发板 IP `192.168.0.2`，SSH 用户 `root`，密码 `Mind@123`
- `data/travel_agent.db` 中有历史任务数据，调试时可以删除重建
- `atlas_ref/` 目录有开发板上拷贝的全部参考代码 (yolo.om/det_utils.py/Jupyter notebooks)
- `paramiko` 未在 `requirements.txt` 但项目依赖它
- Windows Anaconda `python` 路径为 `C:\Users\BaoXinJie\anaconda3\python.exe`
