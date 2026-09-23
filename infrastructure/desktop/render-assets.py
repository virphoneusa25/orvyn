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

    mark = Image.open(ASSETS / "orvyn-mark.png").convert("RGBA")
    mark = mark.crop(mark.getbbox()).resize((124, 124), Image.Resampling.LANCZOS)
    base.alpha_composite(mark, (968, 236))
    draw = ImageDraw.Draw(base)
    draw.text((1104, 258), "ORVYN", font=face(SANS, 30), fill=(244, 247, 255, 255))
    draw.text((1104, 298), "BUILD FASTER", font=face(MED, 13), fill=(220, 228, 242, 240))
    draw.text((1104, 316), "TOGETHER", font=face(MED, 13), fill=(220, 228, 242, 240))
    draw.text((948, 646), "A MORE CAPABLE TOMORROW", font=face(REG, 12), fill=(196, 208, 226, 220))
    base.convert("RGB").save(ASSETS / "orvyn-session.png", "PNG", optimize=True)


def glyph(draw: ImageDraw.ImageDraw, kind: str, color: tuple[int, int, int, int]) -> None:
    if kind == "home":
        draw.polygon([(32, 26), (12, 42), (52, 42)], fill=color)
        draw.rectangle([18, 40, 46, 56], fill=color)
        draw.rectangle([28, 46, 36, 56], fill=(11, 16, 32, 255))
    elif kind == "folder":
        draw.rounded_rectangle([10, 24, 54, 54], radius=5, fill=color)
        draw.polygon([(10, 28), (20, 16), (34, 16), (34, 26), (10, 26)], fill=color)
    elif kind == "trash":
        draw.rectangle([22, 14, 42, 18], fill=color)
        draw.rectangle([16, 18, 48, 22], fill=color)
        draw.rounded_rectangle([18, 24, 46, 54], radius=3, fill=color)
    elif kind == "terminal":
        draw.rounded_rectangle([6, 10, 58, 54], radius=10, fill=(15, 23, 42, 255))
        draw.line([(18, 26), (30, 34), (18, 42)], fill=(56, 189, 248, 255), width=3)
        draw.line([(34, 42), (46, 42)], fill=(226, 232, 240, 255), width=3)
    elif kind == "grid":
        for row in range(3):
            for col in range(3):
                x = 14 + col * 14
                y = 14 + row * 14
                draw.rounded_rectangle([x, y, x + 8, y + 8], radius=2, fill=color)
    elif kind == "code":
        draw.rounded_rectangle([8, 8, 56, 56], radius=10, fill=(37, 99, 235, 255))
        draw.line([(26, 20), (16, 32), (26, 44)], fill=(255, 255, 255, 255), width=3)
        draw.line([(38, 20), (48, 32), (38, 44)], fill=(255, 255, 255, 255), width=3)


def icons() -> None:
    ICONS.mkdir(parents=True, exist_ok=True)
    white = (236, 242, 250, 255)
    for name, color in {
        "home": white,
        "folder": (96, 165, 250, 255),
        "trash": white,
        "terminal": white,
        "grid": white,
        "code": white,
    }.items():
        img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
        glyph(ImageDraw.Draw(img), name, color)
        img.save(ICONS / f"{name}.png", "PNG")


def main() -> None:
    session_wallpaper()
    icons()
    print(f"wrote {ASSETS / 'orvyn-session.png'} and {ICONS}")


if __name__ == "__main__":
    main()
