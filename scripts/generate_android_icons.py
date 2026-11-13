"""Generate Android launcher assets from the selected Production MF SVG icon.

Requires: pip install cairosvg Pillow
Run after 'npx cap sync android' and before Gradle builds.
"""
from io import BytesIO
from pathlib import Path

import cairosvg
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SVG = ROOT / "assets" / "production-mf-icon.svg"
RES = ROOT / "android" / "app" / "src" / "main" / "res"
SIZES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}


def rasterize(size: int) -> Image.Image:
    data = cairosvg.svg2png(url=str(SVG), output_width=size, output_height=size)
    return Image.open(BytesIO(data)).convert("RGBA")


def main() -> None:
    for density, size in SIZES.items():
        directory = RES / f"mipmap-{density}"
        directory.mkdir(parents=True, exist_ok=True)
        rasterize(size).save(directory / "ic_launcher.png")
        rasterize(size).save(directory / "ic_launcher_round.png")
        # Adaptive icons have a 108dp canvas with a central safe area of 72dp.
        foreground_size = round(size * 108 / 48)
        safe_icon_size = round(foreground_size * 0.66)
        foreground = Image.new("RGBA", (foreground_size, foreground_size))
        icon = rasterize(safe_icon_size)
        pos = (foreground_size - safe_icon_size) // 2
        foreground.alpha_composite(icon, (pos, pos))
        foreground.save(directory / "ic_launcher_foreground.png")
    print("Generated Production MF Android launcher icons")


if __name__ == "__main__":
    main()
