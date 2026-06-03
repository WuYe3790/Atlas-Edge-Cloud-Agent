# 系统设计说明

## 1. 设计目标

本系统实现一套 Atlas 200I DK A2 边云协同智能体平台。边端负责图像输入、YOLO 推理、简单目标统计和本地决策；云端负责复杂语义分析、工具调用、知识库检索、任务日志和可视化管理。

## 2. 架构

```text
Atlas Edge
  - 读取本地图像
  - 加载 yolo.om
  - YOLO 推理和 NMS 后处理
  - 生成 detections.json / summary.json / annotated.jpg
  - 上传 JSON 与标注图

HTTP/RESTful JSON

Laptop Cloud
  - Flask API
  - SQLite 任务日志
  - LangChain Agent
  - OpenAI-compatible LLM API
  - RAG 知识库
  - 管理平台
```

## 3. 边端模块

边端脚本位于 `edge/atlas_yolo_detect_and_upload.py`，实际运行位置为：

```text
/home/HwHiAiUser/samples/notebooks/01-yolov5/atlas_yolo_detect_and_upload.py
```

边端完成：

- 图片读取；
- `yolo.om` 模型加载；
- 目标检测；
- 检测框绘制；
- 数量摘要；
- FPS/延迟统计；
- CPU 负载、内存占用等系统指标采集；
- 检测事件上传；
- 默认触发云端 Agent 分析。

## 4. 云端模块

云端运行在笔记本电脑，服务入口为：

```text
http://192.168.0.101:5000
```

云端完成：

- 接收边端事件；
- 保存任务日志；
- 保存边端标注图；
- 汇总设备状态；
- 调用 LLM Agent 生成场景分析；
- 在管理平台展示边云协同过程。

## 5. 调度逻辑

当前调度策略：

```text
YOLO 检测目标数 > 0 或 --force-cloud
  -> 标记 need_cloud_analysis = true
  -> 上传云端
  -> 触发 Agent 分析
```

可扩展策略：

- 多人检测触发云端分析；
- 人车同框触发风险分析；
- 低置信度检测触发复核；
- 特定类别触发告警；
- 网络中断时本地保存 JSON 后重传。

## 6. 管理平台

管理平台展示：

- LLM/API 配置状态；
- Atlas 设备在线状态；
- 最近 FPS/延迟；
- 内存与负载；
- YOLO 标注图；
- 检测类别统计；
- 边端、调度、云端三段流程；
- Agent 分析摘要。

## 7. 部署

本地运行：

```powershell
C:\Users\BaoXinJie\anaconda3\python.exe app.py
```

Docker 运行：

```powershell
docker compose up --build
```

## 8. 已验证结果

真实 Atlas 测试：

```text
image: world_cup.jpg
model: yolo.om
latency_ms: 60.46
fps: 16.54
detections: 2 person, 1 sports_ball
upload: success
cloud task id: edge-ce8db59bb6fd433db83665d51fae8943
```
