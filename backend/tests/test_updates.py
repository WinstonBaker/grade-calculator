import pytest
import zipfile
from fastapi.testclient import TestClient
from pathlib import Path

from backend.main import app
from backend.updates import (
    _validate_release_url,
    _windows_installer_script,
    _windows_apply_script,
    acknowledge_update_status,
    apply_update,
    create_update_backup,
    dismiss_update,
    is_newer,
    load_update_state,
    load_update_status,
    parse_version,
    should_show_update_toast,
    write_update_status,
)


def test_parse_version():
    assert parse_version("v1.2.3") == (1, 2, 3)
    assert parse_version("1.0.0") == (1, 0, 0)
    assert is_newer("1.1.0", "1.0.0")
    assert is_newer("v2.0.0", "1.9.9")
    assert not is_newer("1.0.0", "1.0.0")
    assert not is_newer("1.0.0", "1.1.0")


def test_should_show_update_toast():
    assert should_show_update_toast(True, "1.3.0", None)
    assert not should_show_update_toast(False, "1.3.0", None)
    assert not should_show_update_toast(True, "1.3.0", "1.3.0")
    assert should_show_update_toast(True, "1.4.0", "1.3.0")
    assert not should_show_update_toast(True, "1.2.0", "1.3.0")


def test_dismissed_version_hides_toast_until_newer(tmp_path, monkeypatch):
    monkeypatch.setattr("backend.updates.user_data_dir", lambda: tmp_path)
    dismiss_update("v1.3.0")
    state = load_update_state()
    assert state["dismissed_update_version"] == "1.3.0"
    assert not should_show_update_toast(True, "1.3.0", state["dismissed_update_version"])
    assert should_show_update_toast(True, "1.4.0", state["dismissed_update_version"])


def test_dismiss_update_requires_version():
    with pytest.raises(ValueError, match="required"):
        dismiss_update("  ")


def test_create_update_backup_uses_program_backups_folder(tmp_path, monkeypatch):
    program = tmp_path / "Grade Calculator"
    data = tmp_path / "user-data"
    program.mkdir()
    data.mkdir()
    (data / "data.txt").write_text("keep me", encoding="utf-8")
    monkeypatch.setattr("backend.updates.program_dir", lambda: program)
    monkeypatch.setattr("backend.updates.user_data_dir", lambda: data)

    backup = create_update_backup("v1.4.0")

    assert backup.parent == program / "Backups"
    assert backup.name.startswith("updatebackup-")
    assert backup.name.endswith("-Version1.4.0.zip")
    assert backup.is_file()
    with zipfile.ZipFile(backup) as archive:
        assert archive.namelist() == ["data.txt"]


class _FakeReleaseResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


class _FakeGithubClient:
    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def get(self, url):
        return _FakeReleaseResponse(
            200,
            {
                "tag_name": "v9.9.9",
                "body": "notes",
                "html_url": "https://github.com/WinstonBaker/grade-calculator/releases/tag/v9.9.9",
            },
        )


def test_check_for_updates_records_state_and_toast_flag(tmp_path, monkeypatch):
    monkeypatch.setattr("backend.updates.user_data_dir", lambda: tmp_path)
    monkeypatch.setattr("backend.updates.httpx.Client", _FakeGithubClient)
    from backend.updates import check_for_updates

    payload = check_for_updates()
    assert payload["update_available"] is True
    assert payload["show_toast"] is True
    assert payload["latest_version"] == "9.9.9"
    assert payload["last_update_check_at"]
    assert payload["can_apply"] is False
    assert payload["apply_status"] is None

    dismiss_update("9.9.9")
    hidden = check_for_updates()
    assert hidden["show_toast"] is False
    assert hidden["dismissed_update_version"] == "9.9.9"


def test_validate_release_url():
    url = _validate_release_url(
        "https://github.com/WinstonBaker/grade-calculator/releases/download/v1.3.0/GradeCaculatorWindowsInstaller.exe"
    )
    assert url.endswith("GradeCaculatorWindowsInstaller.exe")
    with pytest.raises(ValueError, match="Unexpected"):
        _validate_release_url("https://evil.example/GradeCaculatorWindowsInstaller.exe")


def _latest_info(**overrides):
    payload = {
        "download_url": (
            "https://github.com/WinstonBaker/grade-calculator/releases/download/"
            "v9.0.0/GradeCalculator-macOS.dmg"
        ),
        "asset_name": "GradeCalculator-macOS.dmg",
        "latest_version": "9.0.0",
        "release_url": "https://github.com/WinstonBaker/grade-calculator/releases/tag/v9.0.0",
        "update_available": True,
    }
    payload.update(overrides)
    return payload


def test_apply_update_skips_when_not_frozen(monkeypatch):
    monkeypatch.setattr("backend.updates.frozen", lambda: False)
    monkeypatch.setattr("backend.updates.check_for_updates", _latest_info)

    def boom(*_args, **_kwargs):
        raise AssertionError("should not download when not frozen")

    monkeypatch.setattr("backend.updates._download_file", boom)
    result = apply_update()
    assert result["restarting"] is False
    assert result["frozen"] is False
    assert result["version"] == "9.0.0"
    assert result["download_url"].endswith("GradeCalculator-macOS.dmg")


def test_apply_update_rejects_unexpected_url(monkeypatch):
    monkeypatch.setattr("backend.updates.frozen", lambda: True)
    monkeypatch.setattr("backend.updates.current_platform", lambda: "windows")
    monkeypatch.setattr(
        "backend.updates.check_for_updates",
        lambda: _latest_info(download_url="https://evil.example/installer.exe", asset_name="installer.exe"),
    )

    def boom(*_args, **_kwargs):
        raise AssertionError("should not download an unexpected URL")

    monkeypatch.setattr("backend.updates._download_file", boom)
    with pytest.raises(ValueError, match="Unexpected"):
        apply_update()


def test_windows_apply_update_stages_the_installer(monkeypatch, tmp_path):
    monkeypatch.setattr("backend.updates.frozen", lambda: True)
    monkeypatch.setattr("backend.updates.current_platform", lambda: "windows")
    monkeypatch.setattr(
        "backend.updates.check_for_updates",
        lambda: _latest_info(
            download_url=(
                "https://github.com/WinstonBaker/grade-calculator/releases/download/"
                "v9.0.0/GradeCaculatorWindowsInstaller.exe"
            ),
            asset_name="GradeCaculatorWindowsInstaller.exe",
        ),
    )
    monkeypatch.setattr("backend.updates.create_update_backup", lambda _version: tmp_path / "backup.zip")
    staged = []
    monkeypatch.setattr(
        "backend.updates._download_file",
        lambda _url, destination: destination.write_bytes(b"installer"),
    )
    monkeypatch.setattr(
        "backend.updates._stage_windows_installer",
        lambda installer, version: staged.append((installer, version)),
    )

    result = apply_update()

    assert result["restarting"] is True
    assert staged == [(tmp_path / "updates" / "GradeCaculatorWindowsInstaller.exe", "9.0.0")]


def test_dismiss_endpoint(tmp_path, monkeypatch):
    monkeypatch.setattr("backend.updates.user_data_dir", lambda: tmp_path)
    client = TestClient(app)
    body = client.post("/api/updates/dismiss", json={"version": "v1.9.0"}).json()
    assert body["ok"] is True
    assert body["dismissed_update_version"] == "1.9.0"
    missing = client.post("/api/updates/dismiss", json={"version": " "})
    assert missing.status_code == 400


def test_windows_apply_script_retries_and_falls_back():
    script = _windows_apply_script(
        src=Path(r"C:\Users\me\AppData\Roaming\Grade Calculator\updates\GradeCaculatorWindowsInstaller.exe"),
        dst=Path(r"C:\Program Files\Grade Calculator\Grade Calculator.exe"),
        log=Path(r"C:\Users\me\AppData\Roaming\Grade Calculator\updates\apply.log"),
        marker=Path(r"C:\Users\me\AppData\Roaming\Grade Calculator\updates\update-status.json"),
        pid=4242,
        version="1.3.2",
    )
    assert "$appPid = 4242" in script
    assert "for ($i = 0; $i -lt 45; $i++)" in script
    assert "Move-Item -LiteralPath $dst -Destination $oldPath -Force" in script
    assert "Copy-Item -LiteralPath $src -Destination $dst -Force" in script
    assert "failed_launched_staged" in script
    assert "Start-Process -FilePath $src" in script
    assert "Write-Status 'applied'" in script


def test_windows_installer_script_waits_for_app_and_records_result():
    script = _windows_installer_script(
        installer=Path(r"C:\Users\me\AppData\Roaming\Grade Calculator\updates\GradeCaculatorWindowsInstaller.exe"),
        marker=Path(r"C:\Users\me\AppData\Roaming\Grade Calculator\updates\update-status.json"),
        log=Path(r"C:\Users\me\AppData\Roaming\Grade Calculator\updates\apply.log"),
        pid=4242,
        version="2.0.0",
    )
    assert "$appPid = 4242" in script
    assert "Start-Process -FilePath $installer" in script
    assert "'/SILENT', '/NORESTART'" in script
    assert "Write-Status 'applied'" in script
    assert "Write-Status 'failed'" in script


def test_apply_status_survives_and_can_be_acked(tmp_path, monkeypatch):
    monkeypatch.setattr("backend.updates.user_data_dir", lambda: tmp_path)
    monkeypatch.setattr("backend.updates.httpx.Client", _FakeGithubClient)
    write_update_status(
        "failed_launched_staged",
        version="9.9.9",
        message="Could not replace the installed file",
        staged=str(tmp_path / "updates" / "app.exe"),
    )
    from backend.updates import check_for_updates

    payload = check_for_updates()
    assert payload["apply_status"]["status"] == "failed_launched_staged"
    assert "Could not replace" in payload["apply_status"]["message"]

    client = TestClient(app)
    assert client.post("/api/updates/status/ack").json()["ok"] is True
    assert load_update_status() is None
    cleared = check_for_updates()
    assert cleared["apply_status"] is None
    assert acknowledge_update_status()["ok"] is True


def test_applied_status_clears_when_version_matches(tmp_path, monkeypatch):
    monkeypatch.setattr("backend.updates.user_data_dir", lambda: tmp_path)
    monkeypatch.setattr("backend.updates.httpx.Client", _FakeGithubClient)
    from backend import updates as updates_mod

    write_update_status("applied", version=updates_mod.__version__, message="Update installed")
    payload = updates_mod.check_for_updates()
    assert payload["apply_status"] is None
    assert load_update_status() is None


def test_pending_status_hidden_from_toast_payload(tmp_path, monkeypatch):
    monkeypatch.setattr("backend.updates.user_data_dir", lambda: tmp_path)
    monkeypatch.setattr("backend.updates.httpx.Client", _FakeGithubClient)
    write_update_status("pending", version="9.9.9", message="Waiting…")
    from backend.updates import check_for_updates

    payload = check_for_updates()
    assert payload["apply_status"] is None
    assert load_update_status()["status"] == "pending"
