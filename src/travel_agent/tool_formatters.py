from __future__ import annotations

import time
import unicodedata


def _format_minutes(seconds: int | float | str) -> str:
    try:
        minutes = max(1, round(float(seconds) / 60))
    except (TypeError, ValueError):
        return "未知"
    if minutes >= 60:
        hours = minutes // 60
        rest = minutes % 60
        return f"{hours}小时{rest}分钟" if rest else f"{hours}小时"
    return f"{minutes}分钟"

def _format_km(meters: int | float | str) -> str:
    try:
        km = float(meters) / 1000
    except (TypeError, ValueError):
        return "未知"
    return f"{km:.1f}公里"

def _format_route_steps(steps: list[dict], limit: int = 6) -> str:
    items = []
    for step in steps[:limit]:
        instruction = _first_non_empty(step.get("instruction"), step.get("road"), default="")
        distance = step.get("distance")
        if instruction:
            items.append(f"{instruction}（{_format_km(distance)}）" if distance else instruction)
    return "；".join(items) if items else "未返回详细步骤"

def _format_distance_matrix_type(travel_type: str) -> tuple[str, int]:
    normalized = str(travel_type or "driving").strip().lower()
    if normalized in {"walking", "walk", "步行"}:
        return "步行", 3
    if normalized in {"straight", "linear", "distance", "直线"}:
        return "直线距离", 0
    return "驾车", 1

def _traffic_status_label(value: object) -> str:
    text = _poi_scalar(value, "未知")
    return {
        "0": "未知",
        "1": "畅通",
        "2": "缓行",
        "3": "拥堵",
        "4": "严重拥堵",
    }.get(text, text)

def _poi_scalar(value: object, default: str = "") -> str:
    if value is None or value == [] or value == {}:
        return default
    if isinstance(value, list):
        return str(value[0]) if value else default
    return str(value)

def _format_transit_cost(cost: object) -> str:
    value = _poi_scalar(cost, "")
    if not value:
        return "未知"
    return value if value.endswith("元") else f"{value}元"

def _format_transit_segment(segment: dict) -> str:
    bus_info = segment.get("bus") or {}
    buslines = bus_info.get("buslines") or []
    if buslines:
        line = buslines[0]
        name = _poi_scalar(line.get("name"), "未知线路")
        departure = _poi_scalar(line.get("departure_stop", {}).get("name"), "未知上车站")
        arrival = _poi_scalar(line.get("arrival_stop", {}).get("name"), "未知下车站")
        stops = _poi_scalar(line.get("via_num"), "未知")
        return f"{name}：{departure} → {arrival}，约{stops}站"

    walking = segment.get("walking") or {}
    distance = walking.get("distance")
    if distance:
        return f"步行约{_format_km(distance)}"
    return "换乘步骤信息不完整"

def _transit_mode_label(transit: dict) -> str:
    names: list[str] = []
    for segment in transit.get("segments") or []:
        if not isinstance(segment, dict):
            continue
        buslines = (segment.get("bus") or {}).get("buslines") or []
        for line in buslines:
            name = _poi_scalar(line.get("name"), "")
            if name:
                names.append(name)
    has_rail = any("地铁" in name or "轨道交通" in name for name in names)
    has_bus = any("路" in name and "地铁" not in name and "轨道交通" not in name for name in names)
    if has_rail and has_bus:
        return "地铁+公交换乘"
    if has_rail:
        return "地铁优先"
    if has_bus:
        return "公交备选"
    return "公共交通"

def _format_poi_lines(title: str, pois: list[dict], limit: int) -> str:
    lines = ["数据源：高德地图", title]
    for index, poi in enumerate(pois[: max(1, min(int(limit), 20))], start=1):
        name = poi.get("name", "未知地点")
        poi_type = poi.get("type", "未知类型")
        address = poi.get("address") or "地址未提供"
        location = poi.get("location") or "坐标未知"
        tel = poi.get("tel") or "电话未提供"
        distance = poi.get("distance")
        biz_ext = poi.get("biz_ext") or {}
        rating = _poi_scalar(biz_ext.get("rating"), "暂无评分")
        cost = _poi_scalar(biz_ext.get("cost"), "暂无人均")
        opentime = _poi_scalar(biz_ext.get("opentime"), "营业时间未提供")
        photos = poi.get("photos") or []
        photo_url = ""
        if photos and isinstance(photos[0], dict):
            photo_url = photos[0].get("url") or ""

        optional_parts = [
            f"距离 {_format_km(distance)}" if distance else "",
            f"评分 {rating}" if rating != "暂无评分" else "",
            f"人均 {cost}元" if cost != "暂无人均" else "",
            f"营业时间 {opentime}" if opentime != "营业时间未提供" else "",
            f"照片 {photo_url}" if photo_url else "",
        ]
        optional_text = "；".join(part for part in optional_parts if part)
        lines.append(
            f"{index}. {name}；{poi_type}；{address}；坐标 {location}；电话 {tel}"
            + (f"；{optional_text}" if optional_text else "")
        )
    return "\n".join(lines)

def _first_non_empty(*values: object, default: str = "未知") -> str:
    for value in values:
        text = _poi_scalar(value, "").strip()
        if text:
            return text
    return default

_CURRENCY_SYMBOL: dict[str, str] = {
    "CNY": "¥",
    "USD": "$",
    "EUR": "€",
    "JPY": "¥",
    "GBP": "£",
    "HKD": "HK$",
    "KRW": "₩",
    "TWD": "NT$",
    "RMB": "¥",
}


def _format_money(value: object, currency: str = "CNY") -> str:
    try:
        amount = float(value)
    except (TypeError, ValueError):
        return "价格未知"
    amount_text = str(round(amount)) if amount >= 100 else f"{amount:.2f}".rstrip("0").rstrip(".")
    symbol = _CURRENCY_SYMBOL.get(str(currency).upper(), str(currency).upper())
    return f"{symbol}{amount_text}"


def _normalize_price_display(text: str) -> str:
    """将价格文本中的 ISO 货币代码替换为用户友好的符号。"""
    import re

    for code, symbol in _CURRENCY_SYMBOL.items():
        text = re.sub(rf"\b{re.escape(code)}\s*", symbol, text, flags=re.IGNORECASE)
    return text


def _format_flight_time(value: object) -> str:
    text = _poi_scalar(value, "")
    if not text:
        return "未知"
    return text.replace("T", " ").split("+")[0]

def _format_aviationstack_flights(
    flights: list[dict],
    dep_iata: str,
    arr_iata: str,
    limit: int,
    note: str = "",
) -> str:
    lines = [
        "数据源：Aviationstack",
        "说明：该接口提供航班时刻/状态信息，不提供机票价格；票价需到航司或 OTA 平台另查。",
        f"查询机场：{dep_iata or '不限'} → {arr_iata or '不限'}",
    ]
    if note:
        lines.append(note)
    for index, flight in enumerate(flights[: max(1, min(int(limit), 20))], start=1):
        dep = flight.get("departure") or {}
        arr = flight.get("arrival") or {}
        airline_info = flight.get("airline") or {}
        flight_info = flight.get("flight") or {}
        flight_code = _first_non_empty(flight_info.get("iata"), flight_info.get("icao"), flight_info.get("number"))
        airline_name = _first_non_empty(airline_info.get("name"), airline_info.get("iata"), default="未知航空公司")
        dep_airport = _first_non_empty(dep.get("airport"), dep.get("iata"), default="未知出发机场")
        arr_airport = _first_non_empty(arr.get("airport"), arr.get("iata"), default="未知到达机场")
        dep_time = _format_flight_time(dep.get("scheduled") or dep.get("estimated") or dep.get("actual"))
        arr_time = _format_flight_time(arr.get("scheduled") or arr.get("estimated") or arr.get("actual"))
        status = _first_non_empty(flight.get("flight_status"), default="未知状态")
        terminal_gate = []
        if dep.get("terminal"):
            terminal_gate.append(f"出发航站楼 {dep.get('terminal')}")
        if dep.get("gate"):
            terminal_gate.append(f"登机口 {dep.get('gate')}")
        if arr.get("terminal"):
            terminal_gate.append(f"到达航站楼 {arr.get('terminal')}")
        lines.append(
            f"{index}. {airline_name} {flight_code}；"
            f"{dep_airport}({dep.get('iata', '未知')}) → {arr_airport}({arr.get('iata', '未知')})；"
            f"计划 {dep_time} → {arr_time}；状态 {status}"
            + (f"；{'，'.join(terminal_gate)}" if terminal_gate else "")
        )
    return "\n".join(lines)

def _safe_text(value: object, limit: int | None = None) -> str:
    text = str(value or "")
    text = text.replace("\ufffd", "")
    text = "".join(ch for ch in text if ch in "\n\r\t" or unicodedata.category(ch)[0] != "C")
    if limit is not None and len(text) > limit:
        return text[:limit].rstrip() + "..."
    return text

def _summarize_letsfg_error(text: str) -> str:
    clean = _safe_text(text, 1200)
    lowered = clean.lower()
    has_api_key_msg = "no letsfg_api_key" in lowered or "let's fg api key" in lowered
    has_browser_wait = "waiting for browser slot" in lowered
    has_timeout = "timeout" in lowered
    # Both no-API-key and all-browsers-busy: the common real-world failure mode
    if has_api_key_msg and has_browser_wait:
        return "未配置 LetsFG 云端 API Key 且本地浏览器连接器全部占满，未在限定时间内返回票价。"
    if has_api_key_msg:
        return "未配置 LetsFG 云端 API Key，本地搜索未返回票价。"
    if has_browser_wait:
        return "本地浏览器连接器全部占满，未在限定时间内返回票价。"
    if has_timeout:
        return "本地搜索超过限定时间。"
    # Don't leak raw connector logs; return a clean generic message
    return "本地搜索未返回可解析的机票结果。"

def _log_tool_start(name: str, **kwargs: object) -> float:
    start = time.time()
    print(f"\n{'=' * 20} 开始调用工具: {name} {'=' * 20}")
    print(f"工具调用时间戳: {start:.2f}")
    for key, value in kwargs.items():
        print(_safe_text(f"- {key}: {value}"))
    print("=" * 70)
    return start

def _log_tool_end(name: str, start: float, result: str) -> None:
    elapsed = time.time() - start
    print(f"\n工具 {name} 调用完成，耗时 {elapsed:.2f} 秒")
    print(_safe_text(result))
