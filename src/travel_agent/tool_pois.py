from __future__ import annotations

from langchain_core.tools import tool

from travel_agent.tool_clients import AMAP_BASE_URL, _amap_key, _request_json
from travel_agent.tool_formatters import (
    _format_poi_lines,
    _log_tool_end,
    _log_tool_start,
    _poi_scalar,
)
from travel_agent.tool_maps import _amap_geocode, _amap_marker_url


@tool
def search_travel_pois(city: str, keyword: str = "景点", limit: int = 8) -> str:
    """使用高德地图搜索目的地的景点、餐饮、商圈、酒店等 POI，用于生成更真实的行程推荐。

    Args:
        city: 查询城市，例如 "杭州"、"南京"。
        keyword: 搜索关键词，例如 "景点"、"博物馆"、"本地菜"、"酒店"、"商圈"。
        limit: 返回结果数量，建议 3-10。
    """
    start = _log_tool_start("search_travel_pois", city=city, keyword=keyword, limit=limit)
    key = _amap_key()
    if not key:
        result = "POI 查询不可用：未配置 AMAP_API_KEY。"
        _log_tool_end("search_travel_pois", start, result)
        return result

    try:
        data = _request_json(
            f"{AMAP_BASE_URL}/place/text",
            {
                "key": key,
                "keywords": keyword,
                "city": city,
                "citylimit": "true",
                "offset": max(1, min(int(limit), 20)),
                "page": 1,
                "extensions": "all",
                "output": "JSON",
            },
        )
        pois = data.get("pois") or []
        if data.get("status") != "1" or not pois:
            result = f"未在{city}找到与“{keyword}”相关的 POI。"
            _log_tool_end("search_travel_pois", start, result)
            return result

        lines = [f"数据源：高德地图", f"{city}“{keyword}”POI 推荐："]
        for index, poi in enumerate(pois[: max(1, min(int(limit), 20))], start=1):
            name = poi.get("name", "未知地点")
            poi_type = poi.get("type", "未知类型")
            address = poi.get("address") or "地址未提供"
            location = poi.get("location") or "坐标未知"
            tel = poi.get("tel") or "电话未提供"
            biz_ext = poi.get("biz_ext") or {}
            rating = _poi_scalar(biz_ext.get("rating"), "暂无评分")
            cost = _poi_scalar(biz_ext.get("cost"), "暂无人均")
            opentime = _poi_scalar(biz_ext.get("opentime"), "营业时间未提供")
            photos = poi.get("photos") or []
            photo_url = ""
            if photos and isinstance(photos[0], dict):
                photo_url = photos[0].get("url") or ""
            optional_parts = [
                f"评分 {rating}" if rating != "暂无评分" else "",
                f"人均 {cost}元" if cost != "暂无人均" else "",
                f"营业时间 {opentime}" if opentime != "营业时间未提供" else "",
                f"照片 {photo_url}" if photo_url else "",
            ]
            optional_text = "｜".join(part for part in optional_parts if part)
            lines.append(
                f"{index}. {name}｜{poi_type}｜{address}｜坐标 {location}｜电话 {tel}"
                + (f"｜{optional_text}" if optional_text else "")
            )
        result = "\n".join(lines)
        _log_tool_end("search_travel_pois", start, result)
        return result
    except Exception as exc:
        result = f"POI 查询异常：{exc}"
        _log_tool_end("search_travel_pois", start, result)
        return result


@tool
def search_nearby_pois(
    place: str,
    city: str = "",
    keyword: str = "餐饮",
    radius: int = 1500,
    limit: int = 8,
) -> str:
    """使用高德地图周边搜索查询某个景点、车站、酒店附近的餐饮、住宿、商圈或景点。
    Args:
        place: 中心地点，例如 "西湖"、"杭州东站"、"灵隐寺"。
        city: 中心地点所在城市，可选；地点名称模糊时建议填写。
        keyword: 周边搜索关键词，例如 "餐饮"、"酒店"、"咖啡"、"景点"、"地铁站"。
        radius: 搜索半径，单位米，建议 500-5000。
        limit: 返回结果数量，建议 3-10。
    """
    start = _log_tool_start(
        "search_nearby_pois",
        place=place,
        city=city,
        keyword=keyword,
        radius=radius,
        limit=limit,
    )
    key = _amap_key()
    if not key:
        result = "周边 POI 查询不可用：未配置 AMAP_API_KEY。"
        _log_tool_end("search_nearby_pois", start, result)
        return result

    try:
        center_info = _amap_geocode(place, city=city)
        if not center_info or not center_info.get("location"):
            result = f"周边 POI 查询失败：未能解析中心地点 {place}。"
            _log_tool_end("search_nearby_pois", start, result)
            return result

        safe_radius = max(100, min(int(radius), 50000))
        data = _request_json(
            f"{AMAP_BASE_URL}/place/around",
            {
                "key": key,
                "location": center_info["location"],
                "keywords": keyword,
                "radius": safe_radius,
                "offset": max(1, min(int(limit), 20)),
                "page": 1,
                "extensions": "all",
                "output": "JSON",
            },
        )
        pois = data.get("pois") or []
        if data.get("status") != "1" or not pois:
            result = (
                f"未在 {place} 周边 {safe_radius} 米内找到与“{keyword}”相关的 POI。"
                f"高德返回信息：{data.get('info', '无详细说明')}"
            )
            _log_tool_end("search_nearby_pois", start, result)
            return result

        title = (
            f"{center_info.get('formatted_address', place)} 周边 {safe_radius} 米"
            f"“{keyword}”推荐："
        )
        result = _format_poi_lines(title, pois, limit)
        _log_tool_end("search_nearby_pois", start, result)
        return result
    except Exception as exc:
        result = f"周边 POI 查询异常：{exc}"
        _log_tool_end("search_nearby_pois", start, result)
        return result


@tool
def get_place_location(place: str, city: str = "") -> str:
    """使用高德地图解析地点经纬度和标准地址，用于路线规划和地点核验。"""
    start = _log_tool_start("get_place_location", place=place, city=city)
    info = _amap_geocode(place, city=city)
    if not info:
        result = f"地点解析失败：未找到 {place}。"
        _log_tool_end("get_place_location", start, result)
        return result
    result = (
        "数据源：高德地图\n"
        f"查询地点：{place}\n"
        f"标准地址：{info.get('formatted_address', '未知')}\n"
        f"省市区：{info.get('province', '')}{info.get('city', '')}{info.get('district', '')}\n"
        f"经纬度：{info.get('location', '未知')}\n"
        f"匹配级别：{info.get('level', '未知')}"
    )
    _log_tool_end("get_place_location", start, result)
    return result


@tool
def get_map_marker_link(place: str, city: str = "") -> str:
    """生成高德地图地点标记链接，不暴露 API Key，适合在最终方案中给用户点击打开地点。

    Args:
        place: 地点名称，例如 "天一阁·月湖"、"宁波大学"。
        city: 地点所在城市，可选；地点名称模糊时建议填写。
    """
    start = _log_tool_start("get_map_marker_link", place=place, city=city)
    info = _amap_geocode(place, city=city)
    if not info or not info.get("location"):
        result = f"地图链接生成失败：未找到 {place} 的坐标。"
        _log_tool_end("get_map_marker_link", start, result)
        return result
    address = info.get("formatted_address") or place
    url = _amap_marker_url(info["location"], place)
    result = (
        "数据源：高德地图 URI\n"
        f"地点：{place}\n"
        f"标准地址：{address}\n"
        f"经纬度：{info.get('location', '未知')}\n"
        f"地图链接：{url}"
    )
    _log_tool_end("get_map_marker_link", start, result)
    return result
