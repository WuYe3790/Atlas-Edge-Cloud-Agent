from __future__ import annotations

from datetime import datetime, timedelta

from langchain_core.tools import tool

from travel_agent.tool_formatters import (
    _log_tool_end,
    _log_tool_start,
)
from travel_agent.tool_weather import (
    get_air_quality_info,
    get_weather_alerts,
    get_weather_indices,
    get_weather_info,
)
from travel_agent.tool_transport import (
    get_bicycling_route,
    get_public_transit_plan,
    get_route_distance_matrix,
    get_traffic_status,
    get_transport_advice,
    get_walking_route,
)
from travel_agent.tool_pois import (
    get_map_marker_link,
    get_place_location,
    search_nearby_pois,
    search_travel_pois,
)
from travel_agent.tool_hotels import search_hotel_prices
from travel_agent.tool_flights import search_flight_options
from travel_agent.tool_rag import search_local_knowledge
from travel_agent.tool_web_search import web_search
from travel_agent.skills import city_transit_skill, intercity_transport_skill


DEFAULT_DATE = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d")


@tool
def calculate_trip_budget(
    city: str,
    days: int,
    person_num: int,
    hotel_price_per_night: int,
    food_cost_per_day: int,
    attraction_fee: int,
) -> str:
    """计算旅行预算，只有用户明确给出费用参数时才应调用。

    Args:
        city: 目的地城市。
        days: 行程天数。
        person_num: 出行人数。
        hotel_price_per_night: 每人每晚住宿费用，单位元。
        food_cost_per_day: 每人每天餐饮费用，单位元。
        attraction_fee: 每人整个行程的景点门票总费用，单位元。
    """
    start = _log_tool_start(
        "calculate_trip_budget",
        city=city,
        days=days,
        person_num=person_num,
        hotel_price_per_night=hotel_price_per_night,
        food_cost_per_day=food_cost_per_day,
        attraction_fee=attraction_fee,
    )

    if not city or days <= 0 or person_num <= 0:
        return "预算计算失败：城市、天数、人数必须由用户明确提供且合法。"
    if hotel_price_per_night < 0 or food_cost_per_day < 0 or attraction_fee < 0:
        return "预算计算失败：费用不能为负数。"

    hotel_total = hotel_price_per_night * max(days - 1, 0) * person_num
    food_total = food_cost_per_day * days * person_num
    attraction_total = attraction_fee * person_num
    total = hotel_total + food_total + attraction_total

    result = (
        f"【{city}{days}天行程预算明细】\n"
        f"1. 酒店费用：{hotel_total}元（{max(days - 1, 0)}晚 x {person_num}人 x {hotel_price_per_night}元）\n"
        f"2. 餐饮费用：{food_total}元（{days}天 x {person_num}人 x {food_cost_per_day}元）\n"
        f"3. 景点门票：{attraction_total}元（{person_num}人 x {attraction_fee}元）\n"
        f"总预算：{total}元"
    )
    _log_tool_end("calculate_trip_budget", start, result)
    return result


TRAVEL_TOOLS = [
    get_weather_info,
    get_air_quality_info,
    get_weather_alerts,
    get_weather_indices,
    calculate_trip_budget,
    get_transport_advice,
    city_transit_skill,
    intercity_transport_skill,
    search_flight_options,
    get_public_transit_plan,
    get_walking_route,
    get_bicycling_route,
    get_route_distance_matrix,
    get_traffic_status,
    search_travel_pois,
    search_nearby_pois,
    search_hotel_prices,
    search_local_knowledge,
    web_search,
    get_place_location,
    get_map_marker_link,
]
