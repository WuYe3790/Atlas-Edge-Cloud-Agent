from __future__ import annotations

import json
import re


def _find_json_fence_pairs(text: str) -> list[tuple[int, int, str]]:
    """Return (full_start, full_end, content) for every json-like code fence."""
    results: list[tuple[int, int, str]] = []
    i = 0
    while True:
        fence_start = text.find("```", i)
        if fence_start == -1:
            break
        tag_end = text.find("\n", fence_start)
        if tag_end == -1:
            break
        tag = text[fence_start + 3:tag_end].strip().lower()
        if tag not in ("json", ""):
            i = tag_end
            continue
        content_start = tag_end + 1
        fence_end = text.find("\n```", content_start)
        if fence_end == -1:
            fence_end = text.find("```", content_start)
        if fence_end == -1:
            break
        content = text[content_start:fence_end].strip()
        full_end = fence_end + (4 if text.startswith("\n```", fence_end) else 3)
        while full_end < len(text) and text[full_end] in ("\n", "\r"):
            full_end += 1
        full_start = fence_start
        while full_start > 0 and text[full_start - 1] in ("\n", "\r"):
            full_start -= 1
        results.append((full_start, full_end, content))
        i = full_end
    return results


def extract_structured_json(text: str) -> dict | None:
    """Extract structured travel plan JSON from the last json code fence."""
    if not text:
        return None
    fences = _find_json_fence_pairs(text)
    if not fences:
        return None
    known_keys = (
        "summary",
        "weather",
        "weather_alerts",
        "weather_indices",
        "transport_options",
        "daily_itinerary",
        "hotel_options",
        "budget",
        "tips",
        "poi_recommendations",
    )
    for _start, _end, content in reversed(fences):
        try:
            data = json.loads(content)
            if isinstance(data, dict) and any(k in data for k in known_keys):
                return data
        except json.JSONDecodeError:
            continue
    return None


def parse_hotel_options_from_trace(trace: list[dict]) -> list[dict]:
    """Extract hotel cards from search_hotel_prices tool output as a fallback."""
    hotels: list[dict] = []
    for item in trace:
        if item.get("tool") != "search_hotel_prices":
            continue
        result = str(item.get("result") or "")
        is_amap_fallback = "高德地图酒店 POI" in result or "无实时房价" in result
        for line in result.splitlines():
            if not re.match(r"^\d+\.\s+", line):
                continue
            text = re.sub(r"^\d+\.\s+", "", line).strip()
            parts = [part.strip() for part in text.split("｜") if part.strip()]
            if len(parts) < 2:
                continue
            hotel = {
                "name": parts[0],
                "area": parts[1] if len(parts) > 1 else "",
                "price_total": "",
                "currency": "",
                "rating": "",
                "review_count": "",
                "stars": "",
                "checkin": "",
                "checkout": "",
                "location": "",
                "photo_url": "",
                "data_source": "高德地图酒店 POI" if is_amap_fallback else "Booking.com/RapidAPI",
                "notes": "RapidAPI 不可用时的酒店位置参考，不含实时房价或库存。" if is_amap_fallback else "价格为接口返回参考值，最终以 Booking.com 确认页为准。",
            }
            for part in parts[2:]:
                if part.startswith("总价 "):
                    hotel["price_total"] = part.removeprefix("总价 ").strip()
                    currency_match = re.match(r"([A-Z]{3})\s+", hotel["price_total"])
                    if currency_match:
                        hotel["currency"] = currency_match.group(1)
                elif part.startswith("评分 "):
                    hotel["rating"] = part.removeprefix("评分 ").strip()
                elif part.startswith("评论 "):
                    hotel["review_count"] = part.removeprefix("评论 ").strip()
                elif part.startswith("星级 "):
                    hotel["stars"] = part.removeprefix("星级 ").strip()
                elif part.startswith("坐标 "):
                    hotel["location"] = part.removeprefix("坐标 ").strip()
                elif part.startswith("入住 "):
                    hotel["checkin"] = part.removeprefix("入住 ").strip()
                elif part.startswith("离店 "):
                    hotel["checkout"] = part.removeprefix("离店 ").strip()
                elif part.startswith("照片 "):
                    hotel["photo_url"] = part.removeprefix("照片 ").strip()
                elif part.startswith("说明 "):
                    hotel["notes"] = part.removeprefix("说明 ").strip()
            hotels.append(hotel)
    return hotels


def parse_weather_indices_from_trace(trace: list[dict]) -> list[dict]:
    """Extract weather index cards from get_weather_indices output as a fallback."""
    indices: list[dict] = []
    city = ""
    data_source = ""
    for item in trace:
        if item.get("tool") != "get_weather_indices":
            continue
        result = str(item.get("result") or "")
        for line in result.splitlines():
            if line.startswith("数据源："):
                data_source = line.removeprefix("数据源：").strip()
            elif line.startswith("城市："):
                city = re.sub(r"（.*?）", "", line.removeprefix("城市：")).strip()
            elif re.match(r"^\d+\.\s+", line):
                text = re.sub(r"^\d+\.\s+", "", line).strip()
                parts = [part.strip() for part in text.split("｜") if part.strip()]
                if not parts:
                    continue
                entry = {
                    "city": city,
                    "name": parts[0],
                    "date": "",
                    "level": "",
                    "category": "",
                    "text": "",
                    "data_source": data_source or "和风天气",
                }
                for part in parts[1:]:
                    if part.startswith("日期 "):
                        entry["date"] = part.removeprefix("日期 ").strip()
                    elif part.startswith("等级 "):
                        entry["level"] = part.removeprefix("等级 ").strip()
                    elif part.startswith("类别 "):
                        entry["category"] = part.removeprefix("类别 ").strip()
                    elif part.startswith("建议 "):
                        entry["text"] = part.removeprefix("建议 ").strip()
                indices.append(entry)
    return indices


def enrich_structured_data_from_trace(structured: dict | None, trace: list[dict]) -> dict | None:
    """Patch structured data with deterministic tool-result parsing when the LLM omits optional cards."""
    if not structured:
        return structured
    indices = parse_weather_indices_from_trace(trace)
    if indices and not structured.get("weather_indices"):
        structured["weather_indices"] = indices
    hotels = parse_hotel_options_from_trace(trace)
    if hotels and not structured.get("hotel_options"):
        structured["hotel_options"] = hotels
    elif hotels and structured.get("hotel_options"):
        trace_by_name = {
            re.sub(r"\s+", "", str(hotel.get("name") or "")).lower(): hotel
            for hotel in hotels
            if hotel.get("name")
        }
        struct_list = structured.get("hotel_options") or []
        for idx, hotel in enumerate(struct_list):
            key = re.sub(r"\s+", "", str(hotel.get("name") or "")).lower()
            trace_hotel = trace_by_name.get(key)
            # 名称匹配失败时，按位置兜底
            if not trace_hotel and idx < len(hotels):
                trace_hotel = hotels[idx]
            if not trace_hotel:
                continue
            # 始终用 trace 中的中文名称覆盖，确保卡片不出现英文名
            if trace_hotel.get("name"):
                hotel["name"] = trace_hotel["name"]
            if trace_hotel.get("area"):
                hotel["area"] = trace_hotel["area"]
            for field in (
                "photo_url",
                "location",
                "price_total",
                "currency",
                "rating",
                "review_count",
                "stars",
                "checkin",
                "checkout",
            ):
                if trace_hotel.get(field):
                    hotel[field] = trace_hotel[field]
    return structured


def strip_structured_json(text: str) -> str:
    """Remove all json code fence blocks from text."""
    if not text:
        return text
    fences = _find_json_fence_pairs(text)
    if not fences:
        return text
    result = text
    for start, end, _content in reversed(fences):
        result = result[:start] + result[end:]
    return result.strip()
