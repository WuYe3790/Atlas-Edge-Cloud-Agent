from __future__ import annotations

from flask import jsonify


def public_client_context(payload: dict) -> dict:
    context = payload.get("client_context")
    return context if isinstance(context, dict) else {}


def build_client_context_prompt(context: dict) -> str:
    if not context:
        return ""
    city = str(context.get("city") or "").strip()
    province = str(context.get("province") or "").strip()
    district = str(context.get("district") or "").strip()
    address = str(context.get("address") or "").strip()
    location = str(context.get("location") or "").strip()
    source = str(context.get("source") or "").strip()
    if not any((city, province, district, address, location)):
        return ""
    lines = ["当前用户位置上下文（来自前端定位/高德地图）："]
    if province or city or district:
        lines.append(f"- 默认出发区域：{province}{city}{district}")
    if address:
        lines.append(f"- 默认出发地址：{address}")
    if location:
        lines.append(f"- 默认出发坐标：{location}")
    if source:
        lines.append(f"- 位置来源：{source}")
    lines.append("如果用户没有明确说明出发地，可将该位置作为默认出发地；如果用户明确给出出发地，则必须以用户输入为准。")
    return "\n".join(lines)


def looks_like_garbled_text(text: str) -> bool:
    compact = "".join(text.split())
    if len(compact) < 4:
        return False
    question_count = compact.count("?") + compact.count("？")
    replacement_count = compact.count("�")
    suspicious_count = question_count + replacement_count
    if suspicious_count >= 4 and suspicious_count / max(len(compact), 1) >= 0.35:
        return True
    return replacement_count >= 2


def garbled_error_response():
    return jsonify(
        {
            "error": "输入内容疑似编码乱码，请在网页输入框中重新输入中文，或确认终端使用 UTF-8 编码。",
            "garbled_input": True,
        }
    ), 400

