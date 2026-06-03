from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta

import requests
from langchain_core.tools import tool

from travel_agent.tool_clients import (
    AVIATIONSTACK_BASE_URL,
    _aviationstack_key,
    _get_env_key,
    _request_json,
)
from travel_agent.tool_data import AIRPORT_IATA_BY_CITY
from travel_agent.tool_formatters import (
    _first_non_empty,
    _format_aviationstack_flights,
    _format_minutes,
    _format_money,
    _log_tool_end,
    _log_tool_start,
    _normalize_price_display,
    _poi_scalar,
    _summarize_letsfg_error,
)

DEFAULT_DATE = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d")


def _normalize_airport_iata(value: str) -> str:
    text = str(value or "").strip().upper()
    if re.fullmatch(r"[A-Z]{3}", text):
        return text
    cleaned = str(value or "").strip()
    for suffix in ("市", "机场", "国际机场", "机场T1", "机场T2", "机场T3"):
        cleaned = cleaned.replace(suffix, "")
    return AIRPORT_IATA_BY_CITY.get(cleaned, text)

def _letsfg_search_timeout() -> int:
    try:
        return max(5, min(int(_get_env_key("LETSFG_SEARCH_TIMEOUT") or 600), 600))
    except ValueError:
        return 600

def _letsfg_search_mode() -> str:
    return (_get_env_key("LETSFG_SEARCH_MODE") or "fast").strip() or "fast"

def _letsfg_max_browsers() -> int:
    try:
        return max(1, min(int(_get_env_key("LETSFG_MAX_BROWSERS") or 3), 6))
    except ValueError:
        return 3

def _letsfg_max_stopovers() -> int:
    try:
        return max(0, min(int(_get_env_key("LETSFG_MAX_STOPOVERS") or 0), 2))
    except ValueError:
        return 0

def _search_letsfg_local(
    dep_iata: str,
    arr_iata: str,
    date: str,
    limit: int,
    adults: int = 1,
    currency: str = "CNY",
) -> tuple[str, bool]:
    if not dep_iata or not arr_iata or not date:
        return "LetsFG 查询跳过：缺少出发机场、到达机场或日期。", False

    script = r"""
import asyncio
import json
import sys
from letsfg.local import search_local

origin, destination, date_from, limit, adults, currency, mode, max_browsers, max_stopovers = sys.argv[1:10]

async def main():
    result = await search_local(
        origin,
        destination,
        date_from,
        adults=int(adults),
        currency=currency,
        limit=int(limit),
        max_browsers=int(max_browsers),
        max_stopovers=int(max_stopovers),
        mode=mode,
    )
    print(json.dumps(result, ensure_ascii=False, default=str))

asyncio.run(main())
"""
    try:
        completed = subprocess.run(
            [
                sys.executable,
                "-c",
                script,
                dep_iata,
                arr_iata,
                date,
                str(max(1, min(int(limit), 10))),
                str(max(1, int(adults))),
                currency,
                _letsfg_search_mode(),
                str(_letsfg_max_browsers()),
                str(_letsfg_max_stopovers()),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=_letsfg_search_timeout(),
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        )
    except FileNotFoundError:
        return "LetsFG 未返回实时票价：当前 Python 环境未安装 letsfg，已回退到 Aviationstack。", False
    except subprocess.TimeoutExpired:
        return f"LetsFG 未在 {_letsfg_search_timeout()} 秒内返回实时票价，已回退到 Aviationstack。", False

    try:
        data = json.loads(completed.stdout.strip().splitlines()[-1])
    except (json.JSONDecodeError, IndexError):
        if completed.returncode != 0:
            error = _summarize_letsfg_error(f"{completed.stderr}\n{completed.stdout}")
            return f"LetsFG 未返回实时票价：{error} 已回退到 Aviationstack。", False
        return "LetsFG 未返回实时票价：未能解析本地搜索结果，已回退到 Aviationstack。", False

    offers = data.get("offers") or []
    if not offers:
        return "LetsFG 未查询到可用机票报价，已回退到 Aviationstack。", False
    return _format_letsfg_offers(data, dep_iata, arr_iata, limit), True

def _segment_time(value: object) -> str:
    text = _poi_scalar(value, "")
    if not text:
        return "未知"
    return text.replace("T", " ").split("+")[0].replace("Z", "")

def _format_letsfg_offers(data: dict, dep_iata: str, arr_iata: str, limit: int) -> str:
    offers = data.get("offers") or []
    currency = _first_non_empty(data.get("currency"), default="CNY")
    lines = [
        "数据源：LetsFG 本地实时机票搜索",
        f"查询航线：{dep_iata} → {arr_iata}",
        f"报价数量：{data.get('total_results', len(offers))}",
        "说明：价格来自 LetsFG 本地连接器实时搜索，库存、税费、行李和最终支付价仍以航司/购票页面确认结果为准。",
    ]
    pricing_note = _poi_scalar(data.get("pricing_note"), "")
    if pricing_note:
        lines.append(f"价格说明：{pricing_note}")

    sorted_offers = sorted(
        offers,
        key=lambda item: float(item.get("price") or 10**12),
    )[: max(1, min(int(limit), 10))]
    for index, offer in enumerate(sorted_offers, start=1):
        outbound = offer.get("outbound") or {}
        segments = outbound.get("segments") or []
        first = segments[0] if segments else {}
        last = segments[-1] if segments else {}
        airlines = offer.get("airlines") or []
        airline = _first_non_empty(offer.get("owner_airline"), ", ".join(airlines), first.get("airline_name"), default="未知航司")
        flight_no = " + ".join(
            _first_non_empty(seg.get("flight_no"), seg.get("airline"), default="").strip()
            for seg in segments
            if _first_non_empty(seg.get("flight_no"), seg.get("airline"), default="").strip()
        )
        route = " → ".join([segments[0].get("origin", dep_iata), *[seg.get("destination", "") for seg in segments]]) if segments else f"{dep_iata} → {arr_iata}"
        price_text = _first_non_empty(offer.get("price_formatted"), default="")
        if not price_text:
            price_text = _format_money(offer.get("price"), _first_non_empty(offer.get("currency"), currency, default="CNY"))
        price_text = _normalize_price_display(price_text)
        departure_time = _segment_time(first.get("departure"))
        arrival_time = _segment_time(last.get("arrival"))
        duration = _format_minutes(outbound.get("total_duration_seconds") or 0)
        stopovers = outbound.get("stopovers")
        seats = offer.get("availability_seats")
        booking_url = _poi_scalar(offer.get("booking_url"), "")
        extras = []
        if flight_no:
            extras.append(f"航班 {flight_no}")
        if stopovers is not None:
            extras.append(f"中转 {stopovers} 次")
        if seats:
            extras.append(f"余位 {seats}")
        if booking_url:
            extras.append(f"预订链接 {booking_url}")
        lines.append(
            f"{index}. {airline}｜{route}｜{departure_time} → {arrival_time}｜"
            f"耗时 {duration}｜票价 {price_text}"
            + (f"｜{'；'.join(extras)}" if extras else "")
        )
    return "\n".join(lines)


@tool
def search_flight_options(
    departure: str = "",
    arrival: str = "",
    date: str = "",
    airline: str = "",
    flight_number: str = "",
    adults: int = 1,
    limit: int = 8,
) -> str:
    """优先使用 LetsFG 查询实时机票报价，失败或超时后回退 Aviationstack 航班时刻/状态。

    注意：LetsFG 本地实时搜索可能较慢；Aviationstack 只提供航班动态、机场、航空公司和计划/实际时刻信息，不提供机票价格。
    Args:
        departure: 出发机场 IATA 三字码或常见城市名，例如 "NGB"、"CGO"、"宁波"、"郑州"。
        arrival: 到达机场 IATA 三字码或常见城市名，例如 "HGH"、"成都"、"北京"。
        date: 可选，航班日期 YYYY-MM-DD。LetsFG 会按该日期搜索；Aviationstack 回退能力取决于账号套餐。
        airline: 可选，航空公司 IATA 代码，例如 "MU"、"CA"。
        flight_number: 可选，航班号数字部分，例如 MU2397 的 "2397"。
        adults: 成人乘客数，默认 1。
        limit: 返回结果数量，建议 3-10。
    """
    start = _log_tool_start(
        "search_flight_options",
        departure=departure,
        arrival=arrival,
        date=date,
        airline=airline,
        flight_number=flight_number,
        adults=adults,
        limit=limit,
    )
    dep_iata = _normalize_airport_iata(departure)
    arr_iata = _normalize_airport_iata(arrival)
    search_date = date or DEFAULT_DATE
    try:
        adults_count = max(1, min(int(adults), 9))
    except (TypeError, ValueError):
        adults_count = 1
    letsfg_result = ""
    if not airline and not flight_number:
        letsfg_result, letsfg_ok = _search_letsfg_local(dep_iata, arr_iata, search_date, limit, adults=adults_count)
        if letsfg_ok:
            _log_tool_end("search_flight_options", start, letsfg_result)
            return letsfg_result

    key = _aviationstack_key()
    if not key:
        result = (
            f"{letsfg_result}\n\n"
            "Aviationstack 回退不可用：未配置 AVIATIONSTACK_API_KEY。"
        ).strip()
        _log_tool_end("search_flight_options", start, result)
        return result

    params: dict[str, object] = {
        "access_key": key,
        "limit": max(1, min(int(limit), 20)),
    }
    if dep_iata:
        params["dep_iata"] = dep_iata
    if arr_iata:
        params["arr_iata"] = arr_iata
    if search_date:
        params["flight_date"] = search_date
    if airline:
        params["airline_iata"] = airline.strip().upper()
    if flight_number:
        params["flight_number"] = flight_number.strip().upper().removeprefix((airline or "").upper())

    try:
        data = _request_json(f"{AVIATIONSTACK_BASE_URL}/flights", params=params, timeout=15)
        if data.get("error"):
            error = data["error"]
            result = f"航班查询失败：{error.get('code', 'unknown')} - {error.get('message', error)}"
            _log_tool_end("search_flight_options", start, result)
            return result

        flights = data.get("data") or []
        if not flights:
            result = "未查询到符合条件的航班。可尝试只填写出发/到达机场三字码，或换用当天/近期日期。"
            _log_tool_end("search_flight_options", start, result)
            return result

        result = _format_aviationstack_flights(flights, dep_iata, arr_iata, limit)
        if letsfg_result:
            result = f"{letsfg_result}\n\nAviationstack 回退结果：\n{result}"
        _log_tool_end("search_flight_options", start, result)
        return result
    except requests.HTTPError as exc:
        status_code = exc.response.status_code if exc.response is not None else ""
        if status_code == 403 and date:
            try:
                fallback_params = dict(params)
                fallback_params.pop("flight_date", None)
                fallback_data = _request_json(f"{AVIATIONSTACK_BASE_URL}/flights", params=fallback_params, timeout=15)
                flights = fallback_data.get("data") or []
                if flights:
                    result = _format_aviationstack_flights(
                        flights,
                        dep_iata,
                        arr_iata,
                        limit,
                        note=f"提示：当前 Aviationstack 账号不支持按指定日期 {search_date} 查询，已自动回退为近期/实时航班结果。",
                    )
                    if letsfg_result:
                        result = f"{letsfg_result}\n\nAviationstack 回退结果：\n{result}"
                    _log_tool_end("search_flight_options", start, result)
                    return result
            except Exception as fallback_exc:
                print(f"Aviationstack 日期查询失败后回退也失败：{fallback_exc}")
        result = f"{letsfg_result}\n\n航班查询暂不可用：HTTP {status_code or '未知'}。".strip()
        _log_tool_end("search_flight_options", start, result)
        return result
    except Exception as exc:
        result = f"{letsfg_result}\n\n航班查询异常：{exc}".strip()
        _log_tool_end("search_flight_options", start, result)
        return result
