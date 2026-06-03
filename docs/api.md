# API 文档

## GET `/api/health`

检查云端服务是否可用。

响应：

```json
{
  "ok": true,
  "service": "atlas-edge-cloud-agent",
  "time": "2026-06-03T09:12:28Z"
}
```

## POST `/api/edge/events`

接收 Atlas YOLO 检测事件。

请求核心字段：

```json
{
  "device_id": "atlas-200i-dk-a2-01",
  "hostname": "davinci-mini",
  "image_id": "world_cup.jpg",
  "inference": {
    "model": "yolo.om",
    "latency_ms": 60.46,
    "fps": 16.54
  },
  "detections": [
    {
      "class_id": 0,
      "class_name": "person",
      "confidence": 0.8385,
      "bbox": [288.05, 16.75, 632.09, 282.85]
    }
  ],
  "summary": {
    "total_count": 3,
    "class_counts": {
      "person": 2,
      "sports_ball": 1
    }
  },
  "system_metrics": {
    "memory": {
      "used_percent": 42.1
    }
  },
  "edge_decision": {
    "handled_locally": true,
    "need_cloud_analysis": true,
    "reason": "YOLO detected targets; cloud semantic analysis requested."
  }
}
```

响应：

```json
{
  "ok": true,
  "task_id": "edge-xxx",
  "cloud_analysis_required": true,
  "message": "Edge event received."
}
```

## GET `/api/edge/tasks`

查询最近边端任务。

参数：

```text
limit: 默认 30，最大 100
```

## GET `/api/edge/tasks/<task_id>`

查询单个边端任务详情。

## GET `/api/edge/status`

查询设备状态汇总。

响应字段：

```json
{
  "ok": true,
  "devices": [
    {
      "device_id": "atlas-200i-dk-a2-01",
      "hostname": "davinci-mini",
      "online": true,
      "age_seconds": 12.0,
      "latest_fps": 16.54,
      "latest_latency_ms": 60.46,
      "system_metrics": {}
    }
  ]
}
```

## POST `/api/edge/heartbeat`

Updates Atlas online status without running YOLO.

Request:

```json
{
  "device_id": "atlas-200i-dk-a2-01",
  "hostname": "davinci-mini",
  "system_metrics": {
    "memory": {
      "used_percent": 35.7
    }
  },
  "note": "manual heartbeat"
}
```

## POST `/api/edge/analyze`

触发云端 Agent 对边端任务进行语义分析。

请求：

```json
{
  "task_id": "edge-xxx",
  "thinking_mode": true
}
```

响应包含：

- `analysis.answer`
- `analysis.trace`
- `analysis.structured_data`

## GET `/api/edge/artifacts/<filename>`

访问边端上传的标注图。

## GET `/api/edge/tasks/<task_id>/report`

导出单个边云任务的 Markdown 报告。

## GET `/api/edge/tasks/<task_id>/report/html`

导出单个边云任务的 HTML 报告页面。

## POST `/api/edge/scheduling/validate`

验证边云调度决策是否符合当前规则。

请求：

```json
{
  "summary": {
    "total_count": 1,
    "class_counts": {
      "person": 1
    },
    "person_count": 1,
    "vehicle_count": 0
  },
  "detections": [
    {
      "class_name": "person",
      "confidence": 0.91
    }
  ],
  "system_metrics": {},
  "force_cloud": false
}
```

响应：

```json
{
  "ok": true,
  "decision": {
    "handled_locally": false,
    "need_cloud_analysis": true,
    "reason": "检测到 1 人，触发云端场景理解与风险评估。"
  }
}
```

## 本地验证脚本

```powershell
C:\Users\BaoXinJie\anaconda3\python.exe scripts\validate_edge_cloud.py
C:\Users\BaoXinJie\anaconda3\python.exe scripts\validate_edge_cloud.py --server http://192.168.0.101:5000
```
