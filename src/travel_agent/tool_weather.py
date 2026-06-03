from __future__ import annotations

from datetime import datetime, timedelta

import requests
from langchain_core.tools import tool

from travel_agent.tool_clients import AMAP_BASE_URL, _amap_key, _qweather_host, _qweather_key, _qweather_lookup, _qweather_request_json, _request_json
from travel_agent.tool_data import WEATHER_CODES
from travel_agent.tool_formatters import _first_non_empty, _log_tool_end, _log_tool_start, _poi_scalar
from travel_agent.tool_maps import _amap_geocode


DEFAULT_DATE = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d")


@tool
def get_weather_info(city: str, date: str = DEFAULT_DATE) -> str:
    """查询指定城市的实时天气信息，用于出行规划。

    Args:
        city: 城市名称，例如 "杭州"、"郑州"、"北京"。
        date: 行程日期，格式建议为 YYYY-MM-DD。该字段用于规划展示，天气数据为实时天气。
    """
    start = _log_tool_start("get_weather_info", city=city, date=date)

    try:
        qweather_key = _qweather_key()
        qweather_host = _qweather_host()
        if qweather_key and qweather_host:
            try:
                location = _qweather_lookup(city)
                if location:
                    location_id = location["id"]
                    city_name = location.get("name", city)
                    adm1 = location.get("adm1", "")
                    adm2 = location.get("adm2", "")
                    now_data, weather_source = _qweather_request_json(
                        f"https://{qweather_host}/v7/weather/now",
                        {"location": location_id, "lang": "zh", "unit": "m"},
                    )
                    now = now_data.get("now") or {}
                    daily_data, _ = _qweather_request_json(
                        f"https://{qweather_host}/v7/weather/3d",
                        {"location": location_id, "lang": "zh", "unit": "m"},
                    )
                    daily_items = daily_data.get("daily") or []
                    daily = next((item for item in daily_items if item.get("fxDate") == date), None)
                    if daily is None and daily_items:
                        daily = daily_items[0]

                    result = (
                        f"数据源：{weather_source}\n"
                        f"城市：{city_name}（{adm1}{adm2}）\n"
                        f"行程日期：{date}\n"
                        f"实时温度：{now.get('temp', '未知')}℃\n"
                        f"体感温度：{now.get('feelsLike', '未知')}℃\n"
                        f"天气状况：{now.get('text', '未知')}\n"
                        f"相对湿度：{now.get('humidity', '未知')}%\n"
                        f"风向风力：{now.get('windDir', '未知')} {now.get('windScale', '未知')}级\n"
                        f"风速：{now.get('windSpeed', '未知')} km/h\n"
                        f"能见度：{now.get('vis', '未知')} km\n"
                        f"气压：{now.get('pressure', '未知')} hPa"
                    )
                    if daily:
                        result += (
                            f"\n未来预报：{daily.get('fxDate', date)} "
                            f"{daily.get('textDay', '未知')}，"
                            f"{daily.get('tempMin', '未知')}℃-{daily.get('tempMax', '未知')}℃，"
                            f"降水概率 {daily.get('pop', '未知')}%"
                        )
                    _log_tool_end("get_weather_info", start, result)
                    return result
            except Exception as exc:
                print(f"和风天气查询失败，回退 Open-Meteo：{exc}")

        amap_info = _amap_geocode(city)
        if amap_info and _amap_key():
            try:
                adcode = amap_info.get("adcode")
                weather_data = _request_json(
                    f"{AMAP_BASE_URL}/weather/weatherInfo",
                    {"key": _amap_key(), "city": adcode, "extensions": "base", "output": "JSON"},
                )
                lives = weather_data.get("lives") or []
                if weather_data.get("status") == "1" and lives:
                    live = lives[0]
                    result = (
                        "数据源：高德地图天气\n"
                        f"城市：{live.get('province', '')}{live.get('city', city)}\n"
                        f"行程日期：{date}\n"
                        f"实时温度：{live.get('temperature', '未知')}℃\n"
                        f"天气状况：{live.get('weather', '未知')}\n"
                        f"相对湿度：{live.get('humidity', '未知')}%\n"
                        f"风向风力：{live.get('winddirection', '未知')}风 {live.get('windpower', '未知')}级\n"
                        f"发布时间：{live.get('reporttime', '未知')}"
                    )
                    _log_tool_end("get_weather_info", start, result)
                    return result
            except Exception as exc:
                print(f"高德天气查询失败，回退 Open-Meteo：{exc}")

        geo_resp = requests.get(
            "https://geocoding-api.open-meteo.com/v1/search",
            params={"name": city, "count": 1, "language": "zh", "format": "json"},
            timeout=10,
        )
        geo_resp.raise_for_status()
        geo_data = geo_resp.json()

        if not geo_data.get("results"):
            return f"天气查询失败：未找到城市 {city}"

        city_info = geo_data["results"][0]
        lat = city_info["latitude"]
        lon = city_info["longitude"]
        city_name = city_info.get("name", city)

        weather_resp = requests.get(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": lat,
                "longitude": lon,
                "current": [
                    "temperature_2m",
                    "relative_humidity_2m",
                    "apparent_temperature",
                    "weather_code",
                    "wind_speed_10m",
                    "pressure_msl",
                ],
                "timezone": "auto",
            },
            timeout=10,
        )
        weather_resp.raise_for_status()
        current = weather_resp.json()["current"]

        weather_desc = WEATHER_CODES.get(current["weather_code"], "未知")
        result = (
            f"城市：{city_name}\n"
            f"行程日期：{date}\n"
            f"实时温度：{current['temperature_2m']}℃\n"
            f"体感温度：{current['apparent_temperature']}℃\n"
            f"天气状况：{weather_desc}\n"
            f"相对湿度：{current['relative_humidity_2m']}%\n"
            f"风速：{current['wind_speed_10m']} km/h\n"
            f"气压：{current['pressure_msl']} hPa"
        )
        _log_tool_end("get_weather_info", start, result)
        return result
    except Exception as exc:
        result = f"天气查询异常：{exc}"
        _log_tool_end("get_weather_info", start, result)
        return result

@tool
def get_air_quality_info(city: str) -> str:
    """查询城市实时空气质量，用于判断是否适合户外步行、骑行、亲子或老人出行。

    Args:
        city: 城市名称，例如 "宁波"、"杭州"、"北京"。
    """
    start = _log_tool_start("get_air_quality_info", city=city)
    try:
        qweather_host = _qweather_host()
        location = _qweather_lookup(city)
        if not qweather_host or not location:
            result = "空气质量查询不可用：未配置和风天气 Key/Host，或未找到城市。"
            _log_tool_end("get_air_quality_info", start, result)
            return result

        lat = _poi_scalar(location.get("lat"), "")
        lon = _poi_scalar(location.get("lon"), "")
        if not lat or not lon:
            result = f"空气质量查询失败：和风天气未返回 {city} 的经纬度。"
            _log_tool_end("get_air_quality_info", start, result)
            return result

        try:
            air_data, air_source = _qweather_request_json(
                f"https://{qweather_host}/airquality/v1/current/{lat}/{lon}",
                {"lang": "zh"},
            )
            indexes = air_data.get("indexes") or []
            index = indexes[0] if indexes else {}
            pollutants = air_data.get("pollutants") or []
            pollutant_map = {
                str(item.get("code", "")).lower(): item
                for item in pollutants
                if item.get("code")
            }
            primary = index.get("primaryPollutant") or {}
            health = index.get("health") or {}
            lines = [
                f"数据源：{air_source} 空气质量 v1",
                f"城市：{location.get('name', city)}（{location.get('adm1', '')}{location.get('adm2', '')}）",
                f"AQI：{index.get('aqiDisplay', index.get('aqi', '未知'))}",
                f"空气质量等级：{index.get('category', '未知')}",
                f"首要污染物：{primary.get('name') or primary.get('fullName') or '无或未知'}",
            ]
            if health:
                advice = health.get("advice", "未知")
                if isinstance(advice, dict):
                    advice = "；".join(
                        str(value)
                        for value in advice.values()
                        if value
                    ) or "未知"
                lines.append(f"健康影响：{health.get('effect', '未知')}")
                lines.append(f"健康建议：{advice}")

            for code, label in [
                ("pm2p5", "PM2.5"),
                ("pm10", "PM10"),
                ("no2", "NO2"),
                ("so2", "SO2"),
                ("o3", "O3"),
                ("co", "CO"),
            ]:
                item = pollutant_map.get(code)
                if item:
                    concentration = item.get("concentration") or {}
                    value = concentration.get("value", "未知")
                    unit = concentration.get("unit", "")
                    normalized_unit = str(unit or "").replace("µ", "u").replace("μ", "u").replace("³", "3")
                    lines.append(f"{label}：{value} {normalized_unit}".strip())
            result = "\n".join(lines)
        except Exception as new_air_exc:
            print(f"和风空气质量 v1 查询失败，尝试旧版 v7：{new_air_exc}")
            air_data, air_source = _qweather_request_json(
                f"https://{qweather_host}/v7/air/now",
                {"location": location["id"], "lang": "zh"},
            )
            now = air_data.get("now") or {}
            if not now:
                result = f"空气质量查询失败：和风天气未返回 {city} 的空气质量数据。"
                _log_tool_end("get_air_quality_info", start, result)
                return result

            result = (
                f"数据源：{air_source} 空气质量 v7（旧版接口）\n"
                f"城市：{location.get('name', city)}（{location.get('adm1', '')}{location.get('adm2', '')}）\n"
                f"AQI：{now.get('aqi', '未知')}\n"
                f"空气质量等级：{now.get('category', '未知')}\n"
                f"首要污染物：{now.get('primary', '无或未知')}\n"
                f"PM2.5：{now.get('pm2p5', '未知')} ug/m3\n"
                f"PM10：{now.get('pm10', '未知')} ug/m3\n"
                f"NO2：{now.get('no2', '未知')} ug/m3\n"
                f"SO2：{now.get('so2', '未知')} ug/m3\n"
                f"O3：{now.get('o3', '未知')} ug/m3\n"
                f"CO：{now.get('co', '未知')} mg/m3"
            )
        _log_tool_end("get_air_quality_info", start, result)
        return result
    except requests.HTTPError as exc:
        status_code = exc.response.status_code if exc.response is not None else ""
        if status_code == 403:
            result = "空气质量查询暂不可用：当前和风天气账号可能未开通空气质量 API 权限。"
        else:
            result = f"空气质量查询暂不可用：HTTP {status_code or '未知'}。"
        _log_tool_end("get_air_quality_info", start, result)
        return result
    except Exception as exc:
        result = f"空气质量查询暂不可用：{exc}"
        _log_tool_end("get_air_quality_info", start, result)
        return result

@tool
def get_weather_alerts(city: str) -> str:
    """查询城市当前天气灾害预警，用于出行安全提醒。

    Args:
        city: 城市名称，例如 "宁波"、"杭州"、"北京"。
    """
    start = _log_tool_start("get_weather_alerts", city=city)
    try:
        qweather_host = _qweather_host()
        location = _qweather_lookup(city)
        if not qweather_host or not location:
            result = "天气预警查询不可用：未配置和风天气 Key/Host，或未找到城市。"
            _log_tool_end("get_weather_alerts", start, result)
            return result

        lat = _poi_scalar(location.get("lat"), "")
        lon = _poi_scalar(location.get("lon"), "")
        if not lat or not lon:
            result = f"天气预警查询失败：和风天气未返回 {city} 的经纬度。"
            _log_tool_end("get_weather_alerts", start, result)
            return result

        try:
            warning_data, warning_source = _qweather_request_json(
                f"https://{qweather_host}/weatheralert/v1/current/{lat}/{lon}",
                {"lang": "zh"},
            )
            warnings = warning_data.get("alerts") or []
            alert_source_note = "天气预警 v1"
        except Exception as new_warning_exc:
            print(f"和风天气预警 v1 查询失败，尝试旧版 v7：{new_warning_exc}")
            warning_data, warning_source = _qweather_request_json(
                f"https://{qweather_host}/v7/warning/now",
                {"location": location["id"], "lang": "zh"},
            )
            warnings = warning_data.get("warning") or []
            alert_source_note = "灾害预警 v7（旧版接口）"

        if not warnings:
            result = (
                f"数据源：{warning_source} {alert_source_note}\n"
                f"城市：{location.get('name', city)}（{location.get('adm1', '')}{location.get('adm2', '')}）\n"
                "当前无正在生效的天气灾害预警。"
            )
            _log_tool_end("get_weather_alerts", start, result)
            return result

        lines = [
            f"数据源：{warning_source} {alert_source_note}",
            f"城市：{location.get('name', city)}（{location.get('adm1', '')}{location.get('adm2', '')}）",
        ]
        for index, warning in enumerate(warnings[:5], start=1):
            title = _first_non_empty(
                warning.get("title"),
                warning.get("headline"),
                warning.get("event"),
                default="未知预警",
            )
            severity = _first_non_empty(
                warning.get("severityColor"),
                warning.get("severity"),
                warning.get("level"),
                default="未知",
            )
            type_name = _first_non_empty(
                warning.get("typeName"),
                warning.get("type"),
                warning.get("eventType"),
                default="未知",
            )
            pub_time = _first_non_empty(
                warning.get("pubTime"),
                warning.get("effective"),
                warning.get("startTime"),
                default="未知",
            )
            description = _first_non_empty(
                warning.get("text"),
                warning.get("description"),
                warning.get("instruction"),
                default="无详细说明",
            )
            lines.append(
                f"{index}. {title}；"
                f"等级：{severity}；"
                f"类型：{type_name}；"
                f"发布时间：{pub_time}；"
                f"说明：{description}"
            )
        result = "\n".join(lines)
        _log_tool_end("get_weather_alerts", start, result)
        return result
    except requests.HTTPError as exc:
        status_code = exc.response.status_code if exc.response is not None else ""
        if status_code == 403:
            result = "天气预警查询暂不可用：当前和风天气账号可能未开通灾害预警 API 权限。"
        else:
            result = f"天气预警查询暂不可用：HTTP {status_code or '未知'}。"
        _log_tool_end("get_weather_alerts", start, result)
        return result
    except Exception as exc:
        result = f"天气预警查询暂不可用：{exc}"
        _log_tool_end("get_weather_alerts", start, result)
        return result

@tool
def get_weather_indices(city: str, types: str = "1,3,5,8,9,10,15,16") -> str:
    """查询和风天气生活指数，用于穿衣、防晒、运动、舒适度、交通等出行体验判断。

    Args:
        city: 城市名称，例如 "宁波"、"杭州"、"北京"。
        types: 指数类型，逗号分隔。常用：1运动，3穿衣，5紫外线，8舒适度，9感冒，10空气污染扩散，15交通，16防晒。
    """
    start = _log_tool_start("get_weather_indices", city=city, types=types)
    try:
        qweather_host = _qweather_host()
        location = _qweather_lookup(city)
        if not qweather_host or not location:
            result = "天气指数查询不可用：未配置和风天气 Key/Host/JWT，或未找到城市。"
            _log_tool_end("get_weather_indices", start, result)
            return result

        requested_types = ",".join(
            part.strip()
            for part in str(types or "").split(",")
            if part.strip().isdigit()
        ) or "1,3,5,8,9,10,15,16"
        indices_data, indices_source = _qweather_request_json(
            f"https://{qweather_host}/v7/indices/1d",
            {"type": requested_types, "location": location["id"], "lang": "zh"},
        )
        daily = indices_data.get("daily") or []
        if not daily:
            result = f"天气指数查询失败：和风天气未返回 {city} 的生活指数数据。"
            _log_tool_end("get_weather_indices", start, result)
            return result

        lines = [
            f"数据源：{indices_source} 天气指数",
            f"城市：{location.get('name', city)}（{location.get('adm1', '')}{location.get('adm2', '')}）",
            f"更新时间：{indices_data.get('updateTime', '未知')}",
        ]
        for index, item in enumerate(daily[:12], start=1):
            lines.append(
                f"{index}. {item.get('name', '未知指数')}｜"
                f"日期 {item.get('date', '未知')}｜"
                f"等级 {item.get('level', '未知')}｜"
                f"类别 {item.get('category', '未知')}｜"
                f"建议 {item.get('text', '无详细建议')}"
            )
        result = "\n".join(lines)
        _log_tool_end("get_weather_indices", start, result)
        return result
    except requests.HTTPError as exc:
        status_code = exc.response.status_code if exc.response is not None else ""
        if status_code in {401, 403}:
            result = "天气指数查询暂不可用：当前和风天气认证或账号权限不可用。"
        else:
            result = f"天气指数查询暂不可用：HTTP {status_code or '未知'}。"
        _log_tool_end("get_weather_indices", start, result)
        return result
    except Exception as exc:
        result = f"天气指数查询暂不可用：{exc}"
        _log_tool_end("get_weather_indices", start, result)
        return result
