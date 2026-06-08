from __future__ import annotations

from langchain_core.tools import tool

from travel_agent.tool_formatters import _log_tool_end, _log_tool_start


_DEFAULT_MAX_RESULTS = 5
_REQUEST_TIMEOUT = 15.0


@tool
def web_search(query: str, max_results: int = _DEFAULT_MAX_RESULTS) -> str:
    """使用 DuckDuckGo 搜索互联网，获取旅游相关的实时网页信息。

    此工具适合以下场景：
    - 目的地的最新活动、新开景点、节庆安排、临时闭馆等信息
    - 景点开放时间变更、门票价格更新、最新攻略评价
    - 当地政策（交通管制、景区限流、预约要求等）
    - 以上工具（天气/交通/POI/酒店/航班/火车票）无法覆盖的其他实时问题

    Args:
        query: 搜索关键词，建议包含城市名 + 具体问题，例如 "大连星海广场 2026年6月活动"。
        max_results: 返回结果数量，默认 5，最大不超过 8。
    """
    start = _log_tool_start("web_search", query=query, max_results=max_results)

    safe_limit = max(1, min(int(max_results), 8))

    try:
        from ddgs import DDGS
    except ImportError:
        result = (
            "数据源：DuckDuckGo 搜索\n"
            "搜索不可用：未安装 ddgs 包，请运行 pip install ddgs 后重试。"
        )
        _log_tool_end("web_search", start, result)
        return result

    try:
        with DDGS(timeout=_REQUEST_TIMEOUT) as ddgs:
            results = list(ddgs.text(query, max_results=safe_limit))

        if not results:
            result = (
                f"数据源：DuckDuckGo 搜索\n"
                f"查询：{query}\n"
                f"未找到相关结果，可尝试更换关键词或缩短查询。"
            )
            _log_tool_end("web_search", start, result)
            return result

        lines = [
            "数据源：DuckDuckGo 搜索",
            f"查询：{query}",
            f"返回 {len(results)} 条结果：",
            "",
        ]
        for i, r in enumerate(results, 1):
            title = (r.get("title") or "无标题").strip()
            body = (r.get("body") or "").strip()
            href = (r.get("href") or "").strip()
            lines.append(f"{i}. {title}")
            if body:
                lines.append(f"   {body}")
            if href:
                lines.append(f"   链接：{href}")
            lines.append("")

        result = "\n".join(lines)
        _log_tool_end("web_search", start, result)
        return result

    except Exception as exc:
        reason = str(exc).lower()
        if any(kw in reason for kw in ("ratelimit", "rate", "429", "too many")):
            result = (
                f"数据源：DuckDuckGo 搜索\n"
                f"查询：{query}\n"
                f"搜索暂时被限流，请稍后重试或换用其他关键词。"
            )
        else:
            result = (
                f"数据源：DuckDuckGo 搜索\n"
                f"查询：{query}\n"
                f"搜索请求失败：{exc}"
            )
        _log_tool_end("web_search", start, result)
        return result
