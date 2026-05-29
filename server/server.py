#!/usr/bin/env python3
"""CLI entrypoint for running the FastAPI app with Uvicorn."""

import argparse
import logging

import uvicorn

from .app import app
from .config import get_settings


def main() -> None:
    settings = get_settings()
    default_host = settings.server_host
    default_port = settings.server_port

    parser = argparse.ArgumentParser(description="OpenPoke FastAPI server")
    parser.add_argument("--host", default=default_host, help=f"Host to bind (default: {default_host})")
    parser.add_argument("--port", type=int, default=default_port, help=f"Port to bind (default: {default_port})")
    parser.add_argument("--reload", action="store_true", help="Enable auto-reload for development")
    args = parser.parse_args()

    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("uvicorn").setLevel(logging.INFO)
    logging.getLogger("watchfiles.main").setLevel(logging.WARNING)

    logger = logging.getLogger(__name__)
    logger.info("Voice WebSocket available at ws://%s:%s/chat/voice", args.host, args.port)

    shared_config = dict(
        host=args.host,
        port=args.port,
        reload=args.reload,
        log_level="info",
        access_log=False,
        ws="websockets",        # explicit WebSocket implementation
        ws_ping_interval=20,    # keep voice connections alive
        ws_ping_timeout=30,
    )

    if args.reload:
        uvicorn.run("server.app:app", **shared_config)
    else:
        uvicorn.run(app, **shared_config)


if __name__ == "__main__":  # pragma: no cover
    main()