# 项目转接文档

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

当前采用“笔记本作为本地云端”的架构。Atlas 不需要直连外网，只要能访问笔记本：

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
```

核心代码：

```text
server/edge_routes.py
src/travel_agent/storage.py
```

### 2.5 管理平台

状态页已新增：

- Atlas 设备状态；
- 在线/离线；
- 最近任务；
- 最近 FPS/延迟；
- 内存与负载；
- YOLO 标注图；
- 检测摘要；
- 边端、调度、云端三段流程；
- 云端分析摘要；
- 云端分析按钮；
- 导出报告链接。

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

python3 atlas_yolo_detect_and_upload.py \
  --image world_cup.jpg \
  --model yolo.om \
  --labels coco_names.txt \
  --server http://192.168.0.101:5000 \
  --upload \
  --force-cloud
```

说明：现在脚本上传后默认触发云端 Agent 分析。如果只上传不分析，增加：

```bash
--no-analyze
```

## 4. 当前与大作业要求的对应状态

| 要求 | 当前状态 |
| --- | --- |
| 边端数据采集 | 已用静态图片上传/本地图像替代摄像头 |
| YOLO 边端检测 | 已在 Atlas 上真实运行 `yolo.om` |
| 简单任务边端处理 | 已生成检测框、类别统计、FPS、内存/负载 |
| 复杂任务云端处理 | 已将检测事件交给云端 Agent 分析 |
| 边云通信 | 已使用 HTTP/RESTful JSON 跑通 |
| 管理平台 | 已展示设备状态、任务、标注图、调度流程、分析摘要 |
| 智能体对话 | 旧 Agent 聊天能力保留 |
| 本地知识库 RAG | 旧知识库能力保留 |
| 联网搜索 | 旧 Agent 工具基础保留，边端分析未强制每次搜索 |
| Docker | 文件已写，未实机验证 |
| 断网重连 | 未完整实现自动队列，目前可本地保存 JSON 后手动重传 |
| Demo 文档 | 已有 `docs/demo.md` |
| API 文档 | 已有 `docs/api.md` |
| 系统设计文档 | 已有 `docs/design.md` |

## 5. 仍需继续完成的工作

### 高优先级

1. **完善报告/展示材料**
   - 生成正式课程设计报告；
   - 放入系统架构图；
   - 放入接口说明；
   - 放入 Atlas YOLO 推理截图；
   - 放入管理平台截图；
   - 放入 Demo 流程说明。

2. **让边云调度更像“自动决策”**
   - 目前 `--force-cloud` 常用于演示；
   - 建议增加规则：
     - `person_count >= 2` 自动上云；
     - `vehicle_count > 0` 自动上云；
     - `total_count == 0` 只本地保存；
     - 低 FPS/高负载时提示边端资源紧张。

3. **强化管理平台任务详情**
   - 当前任务卡片只显示摘要；
   - 可新增任务详情弹窗或详情页；
   - 展示完整 detections、summary、trace、Agent answer。

4. **Docker 验证**
   - 在装有 Docker 的机器上执行：
     ```powershell
     docker compose up --build
     ```
   - 验证 `.env`、端口映射、SQLite volume。

### 中优先级

1. **断网重连**
   - Atlas 上传失败时保存到本地 `pending_events/`；
   - 新增重传命令；
   - 管理平台展示最近重传状态。

2. **RAG 专项知识库**
   - 增加 `knowledge/edge_cloud.md`；
   - 写入边云协同、YOLO、Atlas、调度策略相关知识；
   - 让 Agent 分析边端任务时优先检索该知识。

3. **导出报告增强**
   - 当前 `/report` 导出 Markdown；
   - 可加入标注图链接；
   - 可加入工具调用 trace；
   - 可生成完整 HTML/PDF 报告。

### 低优先级

1. 摄像头实时流；
2. MQTT 通信；
3. 多设备管理；
4. NPU 资源指标采集；
5. 公网服务器部署。

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
   - 可解释为开发板运行环境负载指标，不一定等同于 CPU 占用百分比。

6. **无摄像头**
   - 当前采用静态图片作为数据采集替代方案；
   - 报告中需要明确说明这是无摄像头条件下的合理替代。

## 7. 下一位接手 AI 的建议路线

建议按以下顺序继续：

1. 先运行当前闭环，确认没有坏：
   ```bash
   curl http://192.168.0.101:5000/api/health
   ```
   ```bash
   cd /home/HwHiAiUser/samples/notebooks/01-yolov5
   python3 atlas_yolo_detect_and_upload.py --image world_cup.jpg --model yolo.om --labels coco_names.txt --server http://192.168.0.101:5000 --upload --force-cloud
   ```

2. 打开管理平台截图保存：
   ```text
   http://192.168.0.101:5000
   ```

3. 完善“自动调度规则”，减少对 `--force-cloud` 的依赖。

4. 写课程设计报告和 PPT/海报。

5. 如有 Docker 环境，验证 Docker 部署。

6. 若时间允许，增加断网重传队列。

## 8. 最近提交记录

```text
dd59cb3 Add heartbeat and task report export
881d0e2 Add device status monitoring and delivery docs
c5d2b58 Complete edge cloud analysis loop with artifacts
9d4deba Add Docker deployment and edge task dashboard docs
bfcdf51 Add Atlas YOLO detection upload client
909eabe Initial atlas edge cloud agent project
```
