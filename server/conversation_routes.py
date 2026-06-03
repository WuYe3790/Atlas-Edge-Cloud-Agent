from __future__ import annotations

from flask import Blueprint, jsonify, request

from travel_agent.storage import create_conversation, delete_conversation, get_messages, list_conversations


conversation_bp = Blueprint("conversation", __name__)


@conversation_bp.get("/api/conversations")
def conversations():
    return jsonify({"conversations": list_conversations()})


@conversation_bp.post("/api/conversations")
def new_conversation():
    payload = request.get_json(silent=True) or {}
    title = str(payload.get("title", "")).strip() or None
    return jsonify({"conversation": create_conversation(title)})


@conversation_bp.get("/api/conversations/<conversation_id>/messages")
def conversation_messages(conversation_id: str):
    return jsonify({"messages": get_messages(conversation_id)})


@conversation_bp.delete("/api/conversations/<conversation_id>")
def remove_conversation(conversation_id: str):
    deleted = delete_conversation(conversation_id)
    return jsonify({"deleted": deleted})

