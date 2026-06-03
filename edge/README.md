# Atlas Edge Client

This directory contains the lightweight client used on Atlas 200I DK A2.

The current client does not assume a fixed YOLO implementation. After the board-side `01-yolov5` sample is confirmed, export its detections as JSON and upload them with `atlas_upload_client.py`.

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

## 4. Later YOLO Integration Point

After opening the board sample:

```bash
cd /home/HwHiAiUser/samples/notebooks/01-yolov5
ls -lah
find . -maxdepth 2 -type f
```

The target integration is:

```text
image file -> Atlas YOLO sample -> detections.json -> atlas_upload_client.py -> laptop cloud service
```
