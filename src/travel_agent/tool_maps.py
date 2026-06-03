from __future__ import annotations

import re

import requests

from travel_agent.tool_clients import AMAP_BASE_URL, _amap_key, _request_json
from travel_agent.tool_formatters import _poi_scalar


COORDINATE_RE = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$")


def _amap_geocode(address: str, city: str = "") -> dict | None:
    key = _amap_key()
    if not key:
        return None
    coordinate = _normalize_coordinate(address)
    if coordinate:
        return {
            "location": coordinate,
            "formatted_address": address,
            "province": "",
            "city": city,
            "district": "",
            "level": "经纬度",
        }

    city_candidates = []
    if city:
        city_candidates.extend([city, f"{city}市" if not city.endswith("市") else city])
    city_candidates.append("")
    for city_name in dict.fromkeys(city_candidates):
        data = _request_json(
            f"{AMAP_BASE_URL}/geocode/geo",
            {"key": key, "address": address, "city": city_name or None, "output": "JSON"},
        )
        if data.get("status") == "1" and data.get("geocodes"):
            return data["geocodes"][0]

    for city_name in dict.fromkeys(city_candidates):
        data = _request_json(
            f"{AMAP_BASE_URL}/place/text",
            {
                "key": key,
                "keywords": address,
                "city": city_name or None,
                "citylimit": "true" if city_name else "false",
                "offset": 1,
                "page": 1,
                "extensions": "base",
                "output": "JSON",
            },
        )
        pois = data.get("pois") or []
        if data.get("status") == "1" and pois:
            poi = pois[0]
            return {
                "location": poi.get("location", ""),
                "formatted_address": poi.get("address") or poi.get("name") or address,
                "province": poi.get("pname", ""),
                "city": poi.get("cityname", city),
                "district": poi.get("adname", ""),
                "level": "POI",
            }
    return None

def _normalize_coordinate(value: str) -> str | None:
    match = COORDINATE_RE.match(str(value or ""))
    if not match:
        return None
    lon = float(match.group(1))
    lat = float(match.group(2))
    if -180 <= lon <= 180 and -90 <= lat <= 90:
        return f"{lon:.6f},{lat:.6f}"
    return None

def _amap_location(address: str, city: str = "") -> tuple[str, str] | None:
    info = _amap_geocode(address, city=city)
    if not info or not info.get("location"):
        return None
    return info["location"], info.get("formatted_address") or address

def _resolve_route_points(origin: str, destination: str, city: str = "") -> tuple[str, str, str, str] | None:
    origin_info = _amap_location(origin, city=city)
    destination_info = _amap_location(destination, city=city)
    if not origin_info or not destination_info:
        return None
    origin_location, origin_address = origin_info
    destination_location, destination_address = destination_info
    return origin_location, origin_address, destination_location, destination_address

def _city_name_from_geocode(info: dict | None, fallback: str) -> str:
    if not info:
        return fallback
    city = info.get("city")
    if isinstance(city, list):
        city = city[0] if city else ""
    province = info.get("province")
    if isinstance(province, list):
        province = province[0] if province else ""
    return str(city or province or fallback)

def _geocode_many(places: str, city: str = "") -> list[tuple[str, str, str]]:
    results: list[tuple[str, str, str]] = []
    for raw_place in re.split(r"[|,，;；\n]+", str(places or "")):
        place = raw_place.strip()
        if not place:
            continue
        info = _amap_geocode(place, city=city)
        if info and info.get("location"):
            results.append((place, info["location"], info.get("formatted_address") or place))
    return results

def _amap_marker_url(location: str, name: str) -> str:
    return f"https://uri.amap.com/marker?position={location}&name={requests.utils.quote(name)}"
