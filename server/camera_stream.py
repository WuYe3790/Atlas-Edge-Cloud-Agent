"""
Laptop camera capture + MJPEG streaming + latest-frame cache.

Flask routes are registered on the edge blueprint via register_camera_routes().
"""
from __future__ import annotations

import threading
from datetime import datetime, timezone

import cv2
from flask import Response, jsonify


# ---------------------------------------------------------------------------
# Thread-safe camera state
# ---------------------------------------------------------------------------

_camera_lock = threading.Lock()
_camera_cap: cv2.VideoCapture | None = None
_camera_active: bool = False

_FRAME_WIDTH = 640
_FRAME_HEIGHT = 480
_JPEG_QUALITY = 80


# ---------------------------------------------------------------------------
# Latest annotated-frame cache (updated by edge event handler)
# ---------------------------------------------------------------------------

_frame_lock = threading.Lock()
_latest_frame_cache: dict = {
    "frame_url": "",
    "timestamp": "",
    "fps": 0,
    "detections_count": 0,
}


def update_latest_frame(
    frame_url: str = "",
    fps: float = 0,
    detections_count: int = 0,
) -> None:
    """Record the most recent YOLO-annotated frame for the live-preview card."""
    with _frame_lock:
        _latest_frame_cache["frame_url"] = frame_url
        _latest_frame_cache["fps"] = float(fps or 0)
        _latest_frame_cache["detections_count"] = int(detections_count or 0)
        _latest_frame_cache["timestamp"] = datetime.now(timezone.utc).isoformat()


def get_latest_frame() -> dict:
    """Return a shallow copy of the latest-frame cache."""
    with _frame_lock:
        return dict(_latest_frame_cache)


# ---------------------------------------------------------------------------
# Camera lifecycle
# ---------------------------------------------------------------------------

def _start_camera() -> None:
    global _camera_cap, _camera_active
    with _camera_lock:
        if _camera_active:
            return
        cap = cv2.VideoCapture(0)
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, _FRAME_WIDTH)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, _FRAME_HEIGHT)
        if not cap.isOpened():
            cap.release()
            raise RuntimeError("无法打开笔记本摄像头 (cv2.VideoCapture(0))")
        _camera_cap = cap
        _camera_active = True


def _stop_camera() -> None:
    global _camera_cap, _camera_active
    with _camera_lock:
        if _camera_cap is not None:
            _camera_cap.release()
            _camera_cap = None
        _camera_active = False


# Public API called from routes / frontend
start_laptop_camera = _start_camera
stop_laptop_camera = _stop_camera


def is_laptop_camera_active() -> bool:
    with _camera_lock:
        return _camera_active


def _generate_mjpeg():
    """Flask streaming generator: multipart/x-mixed-replace JPEG frames."""
    _start_camera()
    try:
        while True:
            with _camera_lock:
                if not _camera_active or _camera_cap is None:
                    break
                ok, frame = _camera_cap.read()
            if not ok:
                continue
            _, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, _JPEG_QUALITY])
            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n\r\n"
                + jpeg.tobytes()
                + b"\r\n"
            )
    except GeneratorExit:
        pass
    finally:
        _stop_camera()


# ---------------------------------------------------------------------------
# Flask routes (registered on edge_bp in register_camera_routes)
# ---------------------------------------------------------------------------

def _mjpeg_stream_route():
    """GET /camera/stream — MJPEG stream consumed by Atlas cv2.VideoCapture()."""
    return Response(
        _generate_mjpeg(),
        mimetype="multipart/x-mixed-replace; boundary=frame",
    )


def _latest_frame_route():
    """GET /api/edge/latest-frame — latest YOLO-annotated frame preview."""
    info = get_latest_frame()
    if not info.get("frame_url"):
        return jsonify({"ok": False, "message": "暂无实时帧数据"}), 404
    return jsonify({"ok": True, **info})


def register_camera_routes(edge_bp) -> None:
    """Add camera-related routes to the edge blueprint."""
    edge_bp.add_url_rule(
        "/camera/stream",
        "camera_stream",
        _mjpeg_stream_route,
    )
    edge_bp.add_url_rule(
        "/api/edge/latest-frame",
        "edge_latest_frame",
        _latest_frame_route,
    )
    edge_bp.add_url_rule(
        "/api/edge/camera/start",
        "camera_start",
        _camera_start_route,
        methods=["POST"],
    )
    edge_bp.add_url_rule(
        "/api/edge/camera/stop",
        "camera_stop",
        _camera_stop_route,
        methods=["POST"],
    )
    edge_bp.add_url_rule(
        "/api/edge/camera/status",
        "camera_status",
        _camera_status_route,
    )


def _camera_start_route():
    """POST /api/edge/camera/start — start the laptop camera stream."""
    try:
        _start_camera()
        return jsonify({"ok": True, "camera_active": True, "stream_url": "/camera/stream"})
    except Exception as exc:
        return jsonify({"ok": False, "camera_active": False, "error": str(exc)}), 500


def _camera_stop_route():
    """POST /api/edge/camera/stop — stop the laptop camera stream."""
    _stop_camera()
    return jsonify({"ok": True, "camera_active": False})


def _camera_status_route():
    """GET /api/edge/camera/status — check camera state."""
    return jsonify({"ok": True, "camera_active": is_laptop_camera_active()})
