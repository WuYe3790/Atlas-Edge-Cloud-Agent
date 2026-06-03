from __future__ import annotations

import json
import re
import time

from langchain.agents import create_agent
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_openai import ChatOpenAI

from travel_agent.config import LLMConfig
from travel_agent.structured import (
    enrich_structured_data_from_trace,
    extract_structured_json,
    strip_structured_json,
)
from travel_agent.trace import (
    collect_agent_trace,
    elapsed_ms,
    finish_trace_item,
    message_text,
    print_agent_trace,
    public_trace,
    public_trace_item,
    trace_status_from_result,
)
from travel_agent.tools import DEFAULT_DATE, TRAVEL_TOOLS
from travel_agent.train_tools import get_train_tools


from travel_agent.prompts import BASE_SYSTEM_PROMPT, REAL_DATA_TOOL_PROMPT, THINKING_MODE_PROMPT


def build_agent(config: LLMConfig, thinking_mode: bool = False):
    if not config.api_key:
        raise RuntimeError(
            "未检测到 LLM_API_KEY。请复制 .env.example 为 .env，并填写可用的大模型 API Key。"
        )

    selected_model = config.thinking_model if thinking_mode else config.model
    identity_prompt = f"""
当前运行配置：
- 模型名称：{selected_model}
- API 地址：{config.base_url}
- 运行模式：{'深度思考模式' if thinking_mode else '普通模式'}

如果用户询问你的身份、模型、版本或供应商，请根据以上实际运行配置回答。
不要声称自己是未在当前配置中出现的模型或供应商。
"""
    system_prompt = (
        BASE_SYSTEM_PROMPT
        + "\n"
        + REAL_DATA_TOOL_PROMPT
        + "\n"
        + identity_prompt
        + ("\n" + THINKING_MODE_PROMPT if thinking_mode else "")
    )

    llm_kwargs = {
        # DeepSeek V4 API-level thinking returns reasoning_content. When a tool call
        # happens, the API requires that field to be round-tripped in later calls.
        # LangChain's OpenAI-compatible tool agent does not preserve it yet, so we
        # disable API-level thinking for tool-calling stability and use the Pro model
        # plus the prompt-level thinking workflow in thinking mode.
        "extra_body": {"thinking": {"type": "disabled"}},
    }

    llm = ChatOpenAI(
        model=selected_model,
        api_key=config.api_key,
        base_url=config.base_url,
        temperature=config.temperature,
        timeout=config.timeout,
        **llm_kwargs,
    )
    all_tools = TRAVEL_TOOLS + get_train_tools()
    print(f"\nLLM模式：{'深度思考模式' if thinking_mode else '普通模式'} | 模型：{selected_model} | 工具数：{len(all_tools)}")
    return create_agent(model=llm, tools=all_tools, system_prompt=system_prompt)


def extract_final_answer(messages: list[BaseMessage]) -> str:
    for message in reversed(messages):
        if isinstance(message, AIMessage) and message_text(message).strip():
            return message_text(message).strip()
    return "智能体未生成最终回复。"


def build_memory_summary(message_history: list | None) -> str:
    if not message_history:
        return ""

    joined = "\n".join(str(msg.get("text", "")) for msg in message_history if isinstance(msg, dict))
    if not joined.strip():
        return ""

    memory_items = []
    route_match = re.findall(r"从\s*([\u4e00-\u9fa5A-Za-z]+)\s*(?:去|到|前往)\s*([\u4e00-\u9fa5A-Za-z]+)", joined)
    if route_match:
        origin, destination = route_match[-1]
        origin = _clean_place_name(origin)
        destination = _clean_place_name(destination)
        memory_items.append(f"最近识别到的出发地：{origin}")
        memory_items.append(f"最近识别到的目的地：{destination}")

    days_match = re.findall(r"(\d+)\s*天", joined)
    if days_match:
        memory_items.append(f"最近识别到的行程天数：{days_match[-1]}天")

    people_match = re.findall(r"(\d+)\s*(?:人|个人)", joined)
    if people_match:
        memory_items.append(f"最近识别到的出行人数：{people_match[-1]}人")

    budget_match = re.findall(r"(?:预算|花费|费用)[^\d]*(\d+)\s*(?:元|块|w|万)?", joined, flags=re.IGNORECASE)
    if budget_match:
        memory_items.append(f"最近识别到的预算数字：{budget_match[-1]}")

    preference_keywords = [
        "少走路",
        "美食",
        "博物馆",
        "海边",
        "亲子",
        "自驾",
        "公共交通",
        "慢节奏",
        "紧凑",
        "预算紧张",
        "轻松",
    ]
    preferences = [keyword for keyword in preference_keywords if keyword in joined]
    if preferences:
        memory_items.append("用户偏好：" + "、".join(dict.fromkeys(preferences)))

    if not memory_items:
        return ""

    return "会话记忆摘要：\n" + "\n".join(f"- {item}" for item in memory_items)


def build_current_request_summary(user_input: str) -> str:
    """Extract high-confidence facts from the current user input for the agent."""
    if not user_input:
        return ""

    facts: list[str] = []
    route_match = re.search(r"从\s*([\u4e00-\u9fa5A-Za-z]+)\s*(?:去|到|前往)\s*([\u4e00-\u9fa5A-Za-z]+)", user_input)
    if not route_match:
        route_match = re.search(r"([\u4e00-\u9fa5A-Za-z]+)\s*(?:去|到|前往)\s*([\u4e00-\u9fa5A-Za-z]+)", user_input)
    if route_match:
        origin = _clean_place_name(route_match.group(1))
        destination = _clean_place_name(route_match.group(2))
        facts.append(f"当前轮明确出发地：{origin}")
        facts.append(f"当前轮明确目的地：{destination}")

    days_match = re.search(r"(\d+)\s*天", user_input)
    if days_match:
        facts.append(f"当前轮明确行程天数：{days_match.group(1)}天")

    people_match = re.search(r"(\d+)\s*(?:人|个人)", user_input)
    if people_match:
        facts.append(f"当前轮明确出行人数：{people_match.group(1)}人")

    if not facts:
        return ""

    return (
        "当前轮需求摘要：\n"
        + "\n".join(f"- {item}" for item in facts)
        + "\n这些当前轮信息优先级最高；工具调用参数必须以当前轮明确地点为准，不得使用示例地点或历史地点替代。"
    )


def _clean_place_name(value: str) -> str:
    value = value.strip()
    for suffix in ("旅游", "旅行", "游玩", "玩", "游"):
        if value.endswith(suffix) and len(value) > len(suffix):
            value = value[: -len(suffix)]
    return value


def run_agent_with_trace(
    user_input: str,
    config: LLMConfig,
    thinking_mode: bool = False,
    message_history: list | None = None,
    client_context: str = "",
) -> tuple[str, list[dict], dict | None]:
    agent = build_agent(config, thinking_mode=thinking_mode)

    # Reconstruct LangChain message list from history + current input
    lc_messages: list[BaseMessage] = []
    memory_summary = build_memory_summary(message_history)
    if memory_summary:
        lc_messages.append(
            SystemMessage(
                content=(
                    memory_summary
                    + "\n请把这些信息作为多轮对话上下文参考。若用户在当前轮明确修改了某项信息，以当前轮为准。"
                )
            )
        )
    if client_context:
        lc_messages.append(SystemMessage(content=client_context))
    if message_history:
        for msg in message_history[-6:]:
            role = msg["role"]
            text = msg["text"]
            if len(text) > 1200:
                text = text[:1200] + "\n[历史消息过长，已截断]"
            if role == "user":
                lc_messages.append(HumanMessage(content=text))
            elif role == "assistant":
                lc_messages.append(AIMessage(content=text))

    current_summary = build_current_request_summary(user_input)
    if current_summary:
        lc_messages.append(SystemMessage(content=current_summary))
    lc_messages.append(HumanMessage(content=user_input))

    response = agent.invoke({"messages": lc_messages})
    messages = response["messages"]
    print_agent_trace(messages)
    answer = extract_final_answer(messages)
    trace = collect_agent_trace(messages)
    structured = enrich_structured_data_from_trace(extract_structured_json(answer), trace)
    cleaned = strip_structured_json(answer)
    return cleaned, trace, structured


def run_agent(
    user_input: str,
    config: LLMConfig,
    thinking_mode: bool = False,
    message_history: list | None = None,
    client_context: str = "",
) -> str:
    answer, _trace, _structured = run_agent_with_trace(
        user_input=user_input,
        config=config,
        thinking_mode=thinking_mode,
        message_history=message_history,
        client_context=client_context,
    )
    return answer


def build_langchain_messages(
    user_input: str,
    message_history: list | None = None,
    client_context: str = "",
) -> list[BaseMessage]:
    lc_messages: list[BaseMessage] = []
    memory_summary = build_memory_summary(message_history)
    if memory_summary:
        lc_messages.append(
            SystemMessage(
                content=(
                    memory_summary
                    + "\n请把这些信息作为多轮对话上下文参考。若用户在当前轮明确修改了某项信息，以当前轮为准。"
                )
            )
        )
    if client_context:
        lc_messages.append(SystemMessage(content=client_context))
    if message_history:
        for msg in message_history[-6:]:
            role = msg["role"]
            text = msg["text"]
            if len(text) > 1200:
                text = text[:1200] + "\n[历史消息过长，已截断]"
            if role == "user":
                lc_messages.append(HumanMessage(content=text))
            elif role == "assistant":
                lc_messages.append(AIMessage(content=text))
    current_summary = build_current_request_summary(user_input)
    if current_summary:
        lc_messages.append(SystemMessage(content=current_summary))
    lc_messages.append(HumanMessage(content=user_input))
    return lc_messages



def stream_agent_events(
    user_input: str,
    config: LLMConfig,
    thinking_mode: bool = False,
    message_history: list | None = None,
    client_context: str = "",
):
    agent = build_agent(config, thinking_mode=thinking_mode)
    lc_messages = build_langchain_messages(user_input, message_history, client_context=client_context)
    initial_message_count = len(lc_messages)
    seen_tool_calls: set[str] = set()
    seen_tool_results: set[str] = set()
    seen_llm_steps: set[int] = set()
    trace: list[dict] = []
    final_answer = ""
    run_started_at = time.monotonic()

    yield {
        "event": "status",
        "message": "请求已发送，智能体开始分析需求。",
        "elapsed_ms": elapsed_ms(run_started_at),
    }

    for chunk in agent.stream({"messages": lc_messages}, stream_mode="values"):
        messages = chunk.get("messages", [])
        if not messages:
            continue

        for step, latest_msg in enumerate(messages[initial_message_count:], start=initial_message_count + 1):
            if isinstance(latest_msg, AIMessage) and getattr(latest_msg, "tool_calls", None):
                for tool_call in latest_msg.tool_calls:
                    key = tool_call.get("id") or f"{step}-{tool_call['name']}-{tool_call.get('args')}"
                    if key in seen_tool_calls:
                        continue
                    seen_tool_calls.add(key)
                    item = {
                        "type": "tool_call",
                        "step": step,
                        "tool": tool_call["name"],
                        "args": tool_call.get("args", {}),
                        "result": "",
                        "tool_call_id": tool_call.get("id"),
                        "status": "running",
                        "started_ms": elapsed_ms(run_started_at),
                        "ended_ms": None,
                        "duration_ms": None,
                    }
                    trace.append(item)
                    yield {
                        "event": "trace",
                        "phase": "tool_call",
                        "message": f"决定调用工具：{tool_call['name']}",
                        "item": public_trace_item(item),
                        "trace": public_trace(trace),
                        "elapsed_ms": elapsed_ms(run_started_at),
                    }

            elif isinstance(latest_msg, ToolMessage):
                key = getattr(latest_msg, "tool_call_id", None) or f"{step}-{latest_msg.name}"
                if key not in seen_tool_results:
                    seen_tool_results.add(key)
                    result = message_text(latest_msg)
                    matched = False
                    for item in trace:
                        if item.get("tool_call_id") == getattr(latest_msg, "tool_call_id", None):
                            finish_trace_item(item, run_started_at, result=result)
                            result_item = item
                            matched = True
                            break
                    if not matched:
                        now_ms = elapsed_ms(run_started_at)
                        result_item = {
                            "type": "tool_result",
                            "step": step,
                            "tool": latest_msg.name,
                            "args": {},
                            "result": result,
                            "status": trace_status_from_result(result),
                            "started_ms": now_ms,
                            "ended_ms": now_ms,
                            "duration_ms": 0,
                        }
                        trace.append(result_item)
                    yield {
                        "event": "trace",
                        "phase": "tool_result",
                        "message": f"工具返回结果：{latest_msg.name or result_item.get('tool') or 'unknown'}",
                        "item": public_trace_item(result_item),
                        "trace": public_trace(trace),
                        "elapsed_ms": elapsed_ms(run_started_at),
                    }

            if isinstance(latest_msg, AIMessage):
                content = message_text(latest_msg).strip()
                if content:
                    final_answer = content
                usage = getattr(latest_msg, "usage_metadata", None)
                response_metadata = getattr(latest_msg, "response_metadata", {}) or {}
                model_name = response_metadata.get("model_name") or response_metadata.get("model")
                if (usage or model_name) and step not in seen_llm_steps:
                    seen_llm_steps.add(step)
                    now_ms = elapsed_ms(run_started_at)
                    item = {
                        "type": "llm_response",
                        "step": step,
                        "model": model_name or "unknown",
                        "usage": usage or {},
                        "status": "success",
                        "started_ms": now_ms,
                        "ended_ms": now_ms,
                        "duration_ms": 0,
                    }
                    trace.append(item)
                    yield {
                        "event": "trace",
                        "phase": "llm_response",
                        "message": f"模型阶段完成：{model_name or 'unknown'}",
                        "item": public_trace_item(item),
                        "trace": public_trace(trace),
                        "elapsed_ms": elapsed_ms(run_started_at),
                    }

    structured_data = enrich_structured_data_from_trace(extract_structured_json(final_answer), public_trace(trace))
    cleaned_answer = strip_structured_json(final_answer) or final_answer

    yield {
        "event": "final",
        "answer": cleaned_answer,
        "structured_data": structured_data,
        "trace": public_trace(trace),
        "elapsed_ms": elapsed_ms(run_started_at),
    }


def run_offline_demo(user_input: str) -> str:
    """No-LLM demo path for checking local tools when no API key is available."""
    from travel_agent.tools import calculate_trip_budget, get_transport_advice, get_weather_info

    print("\n离线演示模式：该模式只验证工具和项目流程，不代表真实 LLM 调用。")
    weather = get_weather_info.invoke({"city": "杭州", "date": DEFAULT_DATE})
    transport = get_transport_advice.invoke({"origin": "郑州", "destination": "杭州"})
    budget = calculate_trip_budget.invoke(
        {
            "city": "杭州",
            "days": 3,
            "person_num": 1,
            "hotel_price_per_night": 300,
            "food_cost_per_day": 120,
            "attraction_fee": 300,
        }
    )

    structured = {
        "summary": "杭州3天经典行程，涵盖西湖、灵隐寺、西溪湿地等核心景点。",
        "weather": [
            {
                "city": "杭州",
                "date": DEFAULT_DATE,
                "temperature": "25.5℃",
                "condition": "晴朗",
                "humidity": "72%",
                "wind": "5.8 km/h",
            }
        ],
        "transport_options": [
            {
                "mode": "高铁 G1880",
                "from": "郑州东",
                "to": "杭州东",
                "duration": "约4小时18分",
                "cost_estimate": "二等座 417元 / 一等座 668元",
                "notes": "06:52-11:10，数据源：12306。建议提前购票，杭州东站下车换乘地铁1号线。",
            },
            {
                "mode": "高铁 G3116",
                "from": "郑州东",
                "to": "杭州东",
                "duration": "约4小时50分",
                "cost_estimate": "二等座 386元 / 一等座 617元",
                "notes": "08:28-13:18，数据源：12306。备选车次，时间较宽裕。",
            },
        ],
        "daily_itinerary": [
            {
                "day": 1,
                "title": "西湖经典游",
                "activities": ["断桥残雪", "白堤", "苏堤春晓", "雷峰塔"],
                "meals": ["西湖醋鱼", "龙井虾仁"],
                "accommodation": "西湖区酒店",
            },
            {
                "day": 2,
                "title": "灵隐禅踪与龙井茶香",
                "activities": ["灵隐寺", "飞来峰", "龙井村", "湖滨商圈"],
                "meals": ["素斋", "杭帮菜"],
                "accommodation": "西湖区酒店",
            },
            {
                "day": 3,
                "title": "西溪湿地与返程",
                "activities": ["西溪湿地", "河坊街"],
                "meals": ["定胜糕", "葱包桧"],
                "accommodation": "",
            },
        ],
        "hotel_options": [],
        "budget": {
            "total": 1260,
            "breakdown": {"住宿": 600, "餐饮": 360, "门票": 300},
            "currency": "CNY",
            "notes": "以1人3天估算，实际费用随季节浮动。",
        },
        "tips": [
            "提前预约西湖游船，避免现场排队",
            "杭州夏季炎热，注意防晒补水",
            "灵隐寺建议上午前往，避开人流高峰",
            "建议购买杭州旅游一卡通，可节省门票费用",
        ],
        "poi_recommendations": [
            {
                "category": "景点推荐",
                "items": [
                    {"name": "西湖风景名胜区", "type": "风景名胜", "address": "杭州市西湖区龙井路1号", "rating": "4.8", "location": "120.130396,30.259242"},
                    {"name": "灵隐寺", "type": "寺庙", "address": "杭州市西湖区法云弄1号", "rating": "4.7", "location": "120.102371,30.240826"},
                    {"name": "西溪国家湿地公园", "type": "公园", "address": "杭州市西湖区天目山路518号", "rating": "4.6"},
                    {"name": "雷峰塔", "type": "文物古迹", "address": "杭州市西湖区南山路15号", "rating": "4.5"},
                ],
            },
            {
                "category": "餐饮推荐",
                "items": [
                    {"name": "楼外楼", "type": "杭帮菜", "address": "杭州市西湖区孤山路30号", "cost": "150元", "tel": "0571-87969682"},
                    {"name": "知味观", "type": "小吃", "address": "杭州市上城区仁和路83号", "cost": "60元"},
                    {"name": "绿茶餐厅", "type": "创意菜", "address": "杭州市西湖区龙井路83号", "cost": "80元"},
                ],
            },
            {
                "category": "商圈推荐",
                "items": [
                    {"name": "湖滨银泰in77", "type": "购物中心", "address": "杭州市上城区延安路258号"},
                    {"name": "河坊街", "type": "特色街区", "address": "杭州市上城区河坊街"},
                    {"name": "武林广场", "type": "商圈", "address": "杭州市拱墅区武林广场"},
                ],
            },
        ],
    }

    return (
        "### 离线演示：杭州3天出行规划\n\n"
        f"用户需求：{user_input}\n\n"
        "【工具调用结果】\n"
        f"{weather}\n\n{transport}\n\n{budget}\n\n"
        "【规划建议】\n"
        "Day1：抵达杭州后游览西湖核心区，路线为断桥、白堤、苏堤、雷峰塔。\n"
        "Day2：上午灵隐寺和飞来峰，下午龙井村，晚上可去湖滨商圈。\n"
        "Day3：西溪湿地和河坊街，返程前预留充足交通时间。\n\n"
        "【说明】真实实验运行时请配置 .env，让 LangChain Agent 调用 LLM 自主选择工具。\n\n"
        "```json\n"
        + json.dumps(structured, ensure_ascii=False, indent=2) +
        "\n```"
    )
