"""Vygeneruje ikonu aplikace z barev EBC_UI_vibe: brýle VR (oranžová) na tmavém podkladu.

Výstup: public/favicon.svg (záložka prohlížeče) a public/icons/*.png (PWA, Quest, Apple).
Spuštění: python scripts/make-icons.py   (potřebuje Pillow)
"""
import json
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
T = json.loads((ROOT / "src" / "ebc" / "ebc-tokens.dark.json").read_text(encoding="utf-8"))
OUT = ROOT / "public" / "icons"
OUT.mkdir(parents=True, exist_ok=True)


def rgb(h: str) -> tuple:
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def mix(a: str, b: str, t: float) -> str:
    return "#" + "".join(f"{round(x + (y - x) * t):02X}" for x, y in zip(rgb(a), rgb(b)))


BG = T["color.bg.window"]
BORDER = T["color.border.default"]
ACCENT = T["color.accent.default"]
LENS = mix(ACCENT, BG, 0.45)  # čočky: tmavší odstín oranžové

# brýle VR v souřadnicích 0–1 (celá ikona): popruh, tělo, čočky, výřez pro nos
SHAPES = [
    ("rect", (0.08, 0.47, 0.92, 0.53), ACCENT),
    ("rrect", (0.17, 0.32, 0.83, 0.68, 0.11), ACCENT),
    ("ellipse", (0.27, 0.40, 0.45, 0.58), LENS),
    ("ellipse", (0.55, 0.40, 0.73, 0.58), LENS),
    ("ellipse", (0.42, 0.59, 0.58, 0.75), BG),
]
RADIUS = 1 / 6  # zaoblení podkladu


def png(size: int, maskable: bool) -> Image.Image:
    """maskable: podklad přes celou plochu a kresba zmenšená do bezpečné zóny (systém ikonu ořízne)."""
    k = 4  # kreslí se ve 4× a zmenšuje (vyhlazení hran)
    S = size * k
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        d.rectangle([0, 0, S, S], fill=BG)
    else:
        d.rounded_rectangle([0, 0, S - 1, S - 1], S * RADIUS, fill=BG, outline=BORDER, width=max(1, S // 96))
    scale = 0.8 if maskable else 1.0
    off = (1 - scale) / 2

    def X(v):
        return (off + v * scale) * S

    for kind, g, col in SHAPES:
        box = [X(g[0]), X(g[1]), X(g[2]), X(g[3])]
        if kind == "rect":
            d.rectangle(box, fill=col)
        elif kind == "rrect":
            d.rounded_rectangle(box, g[4] * scale * S, fill=col)
        else:
            d.ellipse(box, fill=col)
    return img.resize((size, size), Image.LANCZOS)


def svg() -> str:
    n = lambda v: f"{v * 64:g}"
    out = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">',
        f'  <rect x="0.5" y="0.5" width="63" height="63" rx="{n(RADIUS)}" fill="{BG}" stroke="{BORDER}"/>',
    ]
    for kind, g, col in SHAPES:
        x0, y0, x1, y1 = (v * 64 for v in g[:4])
        if kind == "ellipse":
            out.append(f'  <ellipse cx="{(x0 + x1) / 2:g}" cy="{(y0 + y1) / 2:g}" rx="{(x1 - x0) / 2:g}" ry="{(y1 - y0) / 2:g}" fill="{col}"/>')
        else:
            rx = f' rx="{n(g[4])}"' if kind == "rrect" else ""
            out.append(f'  <rect x="{x0:g}" y="{y0:g}" width="{x1 - x0:g}" height="{y1 - y0:g}"{rx} fill="{col}"/>')
    out.append("</svg>\n")
    return "\n".join(out)


for s in (192, 512):
    png(s, False).save(OUT / f"icon-{s}.png")
    png(s, True).save(OUT / f"icon-maskable-{s}.png")
png(180, True).save(OUT / "apple-touch-icon.png")
(ROOT / "public" / "favicon.svg").write_text(svg(), encoding="utf-8")
print("Ikony uloženy do", OUT, "a public/favicon.svg")
