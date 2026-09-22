#!/usr/bin/env python3
"""Generate ORVYN brand assets with Pillow.

Outputs:
  apps/desktop/resources/icon.png          512x512 app icon (Electron/NSIS)
  apps/desktop/resources/icon.ico          multi-size Windows icon
  apps/desktop/resources/orvyn-mark.png    transparent hexagon+brackets mark
  apps/desktop/resources/orvyn-lockup.png  mark + ORVYN wordmark (horizontal)
  infrastructure/desktop/assets/orvyn-desktop.png  1920x1080 sandbox wallpaper
  infrastructure/desktop/assets/orvyn-mark.png     mark for in-sandbox use
  infrastructure/desktop/assets/orvyn-lockup.png   lockup for in-sandbox use

Mark: an "O" formed from two code brackets "{" "}" inside a hexagonal ring —
the ORVYN identity, rendered programmatically so it stays original.
"""

import math
import os
import random
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ── ORVYN palette ─────────────────────────────────────────────────────────
NAVY_DEEP = (5, 10, 24)
NAVY = (7, 18, 42)
INDIGO = (16, 25, 74)
CYAN = (34, 211, 238)
SKY = (56, 189, 248)
BLUE = (59, 130, 246)
VIOLET = (139, 92, 246)
LAV = (167, 139, 250)
WHITE = (240, 246, 255)


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def diag_gradient(size, stops):
    """Multi-stop gradient along the top-left → bottom-right diagonal."""
    w, h = size
    img = Image.new("RGB", size)
    px = img.load()
    denom = math.hypot(w, h)
    for y in range(h):
        for x in range(w):
            t = (x + y) / denom
            for i in range(len(stops) - 1):
                p0, c0 = stops[i]
                p1, c1 = stops[i + 1]
                if p0 <= t <= p1:
                    tt = 0 if p1 == p0 else (t - p0) / (p1 - p0)
                    px[x, y] = lerp(c0, c1, tt)
                    break
            else:
                px[x, y] = stops[-1][1]
    return img


def load_font(size, bold=True, mono=True):
    candidates = [
        "C:/Windows/Fonts/consolab.ttf" if bold else "C:/Windows/Fonts/consola.ttf",
        "C:/Windows/Fonts/CascadiaMono.ttf",
        "C:/Windows/Fonts/courbd.ttf" if bold else "C:/Windows/Fonts/cour.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf" if bold
        else "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf",
    ]
    for c in candidates:
        try:
            return ImageFont.truetype(c, size)
        except Exception:
            continue
    return ImageFont.load_default()


def load_sans(size, bold=True):
    candidates = [
        "C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/seguisb.ttf",
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold
        else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for c in candidates:
        try:
            return ImageFont.truetype(c, size)
        except Exception:
            continue
    return ImageFont.load_default()


def hexagon(cx, cy, r, rotation=-90):
    return [
        (cx + r * math.cos(math.radians(rotation + i * 60)),
         cy + r * math.sin(math.radians(rotation + i * 60)))
        for i in range(6)
    ]


def ring_mask(size, outer_pts, inner_pts):
    m = Image.new("L", size, 0)
    d = ImageDraw.Draw(m)
    d.polygon(outer_pts, fill=255)
    d.polygon(inner_pts, fill=0)
    return m


def draw_brackets_mask(size, center, target_h, gap_ratio=0.16):
    """Render '{ }' as a mask — two code brackets forming an O."""
    font = load_font(int(target_h * 1.18))
    tmp = Image.new("L", size, 0)
    d = ImageDraw.Draw(tmp)
    for sign in (-1, 1):
        glyph = "{" if sign < 0 else "}"
        bbox = d.textbbox((0, 0), glyph, font=font)
        gw = bbox[2] - bbox[0]
        gh = bbox[3] - bbox[1]
        x = center[0] + sign * (gap_ratio * target_h + gw / 2)
        y = center[1]
        d.text((x - gw / 2 - bbox[0], y - gh / 2 - bbox[1]), glyph, font=font, fill=255)
    return tmp


def make_mark(size=1024, glow=True):
    """Transparent ORVYN mark: hexagonal ring + '{}' brackets."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    cx = cy = size / 2
    R = size * 0.44
    stroke = size * 0.055

    outer = hexagon(cx, cy, R)
    inner = hexagon(cx, cy, R - stroke)
    mask = ring_mask((size, size), outer, inner)

    grad = diag_gradient((size, size), [(0.0, CYAN), (0.5, BLUE), (1.0, VIOLET)])
    ring = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ring.paste(grad, (0, 0), mask)

    if glow:
        halo = ring.filter(ImageFilter.GaussianBlur(size * 0.02))
        img = Image.alpha_composite(img, halo)
    img = Image.alpha_composite(img, ring)

    # Dark fill inside the hexagon (very subtle, keeps transparency usable).
    fill_mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(fill_mask).polygon(inner, fill=46)
    dark = Image.new("RGBA", (size, size), NAVY_DEEP + (255,))
    inner_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    inner_layer.paste(dark, (0, 0), fill_mask)
    img = Image.alpha_composite(img, inner_layer)

    # Brackets — an "O" from two code brackets, cyan→violet.
    bmask = draw_brackets_mask((size, size), (cx, cy), R * 0.92)
    bgrad = diag_gradient((size, size), [(0.0, WHITE), (0.45, SKY), (1.0, LAV)])
    brackets = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    brackets.paste(bgrad, (0, 0), bmask)
    if glow:
        img = Image.alpha_composite(img, brackets.filter(ImageFilter.GaussianBlur(size * 0.008)))
    img = Image.alpha_composite(img, brackets)
    return img


def make_lockup(mark_size=512):
    mark = make_mark(mark_size)
    font = load_sans(int(mark_size * 0.34))
    tmp = Image.new("RGBA", (10, 10), (0, 0, 0, 0))
    d = ImageDraw.Draw(tmp)
    text = "ORVYN"
    spacing = int(mark_size * 0.045)
    char_w = []
    for ch in text:
        cb = d.textbbox((0, 0), ch, font=font)
        char_w.append(cb[2] - cb[0])
    tw = sum(char_w) + spacing * (len(text) - 1)
    th = d.textbbox((0, 0), text, font=font)[3]
    pad = int(mark_size * 0.14)
    w = mark_size + pad + tw + int(mark_size * 0.08)
    h = max(mark_size, th + int(mark_size * 0.2))
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    img.paste(mark, (0, (h - mark_size) // 2), mark)
    d = ImageDraw.Draw(img)
    tx = mark_size + pad
    ty = (h - th) / 2
    for ch, cw in zip(text, char_w):
        d.text((tx, ty), ch, font=font, fill=WHITE + (255,))
        tx += cw + spacing
    return img


def rounded_rect_mask(size, radius):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=255)
    return m


def make_app_icon(size):
    """Rounded-tile app icon. ≤48px: tile + brackets only (legibility)."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    tile = diag_gradient((size, size), [(0.0, (11, 20, 48)), (0.55, (9, 15, 38)), (1.0, (24, 16, 64))])
    mask = rounded_rect_mask((size, size), int(size * 0.22))
    img.paste(tile, (0, 0), mask)

    # Subtle top glow
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([size * 0.1, -size * 0.35, size * 0.9, size * 0.35], fill=CYAN + (60,))
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.12))
    img = Image.alpha_composite(Image.composite(glow, img, mask), img)

    if size <= 48:
        # Simple, legible: gradient brackets only.
        bmask = draw_brackets_mask((size, size), (size / 2, size / 2), size * 0.52)
        bgrad = diag_gradient((size, size), [(0.0, CYAN), (1.0, VIOLET)])
        b = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        b.paste(bgrad, (0, 0), bmask)
        img = Image.alpha_composite(img, Image.composite(b, Image.new("RGBA", (size, size), (0, 0, 0, 0)), mask))
        return img

    mark = make_mark(int(size * 0.66)).resize((int(size * 0.66), int(size * 0.66)), Image.LANCZOS)
    img.alpha_composite(mark, (int((size - mark.width) / 2), int((size - mark.height) / 2)))

    # Crop to tile shape.
    final = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    final.paste(img, (0, 0), mask)
    return final


# ── Wallpaper ─────────────────────────────────────────────────────────────

def glow_dot(layer, x, y, r, color, alpha=255):
    halo = Image.new("RGBA", layer.size, (0, 0, 0, 0))
    ImageDraw.Draw(halo).ellipse([x - r, y - r, x + r, y + r], fill=color + (alpha,))
    halo = halo.filter(ImageFilter.GaussianBlur(r * 0.9))
    layer.alpha_composite(halo)
    d = ImageDraw.Draw(layer)
    d.ellipse([x - r * 0.32, y - r * 0.32, x + r * 0.32, y + r * 0.32], fill=color + (alpha,))


def planet(layer, cx, cy, r, base, rim_color, rim_angle, seed=0):
    """A rim-lit planet: dark body, bright arc on rim_angle side, atmosphere halo."""
    rnd = random.Random(seed)
    W, H = layer.size
    disc = Image.new("L", (W, H), 0)
    ImageDraw.Draw(disc).ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)

    # Body: dark center → limb lit toward rim_angle (terminator-style lighting).
    body = Image.new("RGB", (W, H), (0, 0, 0))
    bp = body.load()
    dark = tuple(int(c * 0.45) for c in base)
    lit = lerp(base, rim_color, 0.55)
    la = math.radians(rim_angle)
    lx, ly = math.cos(la), math.sin(la)
    for y in range(max(0, int(cy - r)), min(H, int(cy + r))):
        for x in range(max(0, int(cx - r)), min(W, int(cx + r))):
            dist = math.hypot(x - cx, y - cy) / r
            if dist <= 1:
                ndl = max(0.0, ((x - cx) * lx + (y - cy) * ly) / (dist * r + 1e-6))
                limb = max(0.0, min(1.0, (dist - 0.45) / 0.55))
                t = limb * (0.25 + 0.75 * ndl)
                bp[x, y] = lerp(lerp(base, dark, min(1, dist * 0.7)), lit, t * 0.9)
    # Surface texture: faint bright banding clipped to the disc.
    tex = Image.new("L", (W, H), 0)
    td = ImageDraw.Draw(tex)
    for _ in range(90):
        yy = cy - r + rnd.random() * 2 * r
        wdt = r * (0.3 + rnd.random() * 0.7)
        td.arc([cx - wdt, yy - r * 0.12, cx + wdt, yy + r * 0.12], 0, 360, fill=rnd.randint(30, 70))
    tex = tex.filter(ImageFilter.GaussianBlur(3))
    body_l = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    body_l.paste(body, (0, 0), disc)
    layer.alpha_composite(body_l)
    tex_rgba = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    tex_mask = Image.composite(tex, Image.new("L", (W, H), 0), disc)
    tex_rgba.paste(Image.new("RGB", (W, H), lit), (0, 0), tex_mask)
    layer.alpha_composite(tex_rgba)

    # Atmosphere halo.
    halo = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(halo).ellipse([cx - r * 1.035, cy - r * 1.035, cx + r * 1.035, cy + r * 1.035],
                                 outline=rim_color + (110,), width=max(2, int(r * 0.012)))
    halo = halo.filter(ImageFilter.GaussianBlur(r * 0.03))
    layer.alpha_composite(halo)

    # Rim light arc.
    rim = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    rd = ImageDraw.Draw(rim)
    a = math.radians(rim_angle)
    rd.arc([cx - r, cy - r, cx + r, cy + r], rim_angle - 55, rim_angle + 55,
           fill=rim_color + (235,), width=max(3, int(r * 0.016)))
    rim = rim.filter(ImageFilter.GaussianBlur(r * 0.012))
    layer.alpha_composite(rim)
    # Hot spot on the rim.
    hx, hy = cx + r * math.cos(a), cy + r * math.sin(a)
    hot = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(hot).ellipse([hx - r * 0.06, hy - r * 0.06, hx + r * 0.06, hy + r * 0.06],
                                fill=(255, 255, 255, 200))
    layer.alpha_composite(hot.filter(ImageFilter.GaussianBlur(r * 0.04)))


def hex_net(layer, w, h):
    """Hexagonal wireframe network with an isometric cube — ORVYN compute motif."""
    lines = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(lines)
    nodes = []

    big_cx, big_cy, big_r = w * 0.34, h * 0.40, w * 0.115
    big = hexagon(big_cx, big_cy, big_r)
    d.polygon(big, outline=CYAN + (150,), width=3)

    # Inner hexagon + isometric cube.
    inner = hexagon(big_cx, big_cy, big_r * 0.62)
    d.polygon(inner, outline=BLUE + (120,), width=2)
    s = big_r * 0.34
    cx, cy = big_cx, big_cy
    # Cube: three rhombi.
    top = [(cx, cy - s), (cx + s * 0.87, cy - s * 0.5), (cx, cy), (cx - s * 0.87, cy - s * 0.5)]
    left = [(cx - s * 0.87, cy - s * 0.5), (cx, cy), (cx, cy + s), (cx - s * 0.87, cy + s * 0.5)]
    right = [(cx, cy), (cx + s * 0.87, cy - s * 0.5), (cx + s * 0.87, cy + s * 0.5), (cx, cy + s)]
    for face, col in ((top, SKY), (left, BLUE), (right, VIOLET)):
        d.polygon(face, outline=col + (190,), width=2)
    nodes.append((big_cx, big_cy, CYAN))

    # Satellite hexagons + connecting lines (network graph).
    satellites = [
        (big_cx + big_r * 1.9, big_cy - big_r * 1.5, big_r * 0.42),
        (big_cx + big_r * 2.6, big_cy - big_r * 0.2, big_r * 0.30),
        (big_cx - big_r * 1.4, big_cy - big_r * 1.7, big_r * 0.34),
        (big_cx + big_r * 1.1, big_cy - big_r * 2.6, big_r * 0.22),
        (big_cx - big_r * 0.6, big_cy - big_r * 2.9, big_r * 0.16),
    ]
    for i, (sx, sy, sr) in enumerate(satellites):
        pts = hexagon(sx, sy, sr)
        col = CYAN if i % 2 == 0 else VIOLET
        d.polygon(pts, outline=col + (110,), width=2)
        d.line([(big_cx, big_cy - big_r * 0.4), (sx, sy)], fill=col + (70,), width=1)
        nodes.append((sx, sy, col))

    # Extra faint graph links across the sky.
    extra = [
        (w * 0.55, h * 0.18), (w * 0.70, h * 0.30), (w * 0.60, h * 0.42),
        (w * 0.18, h * 0.62), (w * 0.30, h * 0.70), (w * 0.12, h * 0.30),
    ]
    for i in range(len(extra) - 1):
        d.line([extra[i], extra[i + 1]], fill=SKY + (40,), width=1)
    for ex, ey in extra:
        nodes.append((ex, ey, SKY))

    glow = lines.filter(ImageFilter.GaussianBlur(4))
    layer.alpha_composite(glow)
    layer.alpha_composite(lines)
    for nx, ny, col in nodes:
        glow_dot(layer, nx, ny, 7, col)


def make_wallpaper(w=1920, h=1080):
    img = diag_gradient((w, h), [(0.0, NAVY_DEEP), (0.45, NAVY), (0.8, INDIGO), (1.0, (10, 14, 40))])
    layer = img.convert("RGBA")

    # Nebula wisps.
    neb = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    nd = ImageDraw.Draw(neb)
    rnd = random.Random(7)
    for _ in range(6):
        cx, cy = rnd.random() * w, rnd.random() * h
        rw, rh = w * (0.12 + rnd.random() * 0.2), h * (0.08 + rnd.random() * 0.16)
        col = VIOLET if rnd.random() < 0.5 else BLUE
        nd.ellipse([cx - rw, cy - rh, cx + rw, cy + rh], fill=col + (14,))
    layer.alpha_composite(neb.filter(ImageFilter.GaussianBlur(80)))

    # Stars.
    star_l = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    sd = ImageDraw.Draw(star_l)
    for _ in range(520):
        x, y = rnd.random() * w, rnd.random() * h
        b = rnd.randint(60, 220)
        r = 1 if rnd.random() < 0.85 else 2
        sd.ellipse([x - r, y - r, x + r, y + r], fill=(b, b, min(255, b + 30), 255))
    for _ in range(26):  # cross sparkles
        x, y = rnd.random() * w, rnd.random() * h
        L = rnd.randint(4, 9)
        sd.line([(x - L, y), (x + L, y)], fill=(220, 235, 255, 160), width=1)
        sd.line([(x, y - L), (x, y + L)], fill=(220, 235, 255, 160), width=1)
    layer.alpha_composite(star_l)

    # Planets: large blue bottom-right, violet bottom-left, limb top-right.
    planet(layer, w * 1.00, h * 1.02, w * 0.42, (13, 32, 84), SKY, 218, seed=11)
    planet(layer, -w * 0.03, h * 1.00, w * 0.30, (34, 20, 84), LAV, 300, seed=23)
    planet(layer, w * 0.99, -h * 0.02, w * 0.20, (10, 26, 70), BLUE, 130, seed=31)

    # Hexagonal network.
    hex_net(layer, w, h)

    # Subtle ORVYN mark bottom-left.
    mark = make_mark(256).resize((150, 150), Image.LANCZOS)
    mark.putalpha(mark.split()[3].point(lambda a: int(a * 0.5)))
    layer.alpha_composite(mark, (int(w * 0.025), int(h * 0.86)))
    d = ImageDraw.Draw(layer)
    font = load_sans(int(h * 0.028))
    d.text((w * 0.025 + 168, h * 0.86 + 52), "O R V Y N", font=font, fill=(200, 215, 245, 110))

    return layer.convert("RGB")


def indicator_pngs(out_dir):
    """Tiny top-panel indicator glyphs (wifi, volume, power) drawn at 4x and
    downscaled — deterministic look, no icon-theme dependency."""
    os.makedirs(out_dir, exist_ok=True)
    S = 88  # render size, downscaled to 22
    col = (214, 226, 250, 235)

    def downscale(img, name):
        img.resize((22, 22), Image.LANCZOS).save(os.path.join(out_dir, name + ".png"))

    # wifi: three arcs + dot
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy = S / 2, S * 0.72
    for i, r in enumerate((S * 0.52, S * 0.36, S * 0.20)):
        d.arc([cx - r, cy - r, cx + r, cy + r], 215, 325, fill=col, width=7)
    d.ellipse([cx - 6, cy - 6, cx + 6, cy + 6], fill=col)
    downscale(img, "wifi")

    # volume: speaker + waves
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.polygon([(S * 0.16, S * 0.40), (S * 0.34, S * 0.40), (S * 0.54, S * 0.24),
               (S * 0.54, S * 0.76), (S * 0.34, S * 0.60), (S * 0.16, S * 0.60)], fill=col)
    for r in (S * 0.20, S * 0.32):
        d.arc([S * 0.52 - r * 0.3, S / 2 - r, S * 0.52 + r, S / 2 + r], 305, 55, fill=col, width=6)
    downscale(img, "volume")

    # power: broken ring + stem
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.arc([S * 0.20, S * 0.22, S * 0.80, S * 0.88], 140, 400, fill=col, width=8)
    d.line([(S / 2, S * 0.12), (S / 2, S * 0.52)], fill=col, width=8)
    downscale(img, "power")


def main():
    res_dir = os.path.join(REPO, "apps", "desktop", "resources")
    infra_dir = os.path.join(REPO, "infrastructure", "desktop", "assets")
    os.makedirs(res_dir, exist_ok=True)
    os.makedirs(infra_dir, exist_ok=True)

    mark = make_mark(1024)
    lockup = make_lockup(512)

    for out in (os.path.join(res_dir, "orvyn-mark.png"), os.path.join(infra_dir, "orvyn-mark.png")):
        mark.save(out)
    for out in (os.path.join(res_dir, "orvyn-lockup.png"), os.path.join(infra_dir, "orvyn-lockup.png")):
        lockup.save(out)

    # App icon.
    icon512 = make_app_icon(512)
    icon512.save(os.path.join(res_dir, "icon.png"))
    sizes = [16, 24, 32, 48, 64, 128, 256]
    icons = [make_app_icon(s) for s in sizes]
    icons[0].save(
        os.path.join(res_dir, "icon.ico"),
        sizes=[(s, s) for s in sizes],
        append_images=icons[1:],
    )

    # Wallpaper (1920 master; feh scales to the session resolution).
    make_wallpaper(1920, 1080).save(os.path.join(infra_dir, "orvyn-desktop.png"), optimize=True)
    make_wallpaper(1280, 720).save(os.path.join(infra_dir, "orvyn-desktop-720.png"), optimize=True)

    indicator_pngs(os.path.join(infra_dir, "indicators"))

    print("Generated:")
    for f in sorted(os.listdir(infra_dir)) + sorted(os.listdir(res_dir)):
        print("  ", f)


if __name__ == "__main__":
    sys.exit(main())
