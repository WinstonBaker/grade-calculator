from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

from backend.paths import current_platform, frozen, github_repo, user_data_dir
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


def normalize_version(tag: str) -> str:
    text = str(tag or "").strip()
    if text.startswith(("v", "V")):
        text = text[1:]
    return text


def should_show_update_toast(update_available: bool, latest: str, dismissed: str | None) -> bool:
    if not update_available or not latest:
        return False
    if not dismissed:
        return True
    return is_newer(latest, dismissed)


def can_apply_in_place() -> bool:
    return frozen() and current_platform() in {"windows", "macos"}


def update_state_path() -> Path:
    return user_data_dir() / "update-state.json"


def load_update_state() -> dict:
    path = update_state_path()
    empty = {"last_update_check_at": None, "dismissed_update_version": None}
    if not path.is_file():
        return empty
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return empty
    if not isinstance(data, dict):
        return empty
    return {
        "last_update_check_at": data.get("last_update_check_at"),
        "dismissed_update_version": data.get("dismissed_update_version"),
    }


def save_update_state(patch: dict) -> dict:
    state = load_update_state()
    state.update(patch)
    path = update_state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    return state


def dismiss_update(version: str) -> dict:
    normalized = normalize_version(version)
    if not normalized:
        raise ValueError("Version is required")
    state = save_update_state({"dismissed_update_version": normalized})
    return {"ok": True, **state}


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


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


def _validate_release_url(url: str) -> str:
    repo = github_repo()
    allowed = (
        f"https://github.com/{repo}/releases/download/",
        f"https://github.com/{repo}/releases/latest/download/",
    )
    if not any(url.startswith(prefix) for prefix in allowed):
        raise ValueError("Unexpected download URL")
    return url


def _attach_toast_state(payload: dict) -> dict:
    state = save_update_state({"last_update_check_at": _now_iso()})
    dismissed = state.get("dismissed_update_version")
    payload["last_update_check_at"] = state.get("last_update_check_at")
    payload["dismissed_update_version"] = dismissed
    payload["show_toast"] = should_show_update_toast(
        bool(payload.get("update_available")),
        str(payload.get("latest_version") or ""),
        dismissed,
    )
    payload["can_apply"] = can_apply_in_place()
    return payload


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
        # Ignore HTTP(S)_PROXY from the environment — Cursor/dev sandboxes often inject
        # a local proxy that blocks api.github.com and surfaces as "Failed to fetch".
        with httpx.Client(
            timeout=12.0, headers=_headers(), follow_redirects=True, trust_env=False
        ) as client:
            response = client.get(url)
    except httpx.HTTPError as exc:
        raise RuntimeError(f"Could not reach GitHub: {exc}") from exc

    if response.status_code == 404:
        payload["notes"] = "No GitHub release has been published yet."
        return _attach_toast_state(payload)
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
    return _attach_toast_state(payload)


def _download_file(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_name(destination.name + ".partial")
    try:
        with httpx.Client(
            timeout=120.0, headers=_headers(), follow_redirects=True, trust_env=False
        ) as client:
            with client.stream("GET", url) as response:
                if response.status_code >= 400:
                    raise RuntimeError(f"Download failed (HTTP {response.status_code})")
                with partial.open("wb") as handle:
                    for chunk in response.iter_bytes():
                        handle.write(chunk)
        partial.replace(destination)
    except httpx.HTTPError as exc:
        raise RuntimeError(f"Could not download update: {exc}") from exc
    finally:
        if partial.exists():
            partial.unlink(missing_ok=True)


def _staging_dir() -> Path:
    path = user_data_dir() / "updates"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _spawn_detached(command: list[str]) -> None:
    kwargs: dict = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
    }
    if sys.platform == "win32":
        flags = 0
        flags |= getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
        flags |= getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
        flags |= getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
        kwargs["creationflags"] = flags
        kwargs["close_fds"] = False
    else:
        kwargs["start_new_session"] = True
        kwargs["close_fds"] = True
    subprocess.Popen(command, **kwargs)


def _ps_single_quote(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def _sh_single_quote(value: str) -> str:
    return "'" + str(value).replace("'", "'\\''") + "'"


def _macos_bundle_path() -> Path:
    exe = Path(sys.executable).resolve()
    for parent in [exe, *exe.parents]:
        if parent.suffix == ".app":
            return parent
    raise RuntimeError("Could not locate the Grade Calculator app bundle")


def _stage_windows_replace(staged_exe: Path) -> None:
    dest = Path(sys.executable).resolve()
    log_path = staged_exe.parent / "apply.log"
    script = staged_exe.parent / "apply-update.ps1"
    pid = os.getpid()
    script.write_text(
        "\n".join(
            [
                "$ErrorActionPreference = 'Stop'",
                f"$src = {_ps_single_quote(str(staged_exe))}",
                f"$dst = {_ps_single_quote(str(dest))}",
                f"$log = {_ps_single_quote(str(log_path))}",
                f"$appPid = {pid}",
                "try {",
                "  while (Get-Process -Id $appPid -ErrorAction SilentlyContinue) {",
                "    Start-Sleep -Seconds 1",
                "  }",
                "  Copy-Item -LiteralPath $src -Destination $dst -Force",
                "  Start-Process -FilePath $dst",
                "  Remove-Item -LiteralPath $src -Force -ErrorAction SilentlyContinue",
                "} catch {",
                "  Set-Content -LiteralPath $log -Value $_.Exception.Message",
                "}",
                "",
            ]
        ),
        encoding="utf-8-sig",
    )
    _spawn_detached(
        [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(script),
        ]
    )


def _extract_macos_app(dmg: Path, staging_dir: Path) -> Path:
    mount = staging_dir / "dmg-mount"
    subprocess.run(["hdiutil", "detach", str(mount), "-quiet", "-force"], check=False)
    if mount.exists():
        shutil.rmtree(mount, ignore_errors=True)
    mount.mkdir(parents=True, exist_ok=True)
    attach = subprocess.run(
        ["hdiutil", "attach", "-nobrowse", "-readonly", "-mountpoint", str(mount), str(dmg)],
        check=False,
        capture_output=True,
        text=True,
    )
    if attach.returncode != 0:
        detail = (attach.stderr or attach.stdout or "").strip()
        raise RuntimeError(detail or "Could not mount the update disk image")
    try:
        apps = [path for path in mount.iterdir() if path.suffix == ".app" and path.is_dir()]
        if not apps:
            raise RuntimeError("The update disk image does not contain an app")
        staged = staging_dir / apps[0].name
        if staged.exists():
            shutil.rmtree(staged)
        copied = subprocess.run(
            ["ditto", str(apps[0]), str(staged)],
            check=False,
            capture_output=True,
            text=True,
        )
        if copied.returncode != 0:
            detail = (copied.stderr or copied.stdout or "").strip()
            raise RuntimeError(detail or "Could not copy the updated app")
        return staged
    finally:
        subprocess.run(["hdiutil", "detach", str(mount), "-quiet", "-force"], check=False)


def _stage_macos_replace(dmg: Path) -> None:
    dest = _macos_bundle_path()
    staging_dir = dmg.parent
    staged_app = _extract_macos_app(dmg, staging_dir)
    log_path = staging_dir / "apply.log"
    script = staging_dir / "apply-update.sh"
    pid = os.getpid()
    script.write_text(
        "\n".join(
            [
                "#!/bin/bash",
                "set -e",
                "trap 'echo \"Update failed\" > \"$log\"' ERR",
                f"src={_sh_single_quote(str(staged_app))}",
                f"dst={_sh_single_quote(str(dest))}",
                f"dmg={_sh_single_quote(str(dmg))}",
                f"log={_sh_single_quote(str(log_path))}",
                f"app_pid={pid}",
                "while kill -0 \"$app_pid\" 2>/dev/null; do sleep 1; done",
                "new=\"${dst}.new\"",
                "old=\"${dst}.old\"",
                "rm -rf \"$new\" \"$old\"",
                "ditto \"$src\" \"$new\"",
                "if mv \"$dst\" \"$old\"; then",
                "  if mv \"$new\" \"$dst\"; then",
                "    rm -rf \"$old\"",
                "  else",
                "    mv \"$old\" \"$dst\" || true",
                "    echo \"Could not move the new app into place\" > \"$log\"",
                "    exit 1",
                "  fi",
                "else",
                "  echo \"Could not replace the running app\" > \"$log\"",
                "  rm -rf \"$new\"",
                "  exit 1",
                "fi",
                "open \"$dst\"",
                "rm -rf \"$src\"",
                "rm -f \"$dmg\"",
                "",
            ]
        ),
        encoding="utf-8",
    )
    script.chmod(0o755)
    _spawn_detached(["/bin/bash", str(script)])


def apply_update() -> dict:
    info = check_for_updates()
    if not can_apply_in_place():
        return {
            "ok": True,
            "frozen": frozen(),
            "restarting": False,
            "version": info.get("latest_version"),
            "download_url": info.get("download_url"),
            "release_url": info.get("release_url"),
        }

    download_url = info.get("download_url")
    asset_name = info.get("asset_name")
    if not download_url or not asset_name:
        raise RuntimeError("No desktop installer is published for this platform")
    url = _validate_release_url(str(download_url))

    staged = _staging_dir() / str(asset_name)
    _download_file(url, staged)

    platform = current_platform()
    if platform == "windows":
        _stage_windows_replace(staged)
    elif platform == "macos":
        _stage_macos_replace(staged)
    else:
        raise RuntimeError("In-place updates are not supported on this platform")

    return {
        "ok": True,
        "frozen": True,
        "restarting": True,
        "version": info.get("latest_version"),
    }


def download_update() -> dict:
    return apply_update()


def schedule_app_exit() -> None:
    time.sleep(0.5)
    os._exit(0)
