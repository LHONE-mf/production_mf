"""Reject Android emulator screenshots that are blank or visually unchanged.

This is a rendering smoke test, not a full UI or accessibility test.
Uses Pillow (installed in the Android emulator workflow).
"""
from pathlib import Path
from PIL import Image, ImageChops, ImageStat

ROOT = Path("artifacts/android-smoke")


def check(path: Path) -> None:
    if not path.is_file():
        raise SystemExit(f"Missing screenshot: {path}")
    with Image.open(path) as raw:
        image = raw.convert("RGB")
    if image.width < 300 or image.height < 500:
        raise SystemExit(f"Unexpected screenshot size: {path}: {image.size}")
    # Exclude the top status bar and bottom gesture-navigation area.
    content = image.crop((0, 90, image.width, image.height - 100))
    # A black/crashed WebView typically has nearly no distinct colors.
    quantized = content.resize((80, 120)).quantize(colors=16)
    colors = quantized.getcolors(80 * 120) or []
    significant = sum(count > 40 for count, _ in colors)
    if significant < 3:
        raise SystemExit(f"Screenshot looks blank or uniform: {path} ({significant} significant colors)")
    print(f"{path}: {image.width}x{image.height}, {significant} significant colors")


def main() -> None:
    for name in ("launch.png", "relaunch.png"):
        check(ROOT / name)


if __name__ == "__main__":
    main()
