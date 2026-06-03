from __future__ import annotations

import re
import time

from langchain_core.messages import AIMessage, BaseMessage, ToolMessage


def message_text(message: BaseMessage) -> str:
    content = message.content
    if isinstance(content, str):
        return content
    return str(content)


def public_trace_item(item: dict) -> dict:
    """Return a copy of a trace item without internal LangChain bookkeeping ids."""
    return {key: value for key, value in item.items() if key != "tool_call_id"}


def public_trace(trace: list[dict]) -> list[dict]:
    return [public_trace_item(item) for item in trace]


def elapsed_ms(started_at: float) -> int:
    return int((time.monotonic() - started_at) * 1000)


def trace_status_from_result(result: str) -> str:
    if not result:
        return "success"
    lowered = result.lower()
    if re.search(r"\b(error|traceback|exception)\b", lowered):
        return "error"
    error_markers = ("失败", "异常", "报错", "错误")
    return "error" if any(marker in lowered for marker in error_markers) else "success"


def finish_trace_item(item: dict, run_started_at: float, result: str | None = None) -> None:
    ended_ms = elapsed_ms(run_started_at)
    item["ended_ms"] = ended_ms
    item["duration_ms"] = max(0, ended_ms - int(item.get("started_ms") or ended_ms))
    if result is not None:
        item["result"] = result
        item["status"] = trace_status_from_result(result)
    elif item.get("status") == "running":
        item["status"] = "success"


def collect_agent_trace(messages: list[BaseMessage]) -> list[dict]:
    trace: list[dict] = []
    pending_tool_calls: dict[str, dict] = {}

    for index, message in enumerate(messages, start=1):
        if isinstance(message, AIMessage) and getattr(message, "tool_calls", None):
            for tool_call in message.tool_calls:
                item = {
                    "type": "tool_call",
                    "step": index,
                    "tool": tool_call["name"],
                    "args": tool_call.get("args", {}),
                    "result": "",
                    "status": "success",
                    "started_ms": None,
                    "ended_ms": None,
                    "duration_ms": None,
                }
                trace.append(item)
                if tool_call.get("id"):
                    pending_tool_calls[tool_call["id"]] = item

        elif isinstance(message, ToolMessage):
            result = message_text(message)
            matched = False
            if getattr(message, "tool_call_id", None) in pending_tool_calls:
                pending_tool_calls[message.tool_call_id]["result"] = result
                pending_tool_calls[message.tool_call_id]["status"] = trace_status_from_result(result)
                matched = True
            if not matched:
                trace.append(
                    {
                        "type": "tool_result",
                        "step": index,
                        "tool": message.name,
                        "args": {},
                        "result": result,
                        "status": trace_status_from_result(result),
                        "started_ms": None,
                        "ended_ms": None,
                        "duration_ms": None,
                    }
                )

        if isinstance(message, AIMessage):
            usage = getattr(message, "usage_metadata", None)
            response_metadata = getattr(message, "response_metadata", {}) or {}
            model_name = response_metadata.get("model_name") or response_metadata.get("model")
            if usage or model_name:
                trace.append(
                    {
                        "type": "llm_response",
                        "step": index,
                        "model": model_name or "unknown",
                        "usage": usage or {},
                        "status": "success",
                        "started_ms": None,
                        "ended_ms": None,
                        "duration_ms": None,
                    }
                )

    return trace


def print_agent_trace(messages: list[BaseMessage]) -> None:
    print("\n智能体思考与工具调用过程：")
    print("-" * 70)

    for index, message in enumerate(messages, start=1):
        if isinstance(message, AIMessage) and getattr(message, "tool_calls", None):
            for tool_call in message.tool_calls:
                print(f"[{index}] 决策：调用工具 {tool_call['name']}")
                print(f"    参数：{tool_call['args']}")
        elif isinstance(message, ToolMessage):
            print(f"[{index}] 工具返回：{message.name}")
            print(message_text(message))

        if isinstance(message, AIMessage):
            usage = getattr(message, "usage_metadata", None)
            response_metadata = getattr(message, "response_metadata", {}) or {}
            model_name = response_metadata.get("model_name") or response_metadata.get("model")
            if usage or model_name:
                print(f"[{index}] LLM响应元数据：model={model_name or 'unknown'}, usage={usage or 'unknown'}")

