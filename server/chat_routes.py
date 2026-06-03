from __future__ import annotations

import json
import time

from flask import Blueprint, Response, jsonify, request, stream_with_context

from server.context import (
    build_client_context_prompt,
    garbled_error_response,
    looks_like_garbled_text,
    public_client_context,
)
from travel_agent.agent import (
    extract_structured_json,
    run_agent_with_trace,
    run_offline_demo,
    stream_agent_events,
    strip_structured_json,
)
from travel_agent.config import load_llm_config
from travel_agent.storage import add_message, ensure_conversation, get_messages, maybe_update_title


chat_bp = Blueprint("chat", __name__)


def sanitize_history(history: object) -> list[dict]:
    max_history = 12
    max_text_length = 2000
    if not isinstance(history, list):
        return []
    clean = [
        {"role": item["role"], "text": item["text"].strip()[:max_text_length]}
        for item in history
        if isinstance(item, dict)
        and item.get("role") in ("user", "assistant")
        and isinstance(item.get("text"), str)
        and item["text"].strip()
    ]
    return clean[-max_history:]


@chat_bp.post("/api/chat")
def chat():
    payload = request.get_json(silent=True) or {}
    message = str(payload.get("message", "")).strip()
    offline_demo = bool(payload.get("offline_demo", False))
    thinking_mode = bool(payload.get("thinking_mode", False))
    conversation_id = str(payload.get("conversation_id", "")).strip() or None
    client_context_prompt = build_client_context_prompt(public_client_context(payload))
    history = sanitize_history(payload.get("history", []))

    if not message:
        return jsonify({"error": "请输入行程需求。"}), 400
    if looks_like_garbled_text(message):
        return garbled_error_response()

    started_at = time.time()
    try:
        conversation_id = ensure_conversation(conversation_id, title_hint=message)
        maybe_update_title(conversation_id, message)
        add_message(conversation_id, "user", message)

        db_history = get_messages(conversation_id, limit=12)
        history_for_agent = [
            {"role": item["role"], "text": item["text"]}
            for item in db_history
            if not (item["role"] == "user" and item["text"] == message and item["id"] == db_history[-1]["id"])
        ]
        if not history_for_agent:
            history_for_agent = history

        config = load_llm_config()
        trace = []
        structured_data = None
        if offline_demo:
            answer = run_offline_demo(message)
            structured_data = extract_structured_json(answer)
            answer = strip_structured_json(answer)
            model = "offline-demo"
            mode = "离线演示"
        else:
            model = config.thinking_model if thinking_mode else config.model
            mode = "深度思考模式" if thinking_mode else "普通模式"
            answer, trace, structured_data = run_agent_with_trace(
                message,
                config,
                thinking_mode=thinking_mode,
                message_history=history_for_agent,
                client_context=client_context_prompt,
            )
        elapsed = round(time.time() - started_at, 2)
        meta = {"elapsed_seconds": elapsed, "model": model, "mode": mode, "trace": trace}
        if structured_data:
            meta["structured_data"] = structured_data
        add_message(conversation_id, "assistant", answer, meta=meta)
        return jsonify(
            {
                "answer": answer,
                "structured_data": structured_data,
                "elapsed_seconds": elapsed,
                "model": model,
                "mode": mode,
                "trace": trace,
                "conversation_id": conversation_id,
            }
        )
    except Exception as exc:
        elapsed = round(time.time() - started_at, 2)
        if conversation_id:
            add_message(conversation_id, "assistant", f"运行失败：{exc}", meta={"elapsed_seconds": elapsed, "error": True})
        return jsonify({"error": str(exc), "elapsed_seconds": elapsed, "conversation_id": conversation_id}), 500


@chat_bp.post("/api/chat/stream")
def chat_stream():
    payload = request.get_json(silent=True) or {}
    message = str(payload.get("message", "")).strip()
    offline_demo = bool(payload.get("offline_demo", False))
    thinking_mode = bool(payload.get("thinking_mode", False))
    conversation_id = str(payload.get("conversation_id", "")).strip() or None
    client_context_prompt = build_client_context_prompt(public_client_context(payload))

    if not message:
        return jsonify({"error": "请输入行程需求。"}), 400
    if looks_like_garbled_text(message):
        return garbled_error_response()

    history = payload.get("history", [])
    if not isinstance(history, list):
        history = []

    def send(data: dict) -> str:
        return "data: " + json.dumps(data, ensure_ascii=False) + "\n\n"

    @stream_with_context
    def generate():
        started_at = time.time()
        current_conversation_id = ensure_conversation(conversation_id, title_hint=message)
        maybe_update_title(current_conversation_id, message)
        add_message(current_conversation_id, "user", message)
        yield send({"event": "status", "message": "请求已接收。", "conversation_id": current_conversation_id})

        try:
            db_history = get_messages(current_conversation_id, limit=12)
            history_for_agent = [
                {"role": item["role"], "text": item["text"]}
                for item in db_history[:-1]
            ] or history

            config = load_llm_config()
            trace = []
            structured_data = None
            if offline_demo:
                answer = run_offline_demo(message)
                structured_data = extract_structured_json(answer)
                answer = strip_structured_json(answer)
                model = "offline-demo"
                mode = "离线演示"
                yield send({"event": "status", "message": "离线演示已生成。"})
            else:
                model = config.thinking_model if thinking_mode else config.model
                mode = "深度思考模式" if thinking_mode else "普通模式"
                yield send({"event": "status", "message": f"{mode}启动，模型：{model}"})
                answer = ""
                for event in stream_agent_events(
                    message,
                    config,
                    thinking_mode=thinking_mode,
                    message_history=history_for_agent,
                    client_context=client_context_prompt,
                ):
                    if event.get("event") == "trace":
                        trace = event.get("trace", trace)
                    elif event.get("event") == "final":
                        answer = event.get("answer", "")
                        structured_data = event.get("structured_data")
                        trace = event.get("trace", trace)
                    yield send(event)

            elapsed = round(time.time() - started_at, 2)
            meta = {"elapsed_seconds": elapsed, "model": model, "mode": mode, "trace": trace}
            if structured_data:
                meta["structured_data"] = structured_data
            add_message(current_conversation_id, "assistant", answer, meta=meta)
            yield send(
                {
                    "event": "done",
                    "answer": answer,
                    "structured_data": structured_data,
                    "elapsed_seconds": elapsed,
                    "model": model,
                    "mode": mode,
                    "trace": trace,
                    "conversation_id": current_conversation_id,
                }
            )
        except Exception as exc:
            elapsed = round(time.time() - started_at, 2)
            error_text = f"运行失败：{exc}"
            add_message(current_conversation_id, "assistant", error_text, meta={"elapsed_seconds": elapsed, "error": True})
            yield send({"event": "error", "error": str(exc), "elapsed_seconds": elapsed, "conversation_id": current_conversation_id})

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )

