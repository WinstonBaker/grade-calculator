#!/usr/bin/env python3
from __future__ import annotations

import logging
import multiprocessing
import socket
import sys
import threading
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _fatal(message: str) -> None:
    logging.error(message)
    try:
        import tkinter
        from tkinter import messagebox

        root = tkinter.Tk()
        root.withdraw()
        messagebox.showerror("Grade Calculator", message)
        root.destroy()
    except Exception:
        pass
    raise SystemExit(1)


DESKTOP_PORT = 18765


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _server_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind(("127.0.0.1", DESKTOP_PORT))
            return DESKTOP_PORT
        except OSError:
            logging.warning("Desktop port %s is busy; using a random port", DESKTOP_PORT)
            return _free_port()


def _wait_for_server(url: str, attempts: int = 80) -> None:
    for _ in range(attempts):
        try:
            urllib.request.urlopen(url, timeout=0.25)
            return
        except Exception:
            time.sleep(0.1)
    _fatal("The Grade Calculator server did not start. Check desktop.log and try again.")


def main() -> None:
    from backend.paths import frontend_dist, user_data_dir
    from backend.version import __version__

    data_dir = user_data_dir()
    logging.basicConfig(
        filename=data_dir / "desktop.log",
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    dist = frontend_dist()
    if not dist.exists():
        _fatal("The app UI is missing. Rebuild with: cd frontend && npm run build")

    import uvicorn
    import webview
    from backend.main import app

    port = _server_port()
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    _wait_for_server(f"http://127.0.0.1:{port}/api/meta")

    storage = data_dir / "webview"
    storage.mkdir(parents=True, exist_ok=True)
    webview.create_window(
        f"Grade Calculator {__version__}",
        f"http://127.0.0.1:{port}",
        width=1280,
        height=840,
        min_size=(960, 640),
        background_color="#12131a",
        text_select=True,
    )
    webview.start(private_mode=False, storage_path=str(storage))


if __name__ == "__main__":
    multiprocessing.freeze_support()
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:
        logging.exception("Desktop app failed")
        extra = ""
        if sys.platform == "win32":
            extra = (
                "\n\nOn Windows this app needs Microsoft Edge WebView2. "
                "Install it from https://aka.ms/webview2installer and try again."
            )
        _fatal(f"Grade Calculator failed to start:\n{exc}{extra}")
