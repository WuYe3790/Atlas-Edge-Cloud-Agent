# Atlas Edge Cloud Agent

基于 Atlas 200I DK A2 昇腾开发板的边云协同智能体系统课程设计项目。

- **边端**：Atlas 运行 YOLOv5 OM 模型推理 + 多因子调度 + 离线重传
- **云端**：笔记本 Flask 服务 + LangChain Agent (DeepSeek) + 图片/视频多模态分析 (SenseNova) + RAG + SQLite
- **管理平台**：Vue 3 双模式界面（出行助手对话 + 边云协同监控）

```
Atlas 200I DK A2                         笔记本云端 (192.168.0.101:5000)
  ├─ YOLO OM 推理                          ├─ Flask API (16 个路由)
  ├─ 多因子调度决策                         ├─ LangChain Agent (DeepSeek)
  ├─ NPU/CPU/内存指标采集                    ├─ SenseNova 多模态视觉分析
  ├─ 离线重传队列 (pending_events/)          ├─ 本地 FAISS RAG 知识库
  └─ HTTP JSON 上传                         ├─ SQLite 持久化 (4 张表)
                                             ├─ Vue 3 管理平台
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

### 管理平台 (Vue 3)

- **双模式切换**：出行助手 (LangChain Agent 对话) / 边云协同 (设备监控 + 任务流)
- **设备状态面板**：CPU 负载/内存/NPU 利用率/NPU 大页内存进度条 + SSH 连接状态
- **历史任务流**：可展开的任务卡片，含类型标签 (图片/视频)、三步管道 (推理→调度→分析)、Agent 分析摘要卡片
- **任务详情弹窗**：标注图像点击放大、检测明细表、系统指标进度条、Agent 执行追踪面板
- **SSH 板端控制面板**：启动/停止心跳、单次心跳上报
- **文件选择弹窗**：扫描开发板媒体文件列表 + 自定义路径 + 上传本地文件
- **滑出式终端抽屉**：实时显示 SSH 操作日志
- **强制云端大模型开关**：开关控制是否使用 SenseNova 多模态分析
- **4 秒自动轮询**边端状态

## 已知问题

### 高优先级

1. **SenseNova 参与痕迹不可见**
   - 后端 `vision_analyzer.py` 确实调用了 SenseNova API 并返回了完整分析结果
   - 数据库 `analysis.vision_analysis.answer` 中有 SenseNova 的真实输出
   - trace 数组中有 `vision_analysis` 条目 (带 token 用量)
   - 但 **TaskModal 的 Agent Trace 面板未正确渲染 `vision_analysis` 类型条目**
   - 现象：任务详情弹窗的追踪面板只显示 DeepSeek 部分，看不到 SenseNova 的分析过程
   - 文件：`static/components/TaskModal.js` (trace 渲染区) 和前端 Unicode emoji 渲染问题

2. **视频分析抽帧可能全部相同**
   - ARM OpenCV 的 `cap.set(POS_FRAMES, N)` 对某些编码器不生效
   - 当前已改为纯顺序读取 (不 seek)，但需要实机验证
   - 文件：`server/edge_routes.py` `EXTRACTOR_SCRIPT_CONTENT`

3. **视频分析任务流卡在第三步**
   - `_process_media_inference` 中某处异常导致流程中断
   - 子帧标注图读取、base64 传输、或 SenseNova 调用可能失败
   - 文件：`server/edge_routes.py` `_process_media_inference()` + `_trigger_video_analysis()`

4. **视频子帧以独立 task 展示**
   - 视频帧的 YOLO 结果曾通过 `--upload` 创建独立 task，在前端展开多条记录
   - 最新代码已改为本地运行 + SSH 回读，但需验证子帧 task 是否仍出现在任务列表中
   - 文件：`server/edge_routes.py` 视频处理路径

### 中优先级

5. **Docker 未验证** — 本机无 Docker 环境，`Dockerfile` 和 `docker-compose.yml` 已写但未测试构建

6. **调度负载阈值需要 Atlas 实测校准** — 默认 `loadavg 1m > 2.0` 触发上云，Atlas 空闲负载约 17，需用 `--load-threshold 20` 或更高

7. **`atlas_ref/` 目录未提交 git** — 从开发板拷贝的 600MB 参考代码 (模型/notebook/源码) 已加入 `.gitignore`

8. **无摄像头硬件** — `--camera` 功能已实现但未在真实 USB 摄像头/RTSP 流上测试

### 低优先级

9. MQTT 通信替代 HTTP
10. 多设备管理 (多台 Atlas 同时接入)
11. 公网服务器部署
12. `requirements.txt` 缺少 `paramiko`

## 项目文件结构

```
atlas work/
├── app.py                          # Flask 启动入口
├── web.py                          # create_app() 工厂
├── requirements.txt
├── Dockerfile / docker-compose.yml
├── .env / .env.example
│
├── server/                         # Flask 服务层
│   ├── __init__.py                 # 蓝图注册
│   ├── edge_routes.py              # ★ 边云通信核心 (1900+ 行, 16 路由)
│   ├── vision_analyzer.py          # ★ SenseNova 多模态分析模块
│   ├── chat_routes.py              # Agent SSE 流式对话
│   ├── core_routes.py              # 健康检查 / 状态 / 图片代理
│   ├── conversation_routes.py      # 会话 CRUD
│   ├── amap_routes.py              # 高德地图前端接口
│   ├── amap_client.py / context.py / bootstrap.py
│
├── edge/                           # Atlas 边端脚本
│   ├── atlas_yolo_detect_and_upload.py  # YOLO + 摄像头 + NPU + 上传
│   └── atlas_upload_client.py      # 手工上传 + watch 心跳
│
├── src/travel_agent/               # LangChain 智能体
│   ├── agent.py                    # Agent 构建 + 流式 + trace
│   ├── config.py                   # LLMConfig (DeepSeek 配置)
│   ├── prompts.py                  # System Prompt
│   ├── tools.py                    # 20+ 工具注册
│   ├── skills.py                   # Skill 编排
│   ├── storage.py                  # ★ SQLite 持久化 (4 表)
│   ├── trace.py / structured.py
│   ├── tool_rag.py                 # FAISS RAG 知识库
│   ├── train_tools.py              # 12306 MCP 火车票
│   └── tool_*.py                   # 天气/交通/POI/酒店/航班
│
├── static/                         # Vue 3 前端
│   ├── app.js                      # ★ Vue 3 入口 (setup() 状态管理)
│   ├── components/
│   │   ├── SidebarComponent.js     # 侧栏 + SSH 控制面板
│   │   ├── EdgeMonitor.js          # 边云任务流展示
│   │   ├── TaskModal.js            # 任务详情弹窗
│   │   └── TravelAssistant.js      # 出行对话面板
│   ├── travel_helpers.js           # 地图/POI/酒店辅助
│   ├── map_helpers.js              # 高德交互式地图
│   └── styles.css                  # 样式表 (4000+ 行)
│
├── templates/index.html            # Vue 3 挂载点
│
├── data/                           # 运行时数据 (gitignore)
│   ├── travel_agent.db             # SQLite
│   ├── edge_artifacts/             # 标注图存储
│   └── uploads/                    # 文件上传缓存
│
├── knowledge/                      # RAG 知识库 (Markdown)
│   ├── edge_cloud.md               # 边云协同知识
│   ├── agent_architecture.md
│   ├── travel_tips.md
│   └── cities/*.md
│
├── atlas_ref/                      # 开发板参考代码 (gitignore, 612MB)
│   ├── samples/notebooks/          # 9 个 Jupyter notebook 示例
│   ├── samples/model-adapter-models/ # ACL 推理流水线
│   ├── board_root/                 # 开发板配置文件
│   ├── ascend_config/              # 昇腾工具链环境脚本
│   └── uploads/                    # 测试图片/视频/抽帧结果
│
├── scripts/validate_edge_cloud.py  # 后端集成测试
│
└── docs/                           # 文档 (gitignore)
    ├── design.md / api.md / demo.md
    └── handoff.md
```

## 对下一位接手 AI 的建议

### 第 0 步：验证当前状态

```powershell
cd "C:\Users\BaoXinJie\Desktop\In NBU\计算机系统实习\atlas work"
C:\Users\BaoXinJie\anaconda3\python.exe app.py
# 浏览器打开 http://127.0.0.1:5000
```

### 第 1 步：修复 SenseNova trace 可见性

这是最核心的未解决问题。根因已确定：

- `vision_analyzer.py` 的 `analyze_with_vision()` 和 `analyze_video_with_vision()` 都返回了带 `trace` 字段的结果
- `_trigger_video_analysis()` 和 `_trigger_image_analysis()` 将 vision trace 合并到了 `analysis.trace` 数组
- trace 条目类型为 `"vision_analysis"`，包含 `model` / `media_type` / `frame_count` / `usage` / `result` 字段
- 但 `TaskModal.js` 的 trace 渲染只处理了 `tool_call` 和默认 (`🤖`) 两种类型，未渲染 `vision_analysis`
- 最近的修改尝试用 Python 脚本修复了 `TaskModal.js`，但 **可能缩进或逻辑有问题**
- 建议：用浏览器 DevTools 检查任务详情的 `analysis.trace` 数组，确认 `vision_analysis` 条目存在，然后重写 trace 渲染逻辑

### 第 2 步：修复视频分析完整链路

在开发板上传一段测试视频，跟踪整个流程：

1. SSH 连接 → 上传 `extract_frames.py` → 执行抽帧
2. 逐帧 YOLO 推理 (不上传) → SSH 回读 `detections.json` / `summary.json`
3. SSH 回读标注图 base64 → 保存到 `data/edge_artifacts/`
4. 聚合帧数据到父任务 `event.frames[]`
5. 调用 `_trigger_video_analysis()` → SenseNova 多帧分析
6. 前端展示：只有一条视频任务卡片 → 展开显示帧缩略图网格 → 弹窗显示分析结果

关键文件：`server/edge_routes.py` `_process_media_inference()` 方法

### 第 3 步：其他可完善的功能

- 上传确认 UI 改用 Vue 组件 (当前仍是浏览器原生 `confirm()`)
- Docker 验证
- 对接 USB 摄像头/RTSP 流
- 报告导出增加视频帧缩略图

### 重要提醒

- `.env` 中有真实 API Key，**绝对不能提交 git**
- 开发板 IP `192.168.0.2`，SSH 用户 `root`，密码 `Mind@123`
- `data/travel_agent.db` 中有历史任务数据，调试时可以删除重建
- `atlas_ref/` 目录有开发板上拷贝的全部参考代码 (包括 yolo.om 模型、det_utils.py、各类 Jupyter notebook 等)
- 服务端日志所有 `print()` 输出都会写入 Flask 控制台，调试时注意查看
- `paramiko` 未在 `requirements.txt` 中但项目依赖它
