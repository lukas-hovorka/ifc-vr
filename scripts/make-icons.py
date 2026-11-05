"""Vygeneruje ikony aplikace (public/icons/*.png) z barev EBC_UI_vibe.

Spuštění: python scripts/make-icons.py   (potřebuje Pillow a písmo Segoe UI ve Windows)
"""
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
T = json.loads((ROOT / "src" / "ebc" / "ebc-tokens.dark.json").read_text(encoding="utf-8"))
OUT = ROOT / "public" / "icons"
OUT.mkdir(parents=True, exist_ok=True)
FONT = "C:/Windows/Fonts/segoeuisl.ttf"  # Segoe UI Semilight – blízko řezu 300 názvu aplikace


def icon(size: int, maskable: bool) -> Image.Image:
    img = Image.new("RGB", (size, size), T["color.bg.window"])
    d = ImageDraw.Draw(img)
    if not maskable:
        # tenký rámeček jako karta EBC
        r = size // 8
        img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        d.rounded_rectangle([0, 0, size - 1, size - 1], r, fill=T["color.bg.window"],
                            outline=T["color.border.default"], width=max(1, size // 96))
    safe = 0.62 if maskable else 0.78  # maskovatelná ikona musí mít obsah v bezpečné zóně
    font = ImageFont.truetype(FONT, int(size * 0.3))
    a, b = "ifc", ".vr"
    wa = d.textlength(a, font=font)
    wb = d.textlength(b, font=font)
    scale = min(1.0, size * safe / (wa + wb))
    font = ImageFont.truetype(FONT, int(size * 0.3 * scale))
    wa, wb = d.textlength(a, font=font), d.textlength(b, font=font)
    x = (size - wa - wb) / 2
    y = size / 2
    d.text((x, y), a, font=font, fill=T["color.text.accent"], anchor="lm")
    d.text((x + wa, y), b, font=font, fill=T["color.text.primary"], anchor="lm")
    # oranžová linka pod názvem
    lw = max(2, size // 64)
    d.rectangle([x, y + size * 0.14, x + wa + wb, y + size * 0.14 + lw], fill=T["color.accent.default"])
    return img


for s in (192, 512):
    icon(s, False).save(OUT / f"icon-{s}.png")
    icon(s, True).save(OUT / f"icon-maskable-{s}.png")
icon(180, True).save(OUT / "apple-touch-icon.png")
print("Ikony uloženy do", OUT)
