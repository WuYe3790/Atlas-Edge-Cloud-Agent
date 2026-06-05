from __future__ import annotations

from flask import Flask, request
from dotenv import load_dotenv

from server.bootstrap import PROJECT_ROOT, configure_runtime


configure_runtime()

from travel_agent.storage import init_db  # noqa: E402
from server.amap_routes import amap_bp  # noqa: E402
from server.chat_routes import chat_bp  # noqa: E402
from server.conversation_routes import conversation_bp  # noqa: E402
from server.core_routes import core_bp  # noqa: E402
from server.edge_routes import edge_bp  # noqa: E402


def create_app() -> Flask:
    app = Flask(
        __name__,
        template_folder=str(PROJECT_ROOT / "templates"),
        static_folder=str(PROJECT_ROOT / "static"),
    )
    load_dotenv()
    init_db()
    app.register_blueprint(core_bp)
    app.register_blueprint(amap_bp)
    app.register_blueprint(conversation_bp)
    app.register_blueprint(chat_bp)
    app.register_blueprint(edge_bp)

    @app.after_request
    def add_no_cache_to_api(response):
        if request.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        return response

    return app

