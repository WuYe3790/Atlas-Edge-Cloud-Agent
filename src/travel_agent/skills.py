from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timedelta

from langchain_core.tools import tool

from travel_agent.tool_flights import search_flight_options
from travel_agent.tool_formatters import _log_tool_end, _log_tool_start
from travel_agent.tool_transport import (
    get_bicycling_route,
    get_public_transit_plan,
    get_traffic_status,
    get_transport_advice,
    get_walking_route,
)
from travel_agent.train_tools import search_interline_train_tickets, search_train_tickets


DEFAULT_SKILL_DATE = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d")


@dataclass(frozen=True)
class SkillInfo:
    name: str
    display_name: str
    category: str
    description: str
    explicit_call: str
    examples: list[str]
    tools: list[str]


SKILL_INFOS = [
    SkillInfo(
        name="city_transit_skill",
        display_name="市内交通查询",
        category="transport",
        description="查询同城两点之间的公交/地铁、步行、骑行和可选实时路况，适合车站、酒店、景点之间移动。",
        explicit_call="@市内交通查询",
        examples=[
            "@市内交通查询 杭州东站到西湖怎么走",
            "@市内交通查询 宁波大学到天一阁，比较地铁和骑行",
        ],
        tools=[
            "get_public_transit_plan",
            "get_walking_route",
            "get_bicycling_route",
            "get_traffic_status",
        ],
    ),
    SkillInfo(
        name="intercity_transport_skill",
        display_name="城市间交通查询",
        category="transport",
        description="比较跨城驾车、高铁/火车、航班和可选中转方案，适合两座城市之间的出行方式决策。",
        explicit_call="@城市间交通查询",
        examples=[
            "@城市间交通查询 明天宁波到广州",
            "@城市间交通查询 郑州到杭州，高铁和飞机都查一下",
        ],
        tools=[
            "get_transport_advice",
            "search_train_tickets",
            "search_interline_train_tickets",
            "search_flight_options",
        ],
    ),
]


def list_installed_skills() -> list[dict]:
    return [asdict(skill) for skill in SKILL_INFOS]


def _section(title: str, body: str) -> str:
    body = (body or "").strip()
    return f"## {title}\n{body}" if body else f"## {title}\n暂无结果。"


@tool
def city_transit_skill(
    origin: str,
    destination: str,
    city: str = "",
    include_walking: bool = True,
    include_bicycling: bool = True,
    include_traffic: bool = False,
) -> str:
    """市内交通查询 Skill：聚合公交/地铁、步行、骑行和可选路况工具，适合同城两点之间移动。"""
    start = _log_tool_start(
        "city_transit_skill",
        origin=origin,
        destination=destination,
        city=city,
        include_walking=include_walking,
        include_bicycling=include_bicycling,
        include_traffic=include_traffic,
    )
    if not origin or not destination:
        result = "Skill：市内交通查询\n缺少起点或终点，无法查询。"
        _log_tool_end("city_transit_skill", start, result)
        return result

    sections = [
        "Skill：市内交通查询",
        f"查询对象：{origin} → {destination}",
        _section(
            "公交/地铁方案",
            get_public_transit_plan.invoke(
                {
                    "origin": origin,
                    "destination": destination,
                    "origin_city": city,
                    "destination_city": city,
                    "limit": 3,
                }
            ),
        ),
    ]
    if include_walking:
        sections.append(
            _section(
                "步行可达性",
                get_walking_route.invoke({"origin": origin, "destination": destination, "city": city}),
            )
        )
    if include_bicycling:
        sections.append(
            _section(
                "骑行可达性",
                get_bicycling_route.invoke({"origin": origin, "destination": destination, "city": city}),
            )
        )
    if include_traffic:
        sections.append(
            _section(
                "终点周边实时路况",
                get_traffic_status.invoke({"place": destination, "city": city, "radius": 3000}),
            )
        )
    sections.append("输出要求：请优先给出最推荐的市内移动方式，再列出备选方式和适用场景。")
    result = "\n\n".join(sections)
    _log_tool_end("city_transit_skill", start, result)
    return result


@tool
def intercity_transport_skill(
    origin: str,
    destination: str,
    date: str = "",
    train_filter_flags: str = "",
    adults: int = 1,
    include_interline_train: bool = False,
    include_flight: bool = True,
) -> str:
    """城市间交通查询 Skill：聚合驾车、高铁/火车、航班和可选中转火车方案，适合跨城交通决策。"""
    start = _log_tool_start(
        "intercity_transport_skill",
        origin=origin,
        destination=destination,
        date=date,
        train_filter_flags=train_filter_flags,
        adults=adults,
        include_interline_train=include_interline_train,
        include_flight=include_flight,
    )
    if not origin or not destination:
        result = "Skill：城市间交通查询\n缺少出发城市或到达城市，无法查询。"
        _log_tool_end("intercity_transport_skill", start, result)
        return result

    travel_date = date or DEFAULT_SKILL_DATE
    sections = [
        "Skill：城市间交通查询",
        f"查询对象：{origin} → {destination}，日期：{travel_date}",
        _section("驾车距离与耗时", get_transport_advice.invoke({"origin": origin, "destination": destination})),
        _section(
            "铁路直达方案",
            search_train_tickets.invoke(
                {
                    "date": travel_date,
                    "from_city": origin,
                    "to_city": destination,
                    "train_filter_flags": train_filter_flags,
                    "limit": 8,
                }
            ),
        ),
    ]
    if include_interline_train:
        sections.append(
            _section(
                "铁路中转方案",
                search_interline_train_tickets.invoke(
                    {
                        "date": travel_date,
                        "from_city": origin,
                        "to_city": destination,
                        "middle_city": "",
                        "train_filter_flags": train_filter_flags,
                        "limit": 5,
                    }
                ),
            )
        )
    try:
        adult_count = max(1, int(adults or 1))
    except (TypeError, ValueError):
        adult_count = 1

    if include_flight:
        sections.append(
            _section(
                "航班方案",
                search_flight_options.invoke(
                    {
                        "departure": origin,
                        "arrival": destination,
                        "date": travel_date,
                        "adults": adult_count,
                        "limit": 6,
                    }
                ),
            )
        )
    sections.append("输出要求：请按耗时、稳定性、价格可得性和适用人群比较交通方式；不要扩展成完整旅行规划，除非用户明确要求。")
    result = "\n\n".join(sections)
    _log_tool_end("intercity_transport_skill", start, result)
    return result


SKILL_TOOLS = [city_transit_skill, intercity_transport_skill]
