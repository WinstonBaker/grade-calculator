from __future__ import annotations

import os
import sys
from pathlib import Path

from backend.version import GITHUB_REPO

APP_NAME = "Grade Calculator"


def frozen() -> bool:
    return bool(getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"))


def resource_root() -> Path:
    if frozen():
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent.parent


def program_dir() -> Path:
    """Return the folder containing the installed Grade Calculator program."""
    if not frozen():
        return resource_root()

    executable = Path(sys.executable).resolve()
    if sys.platform == "darwin":
        for parent in [executable, *executable.parents]:
            if parent.suffix == ".app":
                return parent
    return executable.parent


def user_data_dir() -> Path:
    if frozen():
        if sys.platform == "darwin":
            base = Path.home() / "Library" / "Application Support" / APP_NAME
        elif sys.platform == "win32":
            base = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming") / APP_NAME
        else:
            base = Path.home() / ".grade-calculator"
    else:
        base = resource_root() / "data"
    base.mkdir(parents=True, exist_ok=True)
    return base


def frontend_dist() -> Path:
    return resource_root() / "frontend" / "dist"


def current_platform() -> str:
    if sys.platform == "darwin":
        return "macos"
    if sys.platform == "win32":
        return "windows"
    return "linux"


def github_repo() -> str:
    return os.environ.get("GRADE_CALCULATOR_GITHUB_REPO") or GITHUB_REPO
