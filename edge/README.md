# Atlas Edge Client

This directory contains the lightweight clients used on Atlas 200I DK A2.

- `atlas_upload_client.py`: uploads an existing detection JSON.
- `atlas_yolo_detect_and_upload.py`: runs the board-side YOLO OM model, writes JSON/images, and uploads the result.

## 1. Check Laptop Cloud Service

Replace the IP with the laptop address reachable from Atlas.

```bash
python3 atlas_upload_client.py --server http://192.168.0.101:5000 --health
```

Expected result:

```json
{
  "ok": true,
  "service": "atlas-edge-cloud-agent"
}
```

## 1.1 Keep Device Online In The Dashboard

The dashboard marks a device online only when the laptop cloud service has received a recent heartbeat or task upload. Start a continuous heartbeat on Atlas:

```bash
cd /home/HwHiAiUser
python3 atlas_upload_client.py \
  --server http://192.168.0.101:5000 \
  --heartbeat \
  --watch \
  --interval 30
```

Run it in the background:

```bash
cd /home/HwHiAiUser
nohup python3 atlas_upload_client.py \
  --server http://192.168.0.101:5000 \
  --heartbeat \
  --watch \
  --interval 30 \
  > atlas_heartbeat.log 2>&1 &
```

Stop the background heartbeat:

```bash
pkill -f "atlas_upload_client.py.*--heartbeat"
```

## 2. Upload A Manual Detection Result

Create `detections.json` on Atlas:

```json
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
```

Upload it:

```bash
python3 atlas_upload_client.py \
  --server http://192.168.0.101:5000 \
  --image test.jpg \
  --detections-json detections.json \
  --force-cloud
```

## 3. Upload And Trigger Agent Analysis

```bash
python3 atlas_upload_client.py \
  --server http://192.168.0.101:5000 \
  --image test.jpg \
  --detections-json detections.json \
  --force-cloud \
  --analyze
```

## 4. Run Real Atlas YOLO Detection

Copy `atlas_yolo_detect_and_upload.py` to the YOLO sample directory:

```powershell
scp "C:\Users\BaoXinJie\Desktop\In NBU\计算机系统实习\atlas work\edge\atlas_yolo_detect_and_upload.py" root@192.168.0.2:/home/HwHiAiUser/samples/notebooks/01-yolov5/atlas_yolo_detect_and_upload.py
```

Run on Atlas:

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

Generated files:

```text
detections.json
summary.json
annotated.jpg
```

Known real test result:

```text
world_cup.jpg -> 2 person, 1 sports_ball
latency_ms: 60.46
fps: 16.54
```

Add `--analyze` to trigger cloud LLM agent analysis immediately.

Current behavior: upload triggers cloud analysis by default. Add `--no-analyze` when you only want to store the edge event.

## 5. Calibrate Edge Load Scheduling

The default cloud offload threshold is `loadavg 1m > 2.0`. On Atlas, the load average may be much higher than a laptop even when the board is usable. If normal single-image inference is always classified as high load, raise the threshold during the run:

```bash
python3 atlas_yolo_detect_and_upload.py \
  --image world_cup.jpg \
  --model yolo.om \
  --labels coco_names.txt \
  --server http://192.168.0.101:5000 \
  --upload \
  --load-threshold 20
```

The same option is available in the manual upload client:

```bash
python3 atlas_upload_client.py \
  --server http://192.168.0.101:5000 \
  --image test.jpg \
  --detections-json detections.json \
  --load-threshold 20 \
  --analyze
```
