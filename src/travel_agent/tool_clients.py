from __future__ import annotations

import os
import time

import jwt
import requests
from dotenv import load_dotenv


AMAP_BASE_URL = "https://restapi.amap.com/v3"
# Aviationstack free-tier keys commonly reject HTTPS with HTTP 403.
AVIATIONSTACK_BASE_URL = "http://api.aviationstack.com/v1"
RAPIDAPI_BOOKING_HOST = "booking-com15.p.rapidapi.com"
_QWEATHER_JWT_CACHE: dict[str, object] = {"token": "", "exp": 0}


def _get_env_key(name: str) -> str:
    load_dotenv()
    return os.getenv(name, "").strip()


def _request_json(url: str, params: dict[str, object], timeout: int = 10, headers: dict[str, str] | None = None) -> dict:
    response = requests.get(url, params=params, headers=headers, timeout=timeout)
    response.raise_for_status()
    return response.json()


def _amap_key() -> str:
    return _get_env_key("AMAP_API_KEY")


def _aviationstack_key() -> str:
    return _get_env_key("AVIATIONSTACK_API_KEY")


def _rapidapi_key() -> str:
    return _get_env_key("RAPIDAPI_KEY")


def _rapidapi_host() -> str:
    return _get_env_key("RAPIDAPI_HOST") or RAPIDAPI_BOOKING_HOST


def _rapidapi_headers() -> dict[str, str]:
    host = _rapidapi_host()
    return {"X-RapidAPI-Key": _rapidapi_key(), "X-RapidAPI-Host": host}


def _qweather_key() -> str:
    return _get_env_key("QWEATHER_API_KEY")


def _qweather_host() -> str:
    return _get_env_key("QWEATHER_API_HOST").removeprefix("https://").removeprefix("http://").strip("/")


def _qweather_jwt_key_id() -> str:
    return _get_env_key("QWEATHER_JWT_KEY_ID")


def _qweather_jwt_project_id() -> str:
    return _get_env_key("QWEATHER_JWT_PROJECT_ID")


def _qweather_jwt_private_key() -> str:
    private_key = _get_env_key("QWEATHER_JWT_PRIVATE_KEY")
    if private_key:
        return private_key.replace("\\n", "\n")
    private_key_path = _get_env_key("QWEATHER_JWT_PRIVATE_KEY_PATH")
    if private_key_path and os.path.exists(private_key_path):
        with open(private_key_path, "r", encoding="utf-8") as file:
            return file.read()
    return ""


def _qweather_jwt_token() -> str:
    key_id = _qweather_jwt_key_id()
    project_id = _qweather_jwt_project_id()
    private_key = _qweather_jwt_private_key()
    if not key_id or not project_id or not private_key:
        return ""

    now = int(time.time())
    cached_token = str(_QWEATHER_JWT_CACHE.get("token") or "")
    cached_exp = int(_QWEATHER_JWT_CACHE.get("exp") or 0)
    if cached_token and cached_exp - now > 60:
        return cached_token

    iat = now - 30
    exp = iat + 900
    token = jwt.encode(
        {"sub": project_id, "iat": iat, "exp": exp},
        private_key,
        algorithm="EdDSA",
        headers={"alg": "EdDSA", "kid": key_id, "typ": "JWT"},
    )
    _QWEATHER_JWT_CACHE.update({"token": token, "exp": exp})
    return token


def _qweather_header_candidates() -> list[tuple[str, dict[str, str]]]:
    candidates: list[tuple[str, dict[str, str]]] = []
    try:
        token = _qweather_jwt_token()
        if token:
            candidates.append(("和风天气 JWT", {"Authorization": f"Bearer {token}"}))
    except Exception as exc:
        print(f"和风天气 JWT 生成失败，将尝试 API Key：{exc}")
    api_key = _qweather_key()
    if api_key:
        candidates.append(("和风天气 API Key", {"X-QW-Api-Key": api_key}))
    return candidates


def _qweather_headers() -> dict[str, str]:
    candidates = _qweather_header_candidates()
    return candidates[0][1] if candidates else {}


def _qweather_request_json(url: str, params: dict[str, object] | None = None, timeout: int = 10) -> tuple[dict, str]:
    candidates = _qweather_header_candidates()
    if not candidates:
        raise RuntimeError("未配置和风天气 JWT 或 API Key。")

    last_exc: Exception | None = None
    for source, headers in candidates:
        try:
            return _request_json(url, params or {}, timeout=timeout, headers=headers), source
        except requests.HTTPError as exc:
            last_exc = exc
            status_code = exc.response.status_code if exc.response is not None else None
            if status_code in {401, 403}:
                continue
            raise
    if last_exc:
        raise last_exc
    raise RuntimeError("和风天气认证失败。")


def _qweather_lookup(city: str) -> dict | None:
    qweather_host = _qweather_host()
    if not qweather_host or not _qweather_header_candidates():
        return None
    geo_data, _ = _qweather_request_json(
        f"https://{qweather_host}/geo/v2/city/lookup",
        {"location": city, "lang": "zh"},
    )
    locations = geo_data.get("location") or []
    return locations[0] if locations else None
