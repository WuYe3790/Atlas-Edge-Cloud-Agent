from __future__ import annotations

import os

import requests


AMAP_BASE_URL = "https://restapi.amap.com/v3"


def amap_key() -> str:
    return os.getenv("AMAP_API_KEY", "").strip()


def amap_request(path: str, params: dict, timeout: int = 10) -> dict:
    key = amap_key()
    if not key:
        raise RuntimeError("未配置 AMAP_API_KEY")
    clean_params = {key_: value for key_, value in params.items() if value not in ("", None)}
    clean_params["key"] = key
    response = requests.get(f"{AMAP_BASE_URL}{path}", params=clean_params, timeout=timeout)
    response.raise_for_status()
    return response.json()

