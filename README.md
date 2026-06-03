# Atlas Edge Cloud Agent

This project is a course-design edge-cloud collaboration system for Atlas 200I DK A2.

It uses the Atlas board as the edge node for YOLO object detection, and uses a laptop as the local cloud node for LLM agent analysis, RAG, tool calls, task logging, and the management dashboard.

## Architecture

```text
Atlas 200I DK A2
  - Runs YOLO on local images with yolo.om
  - Produces detections.json, summary.json, annotated.jpg
  - Handles simple edge tasks locally
  - Uploads complex events to laptop cloud service

Laptop cloud service
  - Flask web backend
  - LangChain/OpenAI-compatible LLM agent
  - Local RAG knowledge base
  - Maps, weather, transport and POI tools
  - Edge task API and SQLite task log
  - Management dashboard
```

The Atlas board does not need direct Internet access. It only needs to reach the laptop service, for example:

```text
Atlas -> http://192.168.0.101:5000
Laptop -> LLM/search/maps/weather APIs
```

## Current Capabilities

- Edge-cloud health check: `GET /api/health`
- Atlas event upload: `POST /api/edge/events`
- Edge task list: `GET /api/edge/tasks`
- Edge task detail: `GET /api/edge/tasks/<task_id>`
- Cloud agent analysis: `POST /api/edge/analyze`
- Atlas YOLO image detection and upload script
- Existing travel-planning agent retained as the cloud LLM agent foundation
- Management dashboard with edge task list
- Docker deployment for the laptop cloud service

## Local Setup

Recommended Python interpreter:

```powershell
C:\Users\BaoXinJie\anaconda3\python.exe
```

Install dependencies:

```powershell
C:\Users\BaoXinJie\anaconda3\python.exe -m pip install -r requirements.txt
```

The real `.env` file is intentionally ignored by Git. It should contain the existing API keys copied from the previous agent project.

Start the laptop cloud service:

```powershell
C:\Users\BaoXinJie\anaconda3\python.exe app.py
```

The service listens on all interfaces:

```text
http://127.0.0.1:5000
http://192.168.0.101:5000
```

Health check:

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:5000/api/health"
```

## Docker Deployment

Build and run the laptop cloud service:

```powershell
docker compose up --build
```

The container reads `.env` from the project root and exposes:

```text
http://127.0.0.1:5000
```

If Atlas needs to access the Docker service, use the laptop IP reachable by Atlas:

```text
http://192.168.0.101:5000
```

## Atlas Network Requirement

Minimum requirement:

```bash
ping 192.168.0.101
curl http://192.168.0.101:5000/api/health
```

The board does not need to ping public Internet addresses if the laptop can call cloud APIs.

Send a heartbeat without running YOLO:

```bash
python3 /home/HwHiAiUser/atlas_upload_client.py \
  --server http://192.168.0.101:5000 \
  --heartbeat
```

## Upload Scripts To Atlas

Upload the generic event client:

```powershell
scp "C:\Users\BaoXinJie\Desktop\In NBU\计算机系统实习\atlas work\edge\atlas_upload_client.py" root@192.168.0.2:/home/HwHiAiUser/atlas_upload_client.py
```

Upload the YOLO detection client:

```powershell
scp "C:\Users\BaoXinJie\Desktop\In NBU\计算机系统实习\atlas work\edge\atlas_yolo_detect_and_upload.py" root@192.168.0.2:/home/HwHiAiUser/samples/notebooks/01-yolov5/atlas_yolo_detect_and_upload.py
```

## Atlas YOLO Demo

On Atlas:

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

Expected outputs:

```text
detections.json
summary.json
annotated.jpg
```

The upload event also includes the annotated image. The laptop dashboard stores it under `data/edge_artifacts/` and displays it in the edge task card.

Example real result:

```text
image: world_cup.jpg
model: yolo.om
latency_ms: 60.46
fps: 16.54
detections: 2 person, 1 sports_ball
```

The script triggers cloud agent analysis by default after upload. To upload without analysis, add `--no-analyze`.

Run with explicit cloud analysis:

```bash
python3 atlas_yolo_detect_and_upload.py \
  --image world_cup.jpg \
  --model yolo.om \
  --labels coco_names.txt \
  --server http://192.168.0.101:5000 \
  --upload \
  --force-cloud \
  --analyze
```

## Manual Event Upload

Create a mock detection result on Atlas:

```bash
cat > detections.json << 'EOF'
[
  {
    "class_name": "person",
    "confidence": 0.92,
    "bbox": [120, 80, 260, 420]
  },
  {
    "class_name": "car",
    "confidence": 0.87,
    "bbox": [300, 180, 520, 360]
  }
]
EOF
```

Upload it:

```bash
python3 /home/HwHiAiUser/atlas_upload_client.py \
  --server http://192.168.0.101:5000 \
  --image test.jpg \
  --detections-json detections.json \
  --force-cloud
```

## API Summary

### `GET /api/health`

Returns service availability.

### `POST /api/edge/events`

Receives Atlas detection events.

### `GET /api/edge/tasks`

Lists recent edge tasks.

### `GET /api/edge/status`

Lists Atlas devices and online/resource status.

### `GET /api/edge/tasks/<task_id>/report`

Exports one task as a Markdown report for course documentation.

### `POST /api/edge/analyze`

Runs cloud LLM agent analysis for an edge task.

Request:

```json
{
  "task_id": "edge-ce8db59bb6fd433db83665d51fae8943"
}
```

## Course Requirement Mapping

| Requirement | Implementation |
| --- | --- |
| Edge YOLO detection | Atlas runs `yolo.om` with `atlas_yolo_detect_and_upload.py` |
| Simple edge task | Atlas computes class counts, latency and local decision |
| Complex cloud task | Laptop cloud agent analyzes uploaded YOLO event |
| Edge-cloud communication | HTTP/RESTful JSON API |
| LLM integration | Cloud service uses OpenAI-compatible model API |
| RAG knowledge base | Markdown knowledge files and FAISS local retrieval |
| Management platform | Flask web dashboard |
| Docker support | `Dockerfile` and `docker-compose.yml` |
| Stability | Edge upload client can save local JSON and retry manually |

## Repository Safety

Ignored files:

- `.env`
- SQLite database files in `data/`
- runtime logs
- local planning documents
- course requirement document

Do not commit real API keys.

## Documentation

- `docs/design.md`: system architecture and module design.
- `docs/api.md`: cloud service API documentation.
- `docs/demo.md`: demo script and presentation flow.
- `docs/handoff.md`: project handoff notes for the next maintainer or AI agent.
