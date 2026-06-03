from __future__ import annotations

import os
from datetime import datetime
from urllib.parse import urlparse

import requests
from flask import Blueprint, Response, abort, jsonify, render_template, request

from travel_agent.config import load_llm_config
from travel_agent.skills import list_installed_skills
from travel_agent.train_tools import is_train_tools_available


core_bp = Blueprint("core", __name__)


@core_bp.get("/")
def index():
    return render_template("index.html")


@core_bp.get("/api/health")
def health():
    return jsonify(
        {
            "ok": True,
            "service": "atlas-edge-cloud-agent",
            "time": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        }
    )


@core_bp.get("/api/image_proxy")
def image_proxy():
    image_url = (request.args.get("url") or "").strip()
    parsed = urlparse(image_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        abort(400)
    try:
        response = requests.get(
            image_url,
            timeout=8,
            headers={
                "User-Agent": "Mozilla/5.0",
                "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
            },
        )
        response.raise_for_status()
    except requests.RequestException:
        abort(502)
    content_type = response.headers.get("Content-Type", "image/jpeg")
    if not content_type.startswith("image/"):
        abort(415)
    return Response(
        response.content,
        mimetype=content_type,
        headers={"Cache-Control": "public, max-age=86400"},
    )


@core_bp.get("/api/status")
def status():
    config = load_llm_config()
    return jsonify(
        {
            "model": config.model,
            "thinking_model": config.thinking_model,
            "base_url": config.base_url,
            "api_key_loaded": bool(config.api_key),
            "amap_key_loaded": bool(os.getenv("AMAP_API_KEY", "").strip()),
            "amap_js_key_loaded": bool(os.getenv("AMAP_JS_API_KEY", "").strip()),
            "amap_js_security_loaded": bool(os.getenv("AMAP_JS_SECURITY_CODE", "").strip()),
            "qweather_key_loaded": bool(os.getenv("QWEATHER_API_KEY", "").strip()),
            "qweather_jwt_loaded": bool(
                os.getenv("QWEATHER_JWT_KEY_ID", "").strip()
                and os.getenv("QWEATHER_JWT_PROJECT_ID", "").strip()
                and (
                    os.getenv("QWEATHER_JWT_PRIVATE_KEY", "").strip()
                    or os.getenv("QWEATHER_JWT_PRIVATE_KEY_PATH", "").strip()
                )
            ),
            "qweather_host_loaded": bool(os.getenv("QWEATHER_API_HOST", "").strip()),
            "train_tools_available": is_train_tools_available(),
            "aviationstack_key_loaded": bool(os.getenv("AVIATIONSTACK_API_KEY", "").strip()),
            "rapidapi_key_loaded": bool(os.getenv("RAPIDAPI_KEY", "").strip()),
            "skill_count": len(list_installed_skills()),
        }
    )


@core_bp.get("/api/skills")
def skills():
    return jsonify({"skills": list_installed_skills()})
