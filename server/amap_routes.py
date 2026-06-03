from __future__ import annotations

import os

import requests
from flask import Blueprint, Response, jsonify, request

from server.amap_client import AMAP_BASE_URL, amap_key, amap_request


amap_bp = Blueprint("amap", __name__)


@amap_bp.get("/api/amap/js-config")
def amap_js_config():
    key = os.getenv("AMAP_JS_API_KEY", "").strip()
    security_code = os.getenv("AMAP_JS_SECURITY_CODE", "").strip()
    if not key or not security_code:
        return jsonify({"enabled": False, "error": "未配置 AMAP_JS_API_KEY 或 AMAP_JS_SECURITY_CODE"}), 200
    return jsonify({"enabled": True, "key": key, "security_code": security_code})


@amap_bp.get("/api/amap/ip-location")
def amap_ip_location():
    try:
        ip = str(request.args.get("ip", "")).strip()
        if ip in ("127.0.0.1", "::1", "localhost"):
            ip = ""
        data = amap_request("/ip", {"ip": ip, "output": "JSON"})
        if data.get("status") != "1":
            return jsonify({"error": data.get("info", "IP定位失败"), "raw": data}), 400
        return jsonify(
            {
                "source": "amap_ip",
                "province": data.get("province") if isinstance(data.get("province"), str) else "",
                "city": data.get("city") if isinstance(data.get("city"), str) else "",
                "adcode": data.get("adcode") if isinstance(data.get("adcode"), str) else "",
                "rectangle": data.get("rectangle") if isinstance(data.get("rectangle"), str) else "",
                "raw": data,
            }
        )
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@amap_bp.get("/api/amap/reverse-geocode")
def amap_reverse_geocode():
    location = str(request.args.get("location", "")).strip()
    if not location:
        return jsonify({"error": "缺少 location 参数，格式为 lng,lat"}), 400
    try:
        data = amap_request(
            "/geocode/regeo",
            {
                "location": location,
                "extensions": "all",
                "radius": request.args.get("radius", "1000"),
                "output": "JSON",
            },
        )
        if data.get("status") != "1":
            return jsonify({"error": data.get("info", "逆地理编码失败"), "raw": data}), 400
        regeocode = data.get("regeocode") or {}
        component = regeocode.get("addressComponent") or {}
        city = component.get("city")
        if isinstance(city, list):
            city = ""
        return jsonify(
            {
                "source": "browser_geolocation",
                "location": location,
                "address": regeocode.get("formatted_address", ""),
                "province": component.get("province", ""),
                "city": city or component.get("province", ""),
                "district": component.get("district", ""),
                "township": component.get("township", ""),
                "adcode": component.get("adcode", ""),
                "pois": (regeocode.get("pois") or [])[:5],
                "raw": data,
            }
        )
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@amap_bp.get("/api/amap/input-tips")
def amap_input_tips():
    keywords = str(request.args.get("keywords", "")).strip()
    city = str(request.args.get("city", "")).strip()
    if len(keywords) < 2:
        return jsonify({"tips": []})
    try:
        data = amap_request(
            "/assistant/inputtips",
            {"keywords": keywords, "city": city, "citylimit": "false", "datatype": "all", "output": "JSON"},
        )
        tips = data.get("tips") or []
        clean_tips = []
        for tip in tips[:8]:
            if not isinstance(tip, dict):
                continue
            clean_tips.append(
                {
                    "name": tip.get("name", ""),
                    "district": tip.get("district", ""),
                    "address": tip.get("address", ""),
                    "location": tip.get("location", ""),
                    "adcode": tip.get("adcode", ""),
                }
            )
        return jsonify({"tips": clean_tips})
    except Exception as exc:
        return jsonify({"error": str(exc), "tips": []}), 200


@amap_bp.get("/api/amap/static-map")
def amap_static_map():
    try:
        params = {
            "location": request.args.get("location", ""),
            "zoom": request.args.get("zoom", "12"),
            "size": request.args.get("size", "640*360"),
            "scale": request.args.get("scale", "2"),
            "markers": request.args.get("markers", ""),
            "labels": request.args.get("labels", ""),
            "paths": request.args.get("paths", ""),
            "traffic": request.args.get("traffic", "0"),
        }
        key = amap_key()
        if not key:
            return jsonify({"error": "未配置 AMAP_API_KEY"}), 500
        clean_params = {key_: value for key_, value in params.items() if value not in ("", None)}
        clean_params["key"] = key
        response = requests.get(f"{AMAP_BASE_URL}/staticmap", params=clean_params, timeout=10)
        response.raise_for_status()
        content_type = response.headers.get("content-type", "image/png")
        if "image" not in content_type.lower() or response.content[:1] in (b"{", b"["):
            return Response(status=204)
        return Response(response.content, mimetype=content_type)
    except Exception:
        return Response(status=204)

