# Demo 演示脚本

## 1. 启动云端服务

在笔记本：

```powershell
cd "C:\Users\BaoXinJie\Desktop\In NBU\计算机系统实习\atlas work"
C:\Users\BaoXinJie\anaconda3\python.exe app.py
```

浏览器打开：

```text
http://192.168.0.101:5000
```

## 2. 检查 Atlas 到云端连接

在 Atlas：

```bash
curl http://192.168.0.101:5000/api/health
```

预期：

```json
{"ok":true,"service":"atlas-edge-cloud-agent"}
```

## 3. 运行 YOLO 边端检测

```bash
cd /home/HwHiAiUser/samples/notebooks/01-yolov5

python3 atlas_yolo_detect_and_upload.py \
  --image world_cup.jpg \
  --model yolo.om \
  --labels coco_names.txt \
  --server http://192.168.0.101:5000 \
  --upload \
  --force-cloud
```

如果只需要保持设备在线，不运行 YOLO：

```bash
python3 /home/HwHiAiUser/atlas_upload_client.py \
  --server http://192.168.0.101:5000 \
  --heartbeat
```

说明：

- Atlas 本地运行 YOLO；
- 生成 `detections.json`；
- 生成 `summary.json`；
- 生成 `annotated.jpg`；
- 上传事件和标注图；
- 默认触发云端 Agent 分析。

## 4. 管理平台展示

在管理平台左侧状态页查看：

- Atlas 设备在线；
- 最近 FPS/延迟；
- 内存与负载；
- YOLO 标注图；
- 检测摘要；
- 边端/调度/云端流程；
- Agent 分析摘要。
- 导出报告按钮，可下载单次任务 Markdown 报告。

## 5. 讲解口径

本项目没有要求 Atlas 直接访问外网。Atlas 与笔记本云端服务在局域网中通信，笔记本作为 Cloud 节点负责大模型、搜索、RAG 和管理平台。

核心亮点：

- 简单检测任务在 Atlas 本地完成；
- 复杂语义分析交给云端 Agent；
- 管理平台展示完整边云协同调度过程；
- 静态图片替代摄像头，满足无摄像头条件下的数据采集要求；
- 真实 Atlas 推理 FPS 达到 16.54。
