"""
Laptop camera capture + MJPEG streaming + latest-frame cache
+ one-click Atlas YOLO auto-launch via SSH
+ SSE push for low-latency frame updates to browser.

Thread model:
  Capture thread (daemon) ──┐
                             ├── _frame_queue (maxsize=1) ──→ MJPEG generator
  _camera_lock protects     │                                  (Flask request thread)
  _camera_cap + _camera_active
"""
from __future__ import annotations

import json
import os
import queue
import socket
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import cv2
import paramiko
from flask import Response, jsonify, request

from server.bootstrap import PROJECT_ROOT


# ---------------------------------------------------------------------------
# Thread-safe camera state
# ---------------------------------------------------------------------------

_camera_lock = threading.Lock()
_camera_cap: cv2.VideoCapture | None = None
_camera_active: bool = False

_FRAME_WIDTH = 640
_FRAME_HEIGHT = 480
_JPEG_QUALITY = 80

# Queue that the capture thread feeds with JPEG bytes for the MJPEG generator.
# maxsize=1 so we always deliver the freshest frame to MJPEG consumers.
_frame_queue: queue.Queue[bytes | None] = queue.Queue(maxsize=1)


# ---------------------------------------------------------------------------
# SSE subscriber queue — push frame updates to all connected browsers
# ---------------------------------------------------------------------------

_sse_queues: list[queue.Queue[str | None]] = []
_sse_lock = threading.Lock()


def _sse_broadcast(data: str) -> None:
    """Push a data line to every connected SSE subscriber."""
    with _sse_lock:
        dead: list[int] = []
        for idx, q in enumerate(_sse_queues):
            try:
                q.put_nowait(data)
            except queue.Full:
                dead.append(idx)
        for idx in reversed(dead):
            _sse_queues.pop(idx)


def _sse_subscribe() -> queue.Queue[str | None]:
    """Register a new SSE subscriber."""
    q: queue.Queue[str | None] = queue.Queue(maxsize=32)
    with _sse_lock:
        _sse_queues.append(q)
    return q


def _sse_unsubscribe(q: queue.Queue[str | None]) -> None:
    """Remove a subscriber queue."""
    with _sse_lock:
        try:
            _sse_queues.remove(q)
        except ValueError:
            pass


# ---------------------------------------------------------------------------
# Latest annotated-frame cache (in-memory, zero disk I/O for preview)
# ---------------------------------------------------------------------------

_frame_lock = threading.Lock()
_latest_frame_bytes: bytes | None = None
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
    frame_bytes: bytes | None = None,
) -> None:
    """Record the most recent YOLO-annotated frame and push to SSE subscribers.

    When frame_bytes is provided the SSE payload carries a direct in-memory
    image URL (/api/edge/latest-frame/image), avoiding an extra disk read +
    HTTP round-trip by the browser.
    """
    global _latest_frame_bytes
    ts = datetime.now(timezone.utc).isoformat()
    if frame_bytes is not None:
        with _frame_lock:
            _latest_frame_bytes = frame_bytes

    image_url = f"/api/edge/latest-frame/image?_t={int(time.monotonic_ns())}" if frame_bytes else frame_url

    with _frame_lock:
        _latest_frame_cache.update({
            "frame_url": image_url,
            "fps": float(fps or 0),
            "detections_count": int(detections_count or 0),
            "timestamp": ts,
        })

    payload = {
        "frame_url": image_url,
        "fps": float(fps or 0),
        "detections_count": int(detections_count or 0),
        "timestamp": ts,
    }
    _sse_broadcast(json.dumps(payload, ensure_ascii=False))


def get_latest_frame() -> dict:
    """Return a shallow copy of the latest-frame cache."""
    with _frame_lock:
        return dict(_latest_frame_cache)


def get_latest_frame_bytes() -> bytes | None:
    """Return cached JPEG bytes (or None). Called by the image route."""
    with _frame_lock:
        return _latest_frame_bytes


# ---------------------------------------------------------------------------
# Camera lifecycle — capture thread + start / stop
# ---------------------------------------------------------------------------

def _capture_thread_func() -> None:
    """Daemon: continuously read camera frames and push JPEG bytes to _frame_queue."""
    while True:
        with _camera_lock:
            if not _camera_active or _camera_cap is None:
                # Signal the MJPEG generator to stop
                try:
                    _frame_queue.put_nowait(None)
                except queue.Full:
                    pass
                break
            ok, frame = _camera_cap.read()
        if not ok:
            time.sleep(0.01)
            continue
        _, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, _JPEG_QUALITY])
        raw = jpeg.tobytes()
        # Drop old frame if queue is full — MJPEG consumer always gets the latest
        try:
            _frame_queue.put_nowait(raw)
        except queue.Full:
            try:
                _frame_queue.get_nowait()
            except queue.Empty:
                pass
            try:
                _frame_queue.put_nowait(raw)
            except queue.Full:
                pass


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
        # Drain stale queue items from a previous session
        while not _frame_queue.empty():
            try:
                _frame_queue.get_nowait()
            except queue.Empty:
                break

    # Launch capture daemon thread — independent of Flask request threads
    t = threading.Thread(target=_capture_thread_func, daemon=True, name="camera-capture")
    t.start()


def _stop_camera() -> None:
    global _camera_cap, _camera_active
    with _camera_lock:
        _camera_active = False
    # Brief pause so the capture thread notices _camera_active=False and exits
    time.sleep(0.15)
    # Unblock MJPEG generator if it's blocked on _frame_queue.get()
    try:
        _frame_queue.put_nowait(None)
    except queue.Full:
        pass
    with _camera_lock:
        if _camera_cap is not None:
            _camera_cap.release()
            _camera_cap = None


# Public API
start_laptop_camera = _start_camera
stop_laptop_camera = _stop_camera


def is_laptop_camera_active() -> bool:
    with _camera_lock:
        return _camera_active


# ---------------------------------------------------------------------------
# SSH helpers for Atlas YOLO remote launch
# ---------------------------------------------------------------------------

def _atlas_ssh_client() -> paramiko.SSHClient:
    board_ip = os.getenv("ATLAS_BOARD_IP", "192.168.0.2").strip()
    board_user = os.getenv("ATLAS_BOARD_USER", "root").strip()
    board_password = os.getenv("ATLAS_BOARD_PASSWORD", "Mind@123").strip()

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(
        hostname=board_ip,
        username=board_user,
        password=board_password,
        timeout=8,
    )
    return ssh


def _resolve_server_url(request_host: str) -> str:
    host = request_host.split(":")[0]
    if host in ("127.0.0.1", "localhost"):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("192.168.0.2", 22))
            host = s.getsockname()[0]
            s.close()
        except Exception:
            try:
                host = socket.gethostbyname(socket.gethostname())
            except Exception:
                host = "192.168.0.101"
    port = request_host.split(":")[1] if ":" in request_host else "5000"
    return f"http://{host}:{port}"


def _sync_atlas_script(ssh: paramiko.SSHClient, board_home: str) -> str:
    local_path = str(PROJECT_ROOT / "edge" / "atlas_yolo_detect_and_upload.py")
    remote_path = f"{board_home}/atlas_yolo_detect_and_upload.py"
    try:
        sftp = ssh.open_sftp()
        sftp.put(local_path, remote_path)
        sftp.close()
    except Exception as exc:
        print(f"[camera] SFTP sync warning: {exc}")
    return remote_path


# Module-level callback for notifying edge_routes of YOLO status changes
_yolo_status_callback: object = None


def set_yolo_status_callback(cb: object) -> None:
    global _yolo_status_callback
    _yolo_status_callback = cb


def start_yolo_on_atlas(request_host: str) -> dict:
    """Start YOLO streaming on Atlas via SSH and return terminal output."""
    _start_camera()

    server_url = _resolve_server_url(request_host)
    stream_url = f"{server_url}/camera/stream"
    board_home = "/home/HwHiAiUser"

    stdout_lines: list[str] = []
    stderr_lines: list[str] = []

    try:
        ssh = _atlas_ssh_client()
    except Exception as exc:
        _stop_camera()
        return {
            "ok": False,
            "camera_active": False,
            "error": f"SSH 连接 Atlas 失败: {exc}",
            "stdout": "",
        }

    try:
        ssh.exec_command(
            "pkill -f 'atlas_yolo_detect_and_upload.py' || true"
        )
        time.sleep(0.5)

        script_path = _sync_atlas_script(ssh, board_home)
        yolo_dir = f"{board_home}/samples/notebooks/01-yolov5"
        python_bin = "/usr/local/miniconda3/bin/python3"

        run_cmd = (
            f"cd {yolo_dir} && "
            f"source /usr/local/Ascend/ascend-toolkit/set_env.sh && "
            f"nohup {python_bin} -u {script_path} "
            f"--camera {stream_url} "
            f"--model yolo.om "
            f"--labels coco_names.txt "
            f"--server {server_url} "
            f"--upload --force-cloud --no-analyze "
            f"--interval-sec 0.1"
        )
        daemon_cmd = (
            f"setsid bash -c '{run_cmd} >> {board_home}/yolo_camera.log 2>&1 &'"
            f" < /dev/null > /dev/null 2>&1"
        )

        _sin, _sout, _serr = ssh.exec_command(daemon_cmd)
        _sin.close()
        stdout_lines.append(_sout.read().decode("utf-8", errors="ignore"))
        stderr_lines.append(_serr.read().decode("utf-8", errors="ignore"))
        time.sleep(2.5)

        _sin, pgrep_out, _serr = ssh.exec_command(
            "pgrep -f 'atlas_yolo_detect_and_upload.py' || true"
        )
        pids = pgrep_out.read().decode("utf-8", errors="ignore").strip()
        pgrep_out.close()

        if not pids:
            _sin, log_out, _serr = ssh.exec_command(
                f"tail -30 {board_home}/yolo_camera.log 2>/dev/null || echo '(日志不存在)'"
            )
            log_tail = log_out.read().decode("utf-8", errors="ignore")
            log_out.close()
            _stop_camera()
            return {
                "ok": False,
                "camera_active": False,
                "error": "YOLO 进程未能成功启动，请检查 Atlas 环境。",
                "stdout": f"命令:\n{run_cmd}\n\n日志末尾:\n{log_tail}",
            }

        _sin, log_out, _serr = ssh.exec_command(
            f"tail -20 {board_home}/yolo_camera.log 2>/dev/null || echo '(日志不可读)'"
        )
        log_tail = log_out.read().decode("utf-8", errors="ignore")
        log_out.close()

        return {
            "ok": True,
            "camera_active": True,
            "message": f"笔电摄像头推流已启动，Atlas YOLO 推理已在后台运行 (PID: {pids})。",
            "stream_url": stream_url,
            "server_url": server_url,
            "pid": pids,
            "stdout": (
                f"[camera] 摄像头推流: {server_url}/camera/stream\n"
                f"[ssh] 连接 Atlas 成功\n"
                f"[yolo] 已启动 YOLO 推理 (PID: {pids})\n"
                f"[yolo] 命令: {run_cmd}\n\n"
                f"--- Atlas 日志 ---\n{log_tail}"
            ),
        }

    except Exception as exc:
        _stop_camera()
        return {
            "ok": False,
            "camera_active": False,
            "error": f"远程执行异常: {exc}",
            "stdout": "\n".join(stdout_lines),
        }
    finally:
        ssh.close()


def stop_yolo_on_atlas() -> str:
    try:
        ssh = _atlas_ssh_client()
    except Exception as exc:
        return f"SSH 连接失败，无法远程停止 YOLO: {exc}"

    try:
        _sin, _sout, _serr = ssh.exec_command(
            "pkill -f 'atlas_yolo_detect_and_upload.py' || true"
        )
        _sout.read()
        time.sleep(0.3)
        return "已通过 SSH 终止 Atlas 上的 YOLO 推理进程。"
    except Exception as exc:
        return f"远程终止 YOLO 失败: {exc}"
    finally:
        ssh.close()


# ---------------------------------------------------------------------------
# MJPEG stream generator — consumes from capture thread via queue
# ---------------------------------------------------------------------------

def _generate_mjpeg():
    """Flask streaming generator for multipart/x-mixed-replace JPEG.

    Consumes frame bytes from the capture thread via _frame_queue.
    Does NOT start or stop the camera — the camera lifecycle is managed
    by the start/stop camera APIs.  This generator is a passive consumer
    so that a MJPEG client disconnecting does not kill the capture thread.
    """
    try:
        while True:
            raw = _frame_queue.get()
            if raw is None:
                break
            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n\r\n"
                + raw
                + b"\r\n"
            )
    except GeneratorExit:
        pass


# ---------------------------------------------------------------------------
# Flask routes — registered via register_camera_routes
# ---------------------------------------------------------------------------

def _mjpeg_stream_route():
    """GET /camera/stream — MJPEG stream consumed by Atlas cv2.VideoCapture()."""
    return Response(
        _generate_mjpeg(),
        mimetype="multipart/x-mixed-replace; boundary=frame",
    )


def _latest_frame_route():
    """GET /api/edge/latest-frame — latest YOLO-annotated frame metadata (JSON)."""
    info = get_latest_frame()
    if not info.get("frame_url"):
        return jsonify({"ok": False, "message": "暂无实时帧数据"}), 404
    return jsonify({"ok": True, **info})


def _latest_frame_image_route():
    """GET /api/edge/latest-frame/image — cached annotated JPEG from memory.

    Zero disk I/O — returns bytes directly from the in-memory cache.
    Cache-busting query param _t is ignored (the cache always holds
    the single most recent frame).
    """
    img_bytes = get_latest_frame_bytes()
    if img_bytes is None:
        # Fallback to file if no in-memory cache (e.g. after restart)
        info = get_latest_frame()
        file_url = info.get("frame_url", "")
        if file_url and file_url.startswith("/api/edge/artifacts/"):
            from flask import send_from_directory
            artifact_dir = PROJECT_ROOT / "data" / "edge_artifacts"
            filename = file_url.split("/")[-1].split("?")[0]
            return send_from_directory(artifact_dir, filename, mimetype="image/jpeg")
        return Response("无缓存帧数据", status=404)
    return Response(
        img_bytes,
        mimetype="image/jpeg",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


def _camera_start_route():
    """POST /api/edge/camera/start — start the laptop camera stream (no YOLO)."""
    try:
        _start_camera()
        return jsonify({"ok": True, "camera_active": True, "stream_url": "/camera/stream"})
    except Exception as exc:
        return jsonify({"ok": False, "camera_active": False, "error": str(exc)}), 500


def _camera_start_yolo_route():
    """POST /api/edge/camera/start-yolo — start camera + auto-launch YOLO on Atlas."""
    request_host = request.host or "127.0.0.1:5000"
    result = start_yolo_on_atlas(request_host)
    if result.get("ok") and _yolo_status_callback is not None:
        _yolo_status_callback("running_board")
    status_code = 200 if result.get("ok") else 500
    return jsonify(result), status_code


def _camera_stop_route():
    """POST /api/edge/camera/stop — stop camera AND kill YOLO on Atlas."""
    _stop_camera()
    yolo_msg = stop_yolo_on_atlas()
    if _yolo_status_callback is not None:
        _yolo_status_callback("idle")
    # Clear cached frame bytes so the preview card shows "stopped"
    with _frame_lock:
        global _latest_frame_bytes
        _latest_frame_bytes = None
    return jsonify({
        "ok": True,
        "camera_active": False,
        "yolo_stopped": yolo_msg,
    })


def _camera_status_route():
    """GET /api/edge/camera/status — check camera state."""
    return jsonify({"ok": True, "camera_active": is_laptop_camera_active()})


def _camera_sse_route():
    """GET /api/edge/latest-frame/stream — SSE push of latest YOLO frame."""
    q = _sse_subscribe()
    info = get_latest_frame()

    def generate():
        try:
            if info.get("frame_url"):
                yield f"data: {json.dumps(info, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'camera_active': is_laptop_camera_active()}, ensure_ascii=False)}\n\n"
            while True:
                data = q.get()
                if data is None:
                    break
                yield f"data: {data}\n\n"
        except GeneratorExit:
            pass
        finally:
            _sse_unsubscribe(q)

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


def register_camera_routes(edge_bp) -> None:
    """Add camera-related routes to the edge blueprint."""
    edge_bp.add_url_rule("/camera/stream", "camera_stream", _mjpeg_stream_route)
    edge_bp.add_url_rule("/api/edge/latest-frame", "edge_latest_frame", _latest_frame_route)
    edge_bp.add_url_rule("/api/edge/latest-frame/image", "latest_frame_image", _latest_frame_image_route)
    edge_bp.add_url_rule("/api/edge/camera/status", "camera_status", _camera_status_route)
    edge_bp.add_url_rule("/api/edge/camera/start", "camera_start", _camera_start_route, methods=["POST"])
    edge_bp.add_url_rule("/api/edge/camera/start-yolo", "camera_start_yolo", _camera_start_yolo_route, methods=["POST"])
    edge_bp.add_url_rule("/api/edge/camera/stop", "camera_stop", _camera_stop_route, methods=["POST"])
    edge_bp.add_url_rule("/api/edge/latest-frame/stream", "frame_sse", _camera_sse_route)
