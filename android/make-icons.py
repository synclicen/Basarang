#!/usr/bin/env python3
"""Ikon peluncur Basarang — latar ungu gelap #120C22, huruf B emas.
Selaras palet aplikasi (emas/ungu). Output: mipmap-{m,h,xh,xxh,xxxh}dpi."""
from PIL import Image, ImageDraw, ImageFont
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

BG_TOP = (30, 20, 54)      # #1E1436 ungu gelap (gradasi atas)
BG_BOT = (13, 8, 26)       # #0D081A (gradasi bawah)
GOLD = (232, 190, 92)      # emas lembut
GOLD_HI = (255, 219, 140)

SIZES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}


def rounded_rect_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def make_icon(px):
    # kanvas transparan + kartu sudut bulat (mask dipakai di akhir)
    img = Image.new("RGBA", (px, px), (0, 0, 0, 0))

    # gradasi latar
    grad = Image.new("RGBA", (px, px))
    gd = ImageDraw.Draw(grad)
    for y in range(px):
        t = y / max(1, px - 1)
        r = int(BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t)
        g = int(BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t)
        b = int(BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t)
        gd.line([(0, y), (px, y)], fill=(r, g, b, 255))

    # bingkai tipis emas
    ring_w = max(2, px // 32)
    brd = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    bd = ImageDraw.Draw(brd)
    bd.rounded_rectangle(
        [0, 0, px - 1, px - 1],
        radius=int(px * 0.22),
        outline=(232, 190, 92, 200),
        width=ring_w,
    )

    # huruf B emas dengan bayangan lembut
    font = ImageFont.truetype(FONT, int(px * 0.62))
    letter = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    ld = ImageDraw.Draw(letter)
    bbox = ld.textbbox((0, 0), "B", font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (px - w) / 2 - bbox[0]
    y = (px - h) / 2 - bbox[1]
    # bayangan
    ld.text((x + px * 0.015, y + px * 0.02), "B", font=font, fill=(0, 0, 0, 140))
    # huruf utama emas
    ld.text((x, y), "B", font=font, fill=GOLD + (255,))

    # titik aksen kecil (indikator rekaman) di kanan-bawah huruf
    dot = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    dd = ImageDraw.Draw(dot)
    dr = max(3, px // 14)
    dcx, dcy = int(px * 0.72), int(px * 0.76)
    dd.ellipse([dcx - dr, dcy - dr, dcx + dr, dcy + dr], fill=GOLD_HI + (255,))

    out = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    out.paste(grad, (0, 0))
    out = Image.alpha_composite(out, brd)
    out = Image.alpha_composite(out, letter)
    out = Image.alpha_composite(out, dot)

    # terapkan mask sudut bulat
    mask = rounded_rect_mask(px, int(px * 0.22))
    final = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    final.paste(out, (0, 0), mask)
    return final


def main():
    for dpi, px in SIZES.items():
        d = os.path.join(ROOT, "res", "mipmap-" + dpi)
        os.makedirs(d, exist_ok=True)
        make_icon(px).save(os.path.join(d, "ic_launcher.png"))
        print(f"mipmap-{dpi}/ic_launcher.png  {px}x{px}")


if __name__ == "__main__":
    main()
