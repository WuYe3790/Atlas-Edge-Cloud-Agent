from __future__ import annotations

import re

import requests
from langchain_core.tools import tool

from travel_agent.tool_clients import AMAP_BASE_URL, _amap_key, _request_json
from travel_agent.tool_formatters import (
    _format_distance_matrix_type,
    _format_km,
    _format_minutes,
    _format_route_steps,
    _format_transit_cost,
    _format_transit_segment,
    _log_tool_end,
    _log_tool_start,
    _traffic_status_label,
    _transit_mode_label,
)
from travel_agent.tool_maps import _amap_geocode, _amap_location, _city_name_from_geocode, _resolve_route_points


@tool
def get_transport_advice(origin: str, destination: str) -> str:
    """获取出发地与目的地之间的驾车路线信息（距离、耗时、过路费），用于辅助交通决策。

    注意：此工具只提供驾车路线数据，不包含火车票或高铁票信息。
    如需查询火车票/高铁票的具体车次、时刻和余票，必须另外调用 search_train_tickets 工具。"""
    start = _log_tool_start("get_transport_advice", origin=origin, destination=destination)
    origin_info = _amap_location(origin)
    destination_info = _amap_location(destination)
    if origin_info and destination_info and _amap_key():
        origin_location, origin_address = origin_info
        destination_location, destination_address = destination_info
        try:
            data = _request_json(
                f"{AMAP_BASE_URL}/direction/driving",
                {
                    "key": _amap_key(),
                    "origin": origin_location,
                    "destination": destination_location,
                    "extensions": "base",
                    "strategy": 10,
                    "output": "JSON",
                },
            )
            route = data.get("route") or {}
            paths = route.get("paths") or []
            if data.get("status") == "1" and paths:
                path = paths[0]
                distance = _format_km(path.get("distance", ""))
                duration = _format_minutes(path.get("duration", ""))
                taxi_cost = route.get("taxi_cost")
                tolls = path.get("tolls")
                result = (
                    f"数据源：高德地图\n"
                    f"路线：{origin_address} → {destination_address}\n"
                    f"驾车距离：{distance}\n"
                    f"预计驾车耗时：{duration}\n"
                    f"高速/过路费估算：{tolls or '未知'}元\n"
                    f"出租车费用估算：{taxi_cost or '未知'}元\n"
                    "交通建议：\n"
                    "1. 若两地距离较远，优先比较高铁和飞机；高铁适合稳定出行，飞机适合长距离且时间紧张的行程。\n"
                    "2. 若驾车距离在300公里以内，自驾/包车可作为重点备选；超过300公里建议优先公共交通。\n"
                    "3. 到达目的地后，景区密集区域优先地铁、公交、步行或网约车组合。"
                )
                _log_tool_end("get_transport_advice", start, result)
                return result
        except Exception as exc:
            print(f"高德交通查询失败，回退通用建议：{exc}")

    result = (
        f"从{origin}到{destination}的交通建议：\n"
        "1. 跨城市优先比较高铁和飞机：高铁稳定、进出站便利；飞机适合距离较远且时间紧张的情况。\n"
        "2. 到达目的地后，市区内优先使用地铁、公交和步行，景区密集区域可选择骑行。\n"
        "3. 若遇到降雨、大风或携带较多行李，建议在景区间使用网约车补充。"
    )
    _log_tool_end("get_transport_advice", start, result)
    return result

@tool
def get_public_transit_plan(
    origin: str,
    destination: str,
    origin_city: str = "",
    destination_city: str = "",
    limit: int = 3,
) -> str:
    """使用高德地图查询公交/地铁换乘方案，适合市内或邻近城市景点、车站、酒店之间的公共交通规划。
    Args:
        origin: 出发地点，例如 "杭州东站"、"西湖"。
        destination: 到达地点，例如 "灵隐寺"、"武林广场"。
        origin_city: 出发城市，可选；地点名称模糊时建议填写。
        destination_city: 到达城市，可选；不填时默认使用出发城市或地理编码结果。
        limit: 返回方案数量，建议 1-5。
    """
    start = _log_tool_start(
        "get_public_transit_plan",
        origin=origin,
        destination=destination,
        origin_city=origin_city,
        destination_city=destination_city,
        limit=limit,
    )
    key = _amap_key()
    if not key:
        result = "公共交通查询不可用：未配置 AMAP_API_KEY。"
        _log_tool_end("get_public_transit_plan", start, result)
        return result

    try:
        origin_info = _amap_geocode(origin, city=origin_city)
        destination_info = _amap_geocode(destination, city=destination_city or origin_city)
        if not origin_info or not destination_info:
            result = f"公共交通查询失败：未能解析 {origin} 或 {destination} 的坐标。"
            _log_tool_end("get_public_transit_plan", start, result)
            return result

        origin_location = origin_info.get("location", "")
        destination_location = destination_info.get("location", "")
        resolved_origin_city = _city_name_from_geocode(origin_info, origin_city)
        resolved_destination_city = _city_name_from_geocode(destination_info, destination_city or resolved_origin_city)

        data = _request_json(
            f"{AMAP_BASE_URL}/direction/transit/integrated",
            {
                "key": key,
                "origin": origin_location,
                "destination": destination_location,
                "city": resolved_origin_city,
                "cityd": resolved_destination_city,
                "strategy": 0,
                "nightflag": 0,
                "extensions": "base",
                "output": "JSON",
            },
        )
        route = data.get("route") or {}
        transits = route.get("transits") or []
        if data.get("status") != "1" or not transits:
            result = (
                f"未查询到 {origin} 到 {destination} 的公共交通方案。"
                f"高德返回信息：{data.get('info', '无详细说明')}"
            )
            _log_tool_end("get_public_transit_plan", start, result)
            return result

        lines = [
            "数据源：高德地图公交/地铁路线规划",
            f"路线：{origin_info.get('formatted_address', origin)} → {destination_info.get('formatted_address', destination)}",
            f"查询城市：{resolved_origin_city} → {resolved_destination_city}",
        ]
        for index, transit in enumerate(transits[: max(1, min(int(limit), 5))], start=1):
            mode_label = _transit_mode_label(transit)
            duration = _format_minutes(transit.get("duration", ""))
            walking_distance = _format_km(transit.get("walking_distance", ""))
            cost = _format_transit_cost(transit.get("cost", ""))
            segments = [
                _format_transit_segment(segment)
                for segment in (transit.get("segments") or [])
                if isinstance(segment, dict)
            ]
            segment_text = "；".join(segment for segment in segments if segment) or "换乘步骤未提供"
            lines.append(
                f"{index}. {mode_label}；预计耗时 {duration}；步行 {walking_distance}；费用 {cost}；路线：{segment_text}"
            )
        result = "\n".join(lines)
        _log_tool_end("get_public_transit_plan", start, result)
        return result
    except Exception as exc:
        result = f"公共交通查询异常：{exc}"
        _log_tool_end("get_public_transit_plan", start, result)
        return result

@tool
def get_walking_route(origin: str, destination: str, city: str = "") -> str:
    """使用高德地图查询两点之间的步行路线，适合市内短距离景点、地铁站、酒店之间的步行可达性判断。

    Args:
        origin: 出发地点，例如 "宁波大学"、"天一阁"。
        destination: 到达地点，例如 "宁波大学地铁站"、"鼓楼"。
        city: 地点所在城市，可选；地点名称模糊时建议填写。
    """
    start = _log_tool_start("get_walking_route", origin=origin, destination=destination, city=city)
    key = _amap_key()
    if not key:
        result = "步行路线查询不可用：未配置 AMAP_API_KEY。"
        _log_tool_end("get_walking_route", start, result)
        return result

    try:
        points = _resolve_route_points(origin, destination, city=city)
        if not points:
            result = f"步行路线查询失败：未能解析 {origin} 或 {destination} 的坐标。"
            _log_tool_end("get_walking_route", start, result)
            return result
        origin_location, origin_address, destination_location, destination_address = points
        data = _request_json(
            f"{AMAP_BASE_URL}/direction/walking",
            {
                "key": key,
                "origin": origin_location,
                "destination": destination_location,
                "output": "JSON",
            },
        )
        paths = (data.get("route") or {}).get("paths") or []
        if data.get("status") != "1" or not paths:
            result = f"未查询到 {origin} 到 {destination} 的步行路线。高德返回信息：{data.get('info', '无详细说明')}"
            _log_tool_end("get_walking_route", start, result)
            return result

        path = paths[0]
        distance = _format_km(path.get("distance", ""))
        duration = _format_minutes(path.get("duration", ""))
        steps = _format_route_steps(path.get("steps") or [])
        result = (
            "数据源：高德地图步行路线规划\n"
            f"路线：{origin_address} -> {destination_address}\n"
            f"步行距离：{distance}\n"
            f"预计步行耗时：{duration}\n"
            f"主要步骤：{steps}\n"
            "建议：若步行距离超过 2 公里，建议同时比较骑行、公交/地铁或网约车。"
        )
        _log_tool_end("get_walking_route", start, result)
        return result
    except Exception as exc:
        result = f"步行路线查询异常：{exc}"
        _log_tool_end("get_walking_route", start, result)
        return result

@tool
def get_bicycling_route(origin: str, destination: str, city: str = "") -> str:
    """使用高德地图查询两点之间的骑行路线，适合市内 1-8 公里短途移动、共享单车或骑行体验判断。

    Args:
        origin: 出发地点，例如 "宁波大学"、"天一阁"。
        destination: 到达地点，例如 "宁波老外滩"、"鼓楼"。
        city: 地点所在城市，可选；地点名称模糊时建议填写。
    """
    start = _log_tool_start("get_bicycling_route", origin=origin, destination=destination, city=city)
    key = _amap_key()
    if not key:
        result = "骑行路线查询不可用：未配置 AMAP_API_KEY。"
        _log_tool_end("get_bicycling_route", start, result)
        return result

    try:
        points = _resolve_route_points(origin, destination, city=city)
        if not points:
            result = f"骑行路线查询失败：未能解析 {origin} 或 {destination} 的坐标。"
            _log_tool_end("get_bicycling_route", start, result)
            return result
        origin_location, origin_address, destination_location, destination_address = points
        data = _request_json(
            "https://restapi.amap.com/v4/direction/bicycling",
            {
                "key": key,
                "origin": origin_location,
                "destination": destination_location,
            },
        )
        paths = ((data.get("data") or {}).get("paths") or (data.get("route") or {}).get("paths") or [])
        ok = data.get("errcode") in (None, 0) or data.get("status") == "1"
        if not ok or not paths:
            message = data.get("errmsg") or data.get("info") or "无详细说明"
            result = f"未查询到 {origin} 到 {destination} 的骑行路线。高德返回信息：{message}"
            _log_tool_end("get_bicycling_route", start, result)
            return result

        path = paths[0]
        distance = _format_km(path.get("distance", ""))
        duration = _format_minutes(path.get("duration", ""))
        steps = _format_route_steps(path.get("steps") or [])
        result = (
            "数据源：高德地图骑行路线规划\n"
            f"路线：{origin_address} -> {destination_address}\n"
            f"骑行距离：{distance}\n"
            f"预计骑行耗时：{duration}\n"
            f"主要步骤：{steps}\n"
            "建议：骑行前结合天气、空气质量和道路条件；雨天、夜间或携带行李时优先公交/地铁或网约车。"
        )
        _log_tool_end("get_bicycling_route", start, result)
        return result
    except requests.HTTPError as exc:
        status_code = exc.response.status_code if exc.response is not None else ""
        result = f"骑行路线查询暂不可用：HTTP {status_code or '未知'}。"
        _log_tool_end("get_bicycling_route", start, result)
        return result
    except Exception as exc:
        result = f"骑行路线查询异常：{exc}"
        _log_tool_end("get_bicycling_route", start, result)
        return result

@tool
def get_route_distance_matrix(origins: str, destination: str, city: str = "", travel_type: str = "driving") -> str:
    """使用高德地图距离测量 API 比较多个出发点到同一目的地的距离/耗时。

    适合回答"哪个景点离酒店近"、"从多个候选住宿点到车站多久"、"多个景点到机场的驾车距离"等问题。

    Args:
        origins: 多个出发地点，用竖线分隔，例如 "宁波大学|天一阁·月湖|宁波老外滩"。
        destination: 目的地，例如 "宁波站"。
        city: 地点所在城市，可选；地点名称模糊时建议填写。
        travel_type: driving/驾车、walking/步行、straight/直线，默认 driving。
    """
    start = _log_tool_start(
        "get_route_distance_matrix",
        origins=origins,
        destination=destination,
        city=city,
        travel_type=travel_type,
    )
    key = _amap_key()
    if not key:
        result = "距离矩阵查询不可用：未配置 AMAP_API_KEY。"
        _log_tool_end("get_route_distance_matrix", start, result)
        return result

    try:
        # Do not split on comma because coordinates use "lng,lat".
        origin_names = [item.strip() for item in re.split(r"[|｜;；\n]+", origins or "") if item.strip()]
        if not origin_names:
            result = "距离矩阵查询失败：请提供至少一个出发地点。"
            _log_tool_end("get_route_distance_matrix", start, result)
            return result
        origin_infos = []
        for name in origin_names[:10]:
            info = _amap_geocode(name, city=city)
            if info and info.get("location"):
                origin_infos.append((name, info))
        destination_info = _amap_geocode(destination, city=city)
        if not origin_infos or not destination_info or not destination_info.get("location"):
            result = f"距离矩阵查询失败：未能解析出发点或目的地 {destination} 的坐标。"
            _log_tool_end("get_route_distance_matrix", start, result)
            return result

        mode_label, type_code = _format_distance_matrix_type(travel_type)
        data = _request_json(
            f"{AMAP_BASE_URL}/distance",
            {
                "key": key,
                "origins": "|".join(info["location"] for _, info in origin_infos),
                "destination": destination_info["location"],
                "type": type_code,
                "output": "JSON",
            },
        )
        results = data.get("results") or []
        if data.get("status") != "1" or not results:
            result = f"未查询到距离矩阵。高德返回信息：{data.get('info', '无详细说明')}"
            _log_tool_end("get_route_distance_matrix", start, result)
            return result

        lines = [
            "数据源：高德地图距离测量",
            f"目的地：{destination_info.get('formatted_address', destination)}",
            f"测算方式：{mode_label}",
        ]
        for item in results:
            try:
                origin_index = int(item.get("origin_id", 1)) - 1
            except (TypeError, ValueError):
                origin_index = 0
            origin_name, origin_info = origin_infos[origin_index] if 0 <= origin_index < len(origin_infos) else origin_infos[0]
            distance = _format_km(item.get("distance", ""))
            duration = _format_minutes(item.get("duration", "")) if item.get("duration") else "未返回"
            lines.append(
                f"- {origin_name}（{origin_info.get('formatted_address', origin_name)}） -> {destination}：{distance}，预计耗时 {duration}"
            )
        result = "\n".join(lines)
        _log_tool_end("get_route_distance_matrix", start, result)
        return result
    except Exception as exc:
        result = f"距离矩阵查询异常：{exc}"
        _log_tool_end("get_route_distance_matrix", start, result)
        return result

@tool
def get_traffic_status(place: str, city: str = "", radius: int = 3000) -> str:
    """使用高德地图查询某地点周边实时交通态势，适合自驾、打车、机场/车站接驳和城市拥堵风险判断。

    Args:
        place: 需要查询路况的中心地点，例如 "宁波大学"、"郑州东站"、"杭州西湖"。
        city: 地点所在城市，可选；地点名称模糊时建议填写。
        radius: 查询半径，单位米，建议 1000-5000。
    """
    start = _log_tool_start("get_traffic_status", place=place, city=city, radius=radius)
    key = _amap_key()
    if not key:
        result = "实时路况查询不可用：未配置 AMAP_API_KEY。"
        _log_tool_end("get_traffic_status", start, result)
        return result

    try:
        center_info = _amap_geocode(place or city, city=city)
        if not center_info or not center_info.get("location"):
            result = f"实时路况查询失败：未能解析 {place or city} 的坐标。"
            _log_tool_end("get_traffic_status", start, result)
            return result

        safe_radius = max(500, min(int(radius), 5000))
        data = _request_json(
            f"{AMAP_BASE_URL}/traffic/status/circle",
            {
                "key": key,
                "location": center_info["location"],
                "radius": safe_radius,
                "extensions": "all",
                "output": "JSON",
            },
        )
        traffic = data.get("trafficinfo") or {}
        if data.get("status") != "1" or not traffic:
            result = f"未查询到 {place} 周边实时路况。高德返回信息：{data.get('info', '无详细说明')}"
            _log_tool_end("get_traffic_status", start, result)
            return result

        evaluation = traffic.get("evaluation") or {}
        roads = traffic.get("roads") or []
        lines = [
            "数据源：高德地图实时交通态势",
            f"中心地点：{center_info.get('formatted_address', place or city)}",
            f"查询半径：{safe_radius}米",
            f"整体路况：{_traffic_status_label(evaluation.get('status', '未知'))}",
            f"路况说明：{evaluation.get('description', '无说明')}",
        ]
        if roads:
            lines.append("周边重点道路：")
            for index, road in enumerate(roads[:6], start=1):
                lines.append(
                    f"{index}. {road.get('name', '未知道路')}："
                    f"{_traffic_status_label(road.get('status', '未知'))}，速度 {road.get('speed', '未知')} km/h，"
                    f"方向 {road.get('direction', '未知')}"
                )
        result = "\n".join(lines)
        _log_tool_end("get_traffic_status", start, result)
        return result
    except Exception as exc:
        result = f"实时路况查询异常：{exc}"
        _log_tool_end("get_traffic_status", start, result)
        return result
