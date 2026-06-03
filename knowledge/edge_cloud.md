# Atlas 200I DK A2 边云协同系统

## 系统架构概述

本系统是一套基于华为 Atlas 200I DK A2 开发板的边云协同智能体平台。整体架构分为三层：

- 边端层：Atlas 开发板负责图像采集、YOLOv5 目标检测推理、数量统计和本地决策
- 通信层：HTTP RESTful JSON API 进行边云双向通信
- 云端层：笔记本运行 Flask Web 服务 + LangChain 智能体 + SQLite 持久化 + RAG 知识库

## 边端硬件与推理

Atlas 200I DK A2 是华为昇腾 AI 处理器开发板，使用 Ascend 310P AI 处理器。

核心推理流程：
1. 加载 yolo.om（已转换为昇腾 OM 格式的 YOLOv5 模型）
2. 使用 ais_bench 推理接口进行前向计算
3. 对输出进行 NMS（非极大值抑制）后处理
4. 在原始图像上绘制检测框，生成标注图
5. 统计检测结果：总目标数、人数、车辆数、各类别计数
6. 采集系统指标：CPU 负载（/proc/loadavg）、内存占用（/proc/meminfo）、运行时间（/proc/uptime）

实测性能：约 60ms 推理延迟，16-20 FPS（基于 world_cup.jpg 测试）。

## 边云调度策略

系统采用多因子调度算法，自动判断边端任务是否需要上传云端进行深度分析：

### 调度规则（按优先级排列）

1. 强制上云（--force-cloud）：用户手动指定时始终上传
2. 检测到人（person_count > 0）：触发云端场景理解与风险评估
3. 检测到车辆（vehicle_count >= 1）：触发云端交通场景分析
4. 平均置信度低于 0.7：需要云端复核检测结果
5. 边端系统负载过高（loadavg 1m > 2.0）：卸载计算任务至云端
6. 默认本地处理：少量目标且置信度充足时，边端本地完成即可

### 调度决策字段

每个检测事件都包含 edge_decision 对象：
- handled_locally：边端是否完成了本地处理
- need_cloud_analysis：是否需要云端分析
- reason：人类可读的决策原因

## 云端服务架构

云端运行在笔记本电脑上，通过 Flask 提供以下服务：

### API 接口

- GET /api/health：服务健康检查
- POST /api/edge/events：接收边端检测事件
- POST /api/edge/heartbeat：设备心跳上报
- GET /api/edge/tasks：查询边端任务列表
- GET /api/edge/tasks/<id>：查询单个任务详情
- GET /api/edge/tasks/<id>/report：导出 Markdown 任务报告
- GET /api/edge/status：查询设备在线状态
- GET /api/edge/artifacts/<file>：访问标注图像
- POST /api/edge/analyze：触发 LLM Agent 语义分析
- POST /api/edge/scheduling/validate：验证调度决策

### LangChain 智能体

云端使用 LangChain 框架构建智能体，通过 OpenAI-compatible API 调用大语言模型。智能体拥有超过 20 个工具，涵盖天气查询、交通规划、POI 搜索、酒店查询、航班查询、火车票查询、RAG 知识检索等能力。

对于边端检测事件，Agent 会：
1. 分析检测结果的场景含义
2. 评估风险等级
3. 给出处理建议
4. 输出适合管理平台展示的结构化内容

### 数据持久化

使用 SQLite 数据库（data/travel_agent.db）存储：
- conversations 表：对话会话
- messages 表：对话消息
- edge_tasks 表：边端任务记录（含检测事件和云端分析结果）
- edge_devices 表：设备状态信息

设备在线状态判断：updated_at 距当前时间 5 分钟内视为在线。

## 断网重传机制

当 Atlas 无法连接云端时：
1. 上传请求会自动重试 3 次（指数退避：2s、4s、8s）
2. 重试全部失败后，事件 JSON 保存到 pending_events/ 目录
3. 使用 --retry-pending 命令批量重传所有待处理事件
4. 重传成功后自动删除对应的 pending 文件

## 部署方式

### 本地运行

在笔记本上启动云端服务：
```powershell
cd "C:\Users\BaoXinJie\Desktop\In NBU\计算机系统实习\atlas work"
python app.py
```

服务监听 0.0.0.0:5000，可通过 http://192.168.0.101:5000 被 Atlas 访问。

### Docker 部署

使用 docker-compose.yml 一键部署：
```powershell
docker compose up --build
```

容器配置：Python 3.11-slim 基础镜像，端口 5000 映射，data 目录卷挂载。

### Atlas 边端部署

边端脚本位于：
```
/home/HwHiAiUser/samples/notebooks/01-yolov5/atlas_yolo_detect_and_upload.py
```

通过 SCP 上传到 Atlas 开发板后，运行 YOLO 检测并上传：
```bash
python3 atlas_yolo_detect_and_upload.py \
  --image world_cup.jpg \
  --model yolo.om \
  --labels coco_names.txt \
  --server http://192.168.0.101:5000 \
  --upload
```

## 管理平台功能

Web 管理平台（http://192.168.0.101:5000）提供：

- 智能旅游规划对话界面（LangChain Agent）
- Atlas 设备状态监控（在线/离线、FPS、延迟、内存、负载）
- 边端任务列表（标注图缩略图、检测摘要、三段流程展示）
- 任务详情弹窗（完整检测表、系统指标、分析结果、Agent 追踪链）
- 云端分析触发按钮
- Markdown 报告导出

## 课程相关

本项目是"计算机系统综合实习"课程的设计成果，实现了以下核心要求：

- 边端数据采集：通过 YOLO 推理对静态图像进行目标检测
- 简单任务边端处理：检测框生成、类别统计、数量摘要、性能指标采集
- 复杂任务云端处理：LLM Agent 场景理解、风险评估、语义分析
- 边云通信：HTTP JSON 协议
- 管理平台：Web Dashboard
- 智能体对话：LangChain Agent
- 本地知识库：FAISS RAG
- Docker 交付：docker-compose.yml

注意：由于无摄像头设备，当前采用静态图片作为数据采集替代方案。报告中需明确说明这是合理的技术替代。
