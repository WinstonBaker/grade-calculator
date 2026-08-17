# -*- mode: python ; coding: utf-8 -*-
from __future__ import annotations

import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules

root = Path(SPECPATH).resolve().parent
if str(root) not in sys.path:
    sys.path.insert(0, str(root))

from backend.version import __version__

datas = [(str(root / "frontend" / "dist"), "frontend/dist")]
binaries = []
hiddenimports = collect_submodules("backend")

for pkg in (
    "uvicorn",
    "fastapi",
    "starlette",
    "anyio",
    "sqlalchemy",
    "pydantic",
    "pydantic_core",
    "webview",
    "httptools",
    "h11",
    "httpx",
    "httpcore",
    "click",
    "idna",
    "certifi",
    "sniffio",
    "websockets",
    "watchfiles",
):
    try:
        collected_datas, collected_binaries, collected_imports = collect_all(pkg)
    except Exception:
        continue
    datas += collected_datas
    binaries += collected_binaries
    hiddenimports += collected_imports

a = Analysis(
    [str(root / "desktop.py")],
    pathex=[str(root)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["pytest"],
    noarchive=False,
)
pyz = PYZ(a.pure)

if sys.platform == "win32":
    exe = EXE(
        pyz,
        a.scripts,
        a.binaries,
        a.zipfiles,
        a.datas,
        [],
        name="GradeCalculator",
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,
        runtime_tmpdir=None,
        console=False,
        disable_windowed_traceback=False,
    )
else:
    exe = EXE(
        pyz,
        a.scripts,
        [],
        exclude_binaries=True,
        name="GradeCalculator",
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,
        console=False,
        disable_windowed_traceback=False,
        argv_emulation=True,
    )
    coll = COLLECT(
        exe,
        a.binaries,
        a.zipfiles,
        a.datas,
        strip=False,
        upx=False,
        name="GradeCalculator",
    )
    if sys.platform == "darwin":
        app = BUNDLE(
            coll,
            name="Grade Calculator.app",
            icon=None,
            bundle_identifier="com.winstonbaker.gradecalculator",
            version=__version__,
            info_plist={
                "CFBundleName": "Grade Calculator",
                "CFBundleDisplayName": "Grade Calculator",
                "CFBundleShortVersionString": __version__,
                "CFBundleVersion": __version__,
                "NSHighResolutionCapable": True,
            },
        )
