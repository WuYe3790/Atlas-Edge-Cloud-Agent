from __future__ import annotations

import json
import re

import requests
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI

from travel_agent.config import load_llm_config
from travel_agent.tool_clients import AMAP_BASE_URL, _amap_key, _rapidapi_headers, _rapidapi_host, _rapidapi_key, _rapidapi_request_json, _request_json
from travel_agent.tool_data import HOTEL_CITY_ALIASES
from travel_agent.tool_formatters import (
    _first_non_empty,
    _format_money,
    _log_tool_end,
    _log_tool_start,
    _normalize_price_display,
    _poi_scalar,
)


def _hotel_city_queries(city: str) -> list[str]:
    raw = str(city or "").strip()
    if not raw:
        return []
    normalized = raw.removesuffix("市")
    alias = HOTEL_CITY_ALIASES.get(normalized) or HOTEL_CITY_ALIASES.get(raw)
    return list(dict.fromkeys(query for query in (raw, normalized, alias or "") if query))

def _booking_search_destinations(city: str) -> list[dict]:
    if not _rapidapi_key():
        return []
    host = _rapidapi_host()
    for query in _hotel_city_queries(city):
        data = _rapidapi_request_json(
            f"https://{host}/api/v1/hotels/searchDestination",
            {"query": query},
            timeout=20,
        )
        items = data.get("data") if isinstance(data.get("data"), list) else []
        if items:
            return items
    return []

def _booking_destination_id(destination: dict) -> tuple[str, str]:
    dest_id = destination.get("dest_id") or destination.get("city_ufi") or destination.get("id")
    dest_type = str(destination.get("dest_type") or "city").upper()
    if dest_type == "HOTEL":
        search_type = "HOTEL"
    elif dest_type in {"LANDMARK", "DISTRICT", "REGION", "AIRPORT"}:
        search_type = dest_type
    else:
        search_type = "CITY"
    return str(dest_id or ""), search_type


def _is_rapidapi_quota_error(text: object) -> bool:
    lowered = str(text or "").lower()
    quota_keywords = (
        "quota",
        "limit",
        "monthly",
        "exceeded",
        "too many requests",
        "rate limit",
        "you have exceeded",
        "用量",
        "额度",
        "配额",
        "上限",
        "次数",
    )
    return any(keyword in lowered for keyword in quota_keywords)


def _format_amap_hotel_fallback(
    city: str,
    checkin_date: str,
    checkout_date: str,
    adults: int,
    rooms: int,
    limit: int,
    reason: str,
) -> str:
    try:
        adults_count = max(1, int(adults))
    except (TypeError, ValueError):
        adults_count = 2
    try:
        rooms_count = max(1, int(rooms))
    except (TypeError, ValueError):
        rooms_count = 1
    key = _amap_key()
    if not key:
        return (
            f"酒店价格查询不可用：{reason}\n"
            "酒店位置参考也不可用：未配置 AMAP_API_KEY。\n"
            "建议：请暂时按目的地核心商圈、地铁站或景区附近手动筛选住宿；当前无法返回实时房价。"
        )

    safe_limit = max(1, min(int(limit), 10))
    try:
        data = _request_json(
            f"{AMAP_BASE_URL}/place/text",
            {
                "key": key,
                "keywords": "酒店",
                "city": city,
                "citylimit": "true",
                "offset": safe_limit,
                "page": 1,
                "extensions": "all",
                "output": "JSON",
            },
            timeout=15,
        )
    except Exception as exc:
        return (
            f"酒店价格查询不可用：{reason}\n"
            f"酒店位置参考查询也失败：{exc}\n"
            "建议：请暂时按目的地核心商圈、地铁站或景区附近手动筛选住宿；当前无法返回实时房价。"
        )

    pois = data.get("pois") or []
    if data.get("status") != "1" or not pois:
        return (
            f"酒店价格查询不可用：{reason}\n"
            f"高德地图也未在“{city}”找到酒店 POI。"
        )

    lines = [
        "数据源：高德地图酒店 POI（RapidAPI 不可用时的住宿位置参考）",
        f"查询城市：{city}",
        f"入住/离店：{checkin_date} → {checkout_date}；成人 {adults_count}；房间 {rooms_count}",
        f"降级原因：{reason}",
        "说明：当前无法获取 Booking.com/RapidAPI 实时房价。以下只提供酒店位置、评分、人均/参考消费等 POI 信息，不代表可订房价或库存。",
        "酒店位置参考结果：",
    ]
    for index, poi in enumerate(pois[:safe_limit], start=1):
        name = poi.get("name", "未知酒店")
        address = _poi_scalar(poi.get("address"), city)
        biz_ext = poi.get("biz_ext") or {}
        rating = _poi_scalar(biz_ext.get("rating"), "暂无评分")
        cost = _poi_scalar(biz_ext.get("cost"), "")
        stars = _poi_scalar(biz_ext.get("star"), "")
        location = _poi_scalar(poi.get("location"), "")
        tel = _poi_scalar(poi.get("tel"), "")
        photos = poi.get("photos") or []
        photo_url = photos[0].get("url") if photos and isinstance(photos[0], dict) else ""
        optional_parts = [
            f"评分 {rating}" if rating != "暂无评分" else "",
            f"人均 {cost}元" if cost else "",
            f"星级 {stars}" if stars else "",
            f"电话 {tel}" if tel else "",
            f"坐标 {location}" if location else "",
            f"照片 {photo_url}" if photo_url else "",
            "说明 无实时房价，仅作住宿位置参考",
        ]
        lines.append(
            f"{index}. {name}｜{address}｜总价 实时价格不可用｜"
            + "｜".join(part for part in optional_parts if part)
        )
    return "\n".join(lines)


def _translate_hotel_names(names: list[str]) -> dict[str, str]:
    """使用 LLM 将酒店英文名批量翻译为中文官方名称。"""
    if not names:
        return {}
    unique = list(dict.fromkeys(names))
    try:
        config = load_llm_config()
        if not config.api_key:
            return {}
        llm = ChatOpenAI(
            model=config.model,
            api_key=config.api_key,
            base_url=config.base_url,
            temperature=0.1,
            timeout=min(config.timeout, 15),
            extra_body={"thinking": {"type": "disabled"}},
        )
        prompt = (
            "将以下酒店名称翻译为中文官方名称。对于知名国际连锁酒店（如Hilton、Marriott、Sheraton、Hyatt等），"
            "请使用其官方中文品牌名。返回一个 JSON 对象，键为英文原名，值为中文译名。"
            "只返回 JSON，不要其他内容。\n\n"
            f"酒店名称列表：\n{json.dumps(unique, ensure_ascii=False)}\n\n"
            '示例输出格式：{"Grand Hyatt Hangzhou": "杭州君悦酒店", "Hilton Hangzhou": "杭州希尔顿酒店"}'
        )
        response = llm.invoke(prompt)
        text = response.content if hasattr(response, 'content') else str(response)
        json_match = re.search(r"\{[^{}]*\}", text, re.DOTALL)
        if json_match:
            result = json.loads(json_match.group())
            if isinstance(result, dict):
                return result
        result = json.loads(text.strip())
        if isinstance(result, dict):
            return result
    except Exception as exc:
        print(f"酒店名称翻译失败，保留英文名：{exc}")
    return {name: name for name in unique}


@tool
def search_hotel_prices(
    city: str,
    checkin_date: str,
    checkout_date: str,
    adults: int = 2,
    rooms: int = 1,
    limit: int = 6,
    currency: str = "CNY",
) -> str:
    """使用 Booking.com RapidAPI 查询真实酒店价格，适合住宿推荐、预算估算和酒店价格对比。

    Args:
        city: 目的地城市，例如 "杭州"、"西安"、"Ningbo"。
        checkin_date: 入住日期，YYYY-MM-DD。
        checkout_date: 离店日期，YYYY-MM-DD。
        adults: 成人数量。
        rooms: 房间数量。
        limit: 返回酒店数量，建议 3-8。
        currency: 价格币种，默认 CNY。
    """
    start = _log_tool_start(
        "search_hotel_prices",
        city=city,
        checkin_date=checkin_date,
        checkout_date=checkout_date,
        adults=adults,
        rooms=rooms,
        limit=limit,
        currency=currency,
    )
    if not _rapidapi_key():
        result = _format_amap_hotel_fallback(
            city,
            checkin_date,
            checkout_date,
            adults,
            rooms,
            limit,
            "未配置 RAPIDAPI_KEY，无法查询 Booking.com 实时房价。",
        )
        _log_tool_end("search_hotel_prices", start, result)
        return result

    try:
        destinations = _booking_search_destinations(city)
        if not destinations:
            result = _format_amap_hotel_fallback(
                city,
                checkin_date,
                checkout_date,
                adults,
                rooms,
                limit,
                f"Booking.com 未找到“{city}”对应目的地。",
            )
            _log_tool_end("search_hotel_prices", start, result)
            return result

        destination = destinations[0]
        dest_id, search_type = _booking_destination_id(destination)
        if not dest_id:
            result = _format_amap_hotel_fallback(
                city,
                checkin_date,
                checkout_date,
                adults,
                rooms,
                limit,
                f"未能取得“{city}”的 Booking.com 目的地 ID。",
            )
            _log_tool_end("search_hotel_prices", start, result)
            return result

        safe_limit = max(1, min(int(limit), 10))
        host = _rapidapi_host()
        data = _rapidapi_request_json(
            f"https://{host}/api/v1/hotels/searchHotels",
            {
                "dest_id": dest_id,
                "search_type": search_type,
                "arrival_date": checkin_date,
                "departure_date": checkout_date,
                "adults": max(1, int(adults)),
                "room_qty": max(1, int(rooms)),
                "currency_code": currency,
            },
            timeout=30,
        )
        hotels = ((data.get("data") or {}).get("hotels") or []) if isinstance(data.get("data"), dict) else []
        if data.get("status") is False or not hotels:
            message = data.get("message", "无详细说明")
            result = _format_amap_hotel_fallback(
                city,
                checkin_date,
                checkout_date,
                adults,
                rooms,
                limit,
                f"Booking.com/RapidAPI 未返回可用酒店价格：{message}",
            )
            _log_tool_end("search_hotel_prices", start, result)
            return result

        # 收集所有需要翻译的英文文本（名称、区域、地址、目的地）
        texts_to_translate: list[str] = []
        for entry in hotels[:safe_limit]:
            prop = entry.get("property") or {}
            for key in ("name", "wishlistName", "address"):
                value = str(prop.get(key) or "").strip()
                if value and not value.isdigit():
                    texts_to_translate.append(value)
        dest_name_raw = _first_non_empty(destination.get("name"), "")
        if dest_name_raw and dest_name_raw != city:
            texts_to_translate.append(dest_name_raw)
        trans_map = _translate_hotel_names(texts_to_translate)

        def _tr(text: str) -> str:
            """从翻译映射中查找中文名，未找到则返回原文。"""
            return trans_map.get(text, text)

        destination_name = _tr(dest_name_raw) if dest_name_raw else city
        if not destination_name or destination_name == dest_name_raw:
            destination_name = _tr(_first_non_empty(destination.get("name"), city))

        lines = [
            "数据源：Booking.com via RapidAPI",
            f"查询目的地：{destination_name}（dest_id={dest_id}, search_type={search_type}）",
            f"入住/离店：{checkin_date} → {checkout_date}；成人 {max(1, int(adults))}；房间 {max(1, int(rooms))}",
            "说明：价格为接口返回的实时参考总价，库存、税费和最终支付价以 Booking.com 页面为准。",
            "⚠️ 重要提示：以下酒店名称、区域和目的地已翻译为中文。请在后续文字描述和结构化卡片中【只使用中文名称】，不要出现英文原名或中英文混用。",
            "酒店价格结果：",
        ]
        for index, entry in enumerate(hotels[:safe_limit], start=1):
            prop = entry.get("property") or {}
            hotel_name = _tr(prop.get("name", "")) or "未知酒店"
            area = _tr(prop.get("wishlistName") or "") or _tr(prop.get("address") or "") or destination_name
            price = ((prop.get("priceBreakdown") or {}).get("grossPrice") or {})
            hotel_currency = _first_non_empty(price.get("currency"), currency, default=currency)
            total_price = _format_money(price.get("value"), hotel_currency)
            total_price = _normalize_price_display(total_price)
            review = _first_non_empty(prop.get("reviewScore"), default="暂无评分")
            review_count = _first_non_empty(prop.get("reviewCount"), default="暂无评论数")
            review_word = _first_non_empty(prop.get("reviewScoreWord"), default="")
            stars = _first_non_empty(prop.get("propertyClass"), default="未知星级")
            location = ""
            if prop.get("longitude") and prop.get("latitude"):
                location = f"{prop.get('longitude')},{prop.get('latitude')}"
            photos = prop.get("photoUrls") or []
            photo_url = photos[0] if photos else ""
            checkin = prop.get("checkin") or {}
            checkout = prop.get("checkout") or {}
            optional_parts = [
                f"评分 {review}/10" if review != "暂无评分" else "",
                f"评论 {review_count}" if review_count != "暂无评论数" else "",
                f"口碑 {review_word}" if review_word else "",
                f"星级 {stars}" if stars != "未知星级" else "",
                f"坐标 {location}" if location else "",
                f"入住 {checkin.get('fromTime', '')}-{checkin.get('untilTime', '')}".strip("-") if checkin else "",
                f"离店 {checkout.get('untilTime', '')}" if checkout else "",
                f"照片 {photo_url}" if photo_url else "",
            ]
            lines.append(
                f"{index}. {hotel_name}｜{area}｜"
                f"总价 {total_price}｜"
                + "｜".join(part for part in optional_parts if part)
            )
        result = "\n".join(lines)
        _log_tool_end("search_hotel_prices", start, result)
        return result
    except requests.HTTPError as exc:
        status_code = exc.response.status_code if exc.response is not None else ""
        body = exc.response.text if exc.response is not None else ""
        if status_code in {402, 403, 429} or _is_rapidapi_quota_error(body):
            reason = f"RapidAPI HTTP {status_code or '未知'}，疑似免费额度/频率上限已用尽。"
        else:
            reason = f"RapidAPI HTTP {status_code or '未知'}：{body[:160]}"
        result = _format_amap_hotel_fallback(
            city,
            checkin_date,
            checkout_date,
            adults,
            rooms,
            limit,
            reason,
        )
        _log_tool_end("search_hotel_prices", start, result)
        return result
    except Exception as exc:
        reason = f"酒店价格查询异常：{exc}"
        result = _format_amap_hotel_fallback(
            city,
            checkin_date,
            checkout_date,
            adults,
            rooms,
            limit,
            reason,
        )
        _log_tool_end("search_hotel_prices", start, result)
        return result
