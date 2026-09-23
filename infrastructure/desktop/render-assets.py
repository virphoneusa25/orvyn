#!/usr/bin/env python3
"""Build the session wallpaper and dock glyphs from the checked-in brand art."""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
ICONS = ASSETS / "icons"
SANS = "/usr/share/fonts/truetype/macos/Inter-SemiBold.ttf"
MED = "/usr/share/fonts/truetype/macos/Inter-Medium.ttf"
REG = "/usr/share/fonts/truetype/macos/Inter-Regular.ttf"
FALLBACK = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def face(path: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path if Path(path).exists() else FALLBACK, size)


def session_wallpaper() -> None:
    base = Image.open(ASSETS / "orvyn-desktop-720.png").convert("RGBA")
    patch = base.crop((820, 0, 1240, 460)).resize((560, 450), Image.Resampling.LANCZOS)
    patch = patch.filter(ImageFilter.GaussianBlur(8))
    mask = Image.new("L", patch.size, 0)
    draw_mask = ImageDraw.Draw(mask)
    draw_mask.rectangle([0, 0, 560, 450], fill=255)
    for i in range(48):
        alpha = int(255 * (i / 48))
        draw_mask.line([(560 - 48 + i, 0), (560 - 48 + i, 450)], fill=alpha)
        draw_mask.line([(0, 450 - 48 + i), (560, 450 - 48 + i)], fill=alpha)
    base.paste(patch, (80, 0), mask)

    brand_path = ASSETS / "orvyn-brand.png"
    mark = Image.open(brand_path if brand_path.exists() else ASSETS / "orvyn-mark.png").convert("RGBA")
    mark = mark.crop(mark.getbbox()).resize((140, 140), Image.Resampling.LANCZOS)
    base.alpha_composite(mark, (948, 226))
    draw = ImageDraw.Draw(base)
    draw.text((1104, 258), "ORVYN", font=face(SANS, 30), fill=(244, 247, 255, 255))
    draw.text((1104, 298), "BUILD FASTER", font=face(MED, 13), fill=(220, 228, 242, 240))
    draw.text((1104, 316), "TOGETHER", font=face(MED, 13), fill=(220, 228, 242, 240))
    draw.text((948, 646), "A MORE CAPABLE TOMORROW", font=face(REG, 12), fill=(196, 208, 226, 220))
    base.convert("RGB").save(ASSETS / "orvyn-session.png", "PNG", optimize=True)


TILE = (12, 20, 40)


def opaque_icon(kind: str) -> Image.Image:
    """Fully opaque tiles. tint2 has no compositor, so transparent PNGs paint as beige blocks."""
    img = Image.new("RGB", (64, 64), TILE)
    draw = ImageDraw.Draw(img)
    if kind == "firefox":
        draw.ellipse([6, 6, 58, 58], fill=(0, 96, 223))
        draw.pieslice([6, 6, 58, 58], 210, 20, fill=(255, 113, 57))
        draw.ellipse([24, 24, 40, 40], fill=(255, 255, 255))
    elif kind == "terminal":
        draw.rounded_rectangle([5, 8, 59, 56], radius=8, fill=(15, 23, 42))
        draw.line([(16, 22), (28, 32), (16, 42)], fill=(56, 189, 248), width=3)
        draw.line([(32, 42), (48, 42)], fill=(226, 232, 240), width=3)
    elif kind == "folder":
        draw.rounded_rectangle([8, 22, 56, 52], radius=5, fill=(59, 130, 246))
        draw.polygon([(8, 26), (18, 14), (34, 14), (38, 24), (8, 24)], fill=(147, 197, 253))
    elif kind == "code":
        draw.rounded_rectangle([4, 4, 60, 60], radius=12, fill=(37, 99, 235))
        draw.line([(28, 18), (16, 32), (28, 46)], fill=(255, 255, 255), width=3)
        draw.line([(36, 18), (48, 32), (36, 46)], fill=(255, 255, 255), width=3)
    elif kind == "grid":
        for row in range(3):
            for col in range(3):
                x = 14 + col * 14
                y = 14 + row * 14
                draw.rounded_rectangle([x, y, x + 9, y + 9], radius=2, fill=(236, 242, 250))
    return img


def icons() -> None:
    ICONS.mkdir(parents=True, exist_ok=True)
    for name in ("firefox", "terminal", "folder", "code", "grid"):
        opaque_icon(name).save(ICONS / f"{name}.png", "PNG")


def main() -> None:
    session_wallpaper()
    icons()
    print(f"wrote {ASSETS / 'orvyn-session.png'} and {ICONS}")


if __name__ == "__main__":
    main()
