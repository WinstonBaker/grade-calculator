from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

import httpx

from backend.paths import current_platform, downloads_dir, frozen, github_repo
from backend.version import MACOS_ASSET, WINDOWS_ASSET, __version__

USER_AGENT = f"GradeCalculator/{__version__}"


def parse_version(tag: str) -> tuple[int, ...]:
    text = str(tag or "").strip()
    if text.startswith(("v", "V")):
        text = text[1:]
    parts: list[int] = []
    for bit in text.split("."):
        match = re.match(r"(\d+)", bit)
        parts.append(int(match.group(1)) if match else 0)
    return tuple(parts or (0,))


def is_newer(latest: str, current: str) -> bool:
    return parse_version(latest) > parse_version(current)


def _asset_name(platform: str) -> str | None:
    if platform == "macos":
        return MACOS_ASSET
    if platform == "windows":
        return WINDOWS_ASSET
    return None


def _headers() -> dict[str, str]:
    return {"Accept": "application/vnd.github+json", "User-Agent": USER_AGENT}


def _download_url(tag: str, asset: str) -> str:
    repo = github_repo()
    return f"https://github.com/{repo}/releases/download/{tag}/{asset}"


def _latest_download_url(asset: str) -> str:
    repo = github_repo()
    return f"https://github.com/{repo}/releases/latest/download/{asset}"


def _open_path(path: Path) -> None:
    if sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    elif sys.platform == "win32":
        os.startfile(path)  # type: ignore[attr-defined]
    else:
        subprocess.Popen(["xdg-open", str(path)])


def _validate_release_url(url: str) -> str:
    repo = github_repo()
    allowed = (
        f"https://github.com/{repo}/releases/download/",
        f"https://github.com/{repo}/releases/latest/download/",
    )
    if not any(url.startswith(prefix) for prefix in allowed):
        raise ValueError("Unexpected download URL")
    return url


def check_for_updates() -> dict:
    repo = github_repo()
    platform = current_platform()
    asset = _asset_name(platform)
    payload = {
        "current_version": __version__,
        "latest_version": __version__,
        "update_available": False,
        "frozen": frozen(),
        "platform": platform,
        "github_repo": repo,
        "release_url": f"https://github.com/{repo}/releases/latest",
        "notes": "",
        "asset_name": asset,
        "download_url": _latest_download_url(asset) if asset else None,
        "assets": {
            "windows": _latest_download_url(WINDOWS_ASSET),
            "macos": _latest_download_url(MACOS_ASSET),
        },
    }
    url = f"https://api.github.com/repos/{repo}/releases/latest"
    try:
        with httpx.Client(timeout=12.0, headers=_headers(), follow_redirects=True) as client:
            response = client.get(url)
    except httpx.HTTPError as exc:
        raise RuntimeError(f"Could not reach GitHub: {exc}") from exc

    if response.status_code == 404:
        payload["notes"] = "No GitHub release has been published yet."
        return payload
    if response.status_code >= 400:
        raise RuntimeError(f"GitHub returned HTTP {response.status_code}")

    body = response.json()
    tag = str(body.get("tag_name") or "")
    latest = tag[1:] if tag.startswith(("v", "V")) else tag
    payload["latest_version"] = latest or __version__
    payload["notes"] = str(body.get("body") or "")
    payload["release_url"] = str(body.get("html_url") or payload["release_url"])
    payload["update_available"] = bool(latest) and is_newer(latest, __version__)
    if tag and asset:
        payload["download_url"] = _download_url(tag, asset)
        payload["assets"] = {
            "windows": _download_url(tag, WINDOWS_ASSET),
            "macos": _download_url(tag, MACOS_ASSET),
        }
    return payload


def download_update() -> dict:
    info = check_for_updates()
    download_url = info.get("download_url")
    asset_name = info.get("asset_name")
    if not download_url or not asset_name:
        raise RuntimeError("No desktop installer is published for this platform")
    _validate_release_url(str(download_url))

    destination = downloads_dir() / str(asset_name)
    try:
        with httpx.Client(timeout=120.0, headers=_headers(), follow_redirects=True) as client:
            with client.stream("GET", str(download_url)) as response:
                if response.status_code >= 400:
                    raise RuntimeError(f"Download failed (HTTP {response.status_code})")
                with destination.open("wb") as handle:
                    for chunk in response.iter_bytes():
                        handle.write(chunk)
    except httpx.HTTPError as exc:
        raise RuntimeError(f"Could not download update: {exc}") from exc

    _open_path(destination)
    return {
        "ok": True,
        "path": str(destination),
        "version": info.get("latest_version"),
        "update_available": info.get("update_available"),
    }
