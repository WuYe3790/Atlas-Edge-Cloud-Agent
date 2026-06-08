"""
Laptop camera capture + MJPEG streaming + latest-frame cache
+ one-click Atlas YOLO auto-launch via SSH.

Flask routes are registered on the edge blueprint via register_camera_routes().
"""
from __future__ import annotations

import os
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
    """Discover the laptop IP that Atlas can reach."""
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
    """Sync atlas_yolo_detect_and_upload.py to the board via SFTP.

    Returns the target script path on the board.
    """
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
# (avoids circular import — set via register_camera_routes)
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
        # 1. Kill any existing YOLO process
        ssh.exec_command(
            "pkill -f 'atlas_yolo_detect_and_upload.py' || true"
        )
        time.sleep(0.5)

        # 2. Sync the latest script
        script_path = _sync_atlas_script(ssh, board_home)

        # 3. Build and execute the YOLO command
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
            f"--upload --force-cloud --no-analyze"
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

        # 4. Verify YOLO is running
        _sin, pgrep_out, _serr = ssh.exec_command(
            "pgrep -f 'atlas_yolo_detect_and_upload.py' || true"
        )
        pids = pgrep_out.read().decode("utf-8", errors="ignore").strip()
        pgrep_out.close()

        if not pids:
            # Try to read tail of log for diagnostics
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

        # 5. Read initial log output
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
    """SSH to Atlas and kill the YOLO process. Returns a status string."""
    try:
        ssh = _atlas_ssh_client()
    except Exception as exc:
        return f"SSH 连接失败，无法远程停止 YOLO: {exc}"

    try:
        _sin, _sout, _serr = ssh.exec_command(
            "pkill -f 'atlas_yolo_detect_and_upload.py' || true"
        )
        _sout.read()
        # Also clear the camera-related YOLO status
        time.sleep(0.3)
        return "已通过 SSH 终止 Atlas 上的 YOLO 推理进程。"
    except Exception as exc:
        return f"远程终止 YOLO 失败: {exc}"
    finally:
        ssh.close()


# ---------------------------------------------------------------------------
# MJPEG stream generator
# ---------------------------------------------------------------------------

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
    return jsonify({
        "ok": True,
        "camera_active": False,
        "yolo_stopped": yolo_msg,
    })


def _camera_status_route():
    """GET /api/edge/camera/status — check camera state."""
    return jsonify({"ok": True, "camera_active": is_laptop_camera_active()})


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
        "/api/edge/camera/status",
        "camera_status",
        _camera_status_route,
    )
    edge_bp.add_url_rule(
        "/api/edge/camera/start",
        "camera_start",
        _camera_start_route,
        methods=["POST"],
    )
    edge_bp.add_url_rule(
        "/api/edge/camera/start-yolo",
        "camera_start_yolo",
        _camera_start_yolo_route,
        methods=["POST"],
    )
    edge_bp.add_url_rule(
        "/api/edge/camera/stop",
        "camera_stop",
        _camera_stop_route,
        methods=["POST"],
    )
