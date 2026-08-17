#!/usr/bin/env python3
"""Render the Grade Calculator app icon into every format the builds need.

Run from the repo root after changing the artwork:

    python packaging/make_icons.py

Requires Pillow, and macOS `iconutil` for the .icns bundle icon.
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
PACKAGING = ROOT / "packaging"
FRONTEND_PUBLIC = ROOT / "frontend" / "public"

BG = (18, 19, 26)
GOLD = (228, 184, 109)
BLUE = (139, 180, 232)

SERIF_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Georgia Bold.ttf",
    "/Library/Fonts/Georgia Bold.ttf",
    "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
    "C:/Windows/Fonts/georgiab.ttf",
]

SUPERSAMPLE = 4
# Apple's grid leaves the icon shape inset inside the 1024 canvas; Windows and
# web favicons look better filling the frame.
MAC_INSET = 0.10
# iconutil only accepts these exact names; @2x entries hold double the pixels.
ICNS_ENTRIES = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def serif_font(size: int) -> ImageFont.FreeTypeFont:
    for path in SERIF_CANDIDATES:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    raise SystemExit("No bold serif font found. Add one to SERIF_CANDIDATES.")


def radial_glow(size: int, cx: float, cy: float, radius: float, alpha: float) -> Image.Image:
    """Soft circular falloff, computed small and scaled up."""
    grid = 128
    mask = Image.new("L", (grid, grid))
    px = mask.load()
    for y in range(grid):
        for x in range(grid):
            dx = (x + 0.5) / grid - cx
            dy = (y + 0.5) / grid - cy
            d = (dx * dx + dy * dy) ** 0.5 / radius
            px[x, y] = 0 if d >= 1 else int((1 - d) ** 2 * alpha * 255)
    return mask.resize((size, size), Image.BICUBIC)


def render(size: int, inset: float = 0.0, with_plus: bool = True) -> Image.Image:
    s = size * SUPERSAMPLE
    pad = round(s * inset)
    box = (pad, pad, s - pad - 1, s - pad - 1)
    side = box[2] - box[0]
    radius = round(side * 0.2237)

    shape = Image.new("L", (s, s), 0)
    ImageDraw.Draw(shape).rounded_rectangle(box, radius=radius, fill=255)

    plate = Image.new("RGBA", (s, s), BG + (255,))
    plate.paste(Image.new("RGBA", (s, s), GOLD + (255,)), (0, 0), radial_glow(s, 0.14, 0.02, 0.62, 0.20))
    plate.paste(Image.new("RGBA", (s, s), BLUE + (255,)), (0, 0), radial_glow(s, 0.98, 1.02, 0.55, 0.12))

    letter = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(letter)

    # Size the "A" from its real ink bounds so cap height, not font metrics,
    # controls how much of the plate it fills.
    target_h = side * (0.52 if with_plus else 0.58)
    font = serif_font(round(target_h * 1.35))
    a_box = draw.textbbox((0, 0), "A", font=font)
    scale = target_h / (a_box[3] - a_box[1])
    font = serif_font(max(1, round(font.size * scale)))
    a_box = draw.textbbox((0, 0), "A", font=font)
    a_w, a_h = a_box[2] - a_box[0], a_box[3] - a_box[1]

    plus_font = None
    plus_box = (0, 0, 0, 0)
    plus_w = plus_gap = 0
    if with_plus:
        plus_font = serif_font(max(1, round(font.size * 0.32)))
        plus_box = draw.textbbox((0, 0), "+", font=plus_font)
        plus_w = plus_box[2] - plus_box[0]
        plus_gap = round(side * 0.022)

    # The plus is visually light, so nudge right of true center to keep the "A"
    # looking centered rather than measuring centered.
    group_w = a_w + plus_gap + plus_w
    left = (s - group_w) / 2 + plus_w * 0.15
    top = (s - a_h) / 2

    draw.text((left - a_box[0], top - a_box[1]), "A", font=font, fill=GOLD + (255,))
    if plus_font is not None:
        plus_x = left + a_w + plus_gap - plus_box[0]
        plus_y = top - plus_box[1] + a_h * 0.06
        draw.text((plus_x, plus_y), "+", font=plus_font, fill=BLUE + (255,))

    art = Image.alpha_composite(plate, letter)
    art.putalpha(shape)
    return art.resize((size, size), Image.LANCZOS)


def icon_for(size: int, inset: float) -> Image.Image:
    # The superscript plus turns to mush below 32px, so drop it there.
    return render(size, inset=inset, with_plus=size >= 32)


def write_png(path: Path, size: int, inset: float) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    icon_for(size, inset).save(path)
    print(f"wrote {path.relative_to(ROOT)}")


def write_ico(path: Path) -> None:
    frames = [icon_for(size, 0.0) for size in ICO_SIZES]
    frames[-1].save(path, format="ICO", sizes=[(s, s) for s in ICO_SIZES], append_images=frames[:-1])
    print(f"wrote {path.relative_to(ROOT)}")


def write_icns(path: Path) -> None:
    if sys.platform != "darwin":
        print("skipping icon.icns (needs macOS iconutil)")
        return
    scratch = ROOT / "build"
    scratch.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=scratch) as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        cache: dict[int, Image.Image] = {}
        for name, size in ICNS_ENTRIES:
            if size not in cache:
                cache[size] = icon_for(size, MAC_INSET)
            cache[size].save(iconset / name)
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(path)], check=True)
    print(f"wrote {path.relative_to(ROOT)}")


def main() -> None:
    write_png(PACKAGING / "icon.png", 1024, 0.0)
    write_png(FRONTEND_PUBLIC / "favicon.png", 256, 0.0)
    write_png(FRONTEND_PUBLIC / "apple-touch-icon.png", 180, 0.0)
    write_ico(PACKAGING / "icon.ico")
    write_ico(FRONTEND_PUBLIC / "favicon.ico")
    write_icns(PACKAGING / "icon.icns")


if __name__ == "__main__":
    main()
