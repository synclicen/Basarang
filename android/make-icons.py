#!/usr/bin/env python3
"""Generator ikon launcher Basarang (replikasi public/favicon.svg).

Menghasilkan:
  res/mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png    (legacy, 48..192)
  res/mipmap-{dens}/ic_launcher_fg.png                           (adaptive foreground, 108..432)
"""
from PIL import Image, ImageDraw
import os

HERE = os.path.dirname(os.path.abspath(__file__))

BG_TOP = (42, 27, 77)     # 2A1B4D
BG_BOT = (23, 16, 43)     # 17102B
GOLD_HI = (245, 208, 111) # F5D06F
GOLD_MID = (232, 181, 77) # E8B54D
GOLD_LO = (201, 147, 43)  # C9932B


def gradient(size, top, bottom):
    g = Image.new('RGB', (size, size))
    px = g.load()
    for y in range(size):
        t = y / max(1, size - 1)
        c = tuple(round(a + (b - a) * t) for a, b in zip(top, bottom))
        for x in range(size):
            px[x, y] = c
    return g


def draw_glyph(draw, k):
    """Glyph teleprompter dari favicon.svg, digambar pada skala k (64-unit koordinat)."""
    w = max(2, round(3.4 * k))
    # layar (rect 15,15 34x23 r5, stroke 4) — stroke diperluas setengah lebar ke luar
    sw = 4 * k
    x0, y0 = 15 * k - sw / 2, 15 * k - sw / 2
    x1, y1 = 49 * k + sw / 2, 38 * k + sw / 2
    draw.rounded_rectangle([x0, y0, x1, y1], radius=5 * k + sw / 2, outline=GOLD_MID, width=max(2, round(sw)))
    # garis isi layar
    draw.line([(23 * k, 22.5 * k), (37 * k, 22.5 * k)], fill=GOLD_MID, width=w)
    draw.ellipse([(23 * k - w / 2, 22.5 * k - w / 2), (23 * k + w / 2, 22.5 * k + w / 2)], fill=GOLD_MID)
    draw.ellipse([(37 * k - w / 2, 22.5 * k - w / 2), (37 * k + w / 2, 22.5 * k + w / 2)], fill=GOLD_MID)
    draw.line([(23 * k, 29 * k), (31 * k, 29 * k)], fill=GOLD_MID, width=w)
    draw.ellipse([(23 * k - w / 2, 29 * k - w / 2), (23 * k + w / 2, 29 * k + w / 2)], fill=GOLD_MID)
    draw.ellipse([(31 * k - w / 2, 29 * k - w / 2), (31 * k + w / 2, 29 * k + w / 2)], fill=GOLD_MID)
    # kaki
    draw.line([(32 * k, 38 * k), (32 * k, 45 * k)], fill=GOLD_MID, width=w)
    draw.ellipse([(32 * k - w / 2, 38 * k - w / 2), (32 * k + w / 2, 38 * k + w / 2)], fill=GOLD_MID)
    draw.ellipse([(32 * k - w / 2, 45 * k - w / 2), (32 * k + w / 2, 45 * k + w / 2)], fill=GOLD_MID)
    draw.line([(24 * k, 45 * k), (40 * k, 45 * k)], fill=GOLD_MID, width=w)
    draw.ellipse([(24 * k - w / 2, 45 * k - w / 2), (24 * k + w / 2, 45 * k + w / 2)], fill=GOLD_MID)
    draw.ellipse([(40 * k - w / 2, 45 * k - w / 2), (40 * k + w / 2, 45 * k + w / 2)], fill=GOLD_MID)


def make_legacy():
    """Ikon legacy: kotak membulat + gradien ungu + bingkai emas + glyph."""
    S = 1024
    img = gradient(S, BG_TOP, BG_BOT).convert('RGBA')
    d = ImageDraw.Draw(img)
    # diag: tambah tint diagonal lembut
    overlay = Image.new('L', (S, S), 0)
    od = ImageDraw.Draw(overlay)
    od.polygon([(0, 0), (S, 0), (0, S)], fill=26)
    img = Image.composite(gradient(S, BG_BOT, BG_TOP).convert('RGBA'), img, overlay.point(lambda p: p))
    d = ImageDraw.Draw(img)
    bw = round(2.5 / 64 * S * 2.2)
    d.rounded_rectangle([bw, bw, S - bw, S - bw], radius=round(14 / 64 * S), outline=GOLD_MID, width=bw)
    draw_glyph(d, S / 64 * 0.86)
    # glyph sedikit di bawah-tengah agar seimbang dengan bingkai
    # sudut membulat + alpha
    mask = Image.new('L', (S, S), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, S, S], radius=round(14 / 64 * S), fill=255)
    img.putalpha(mask)
    return img


def make_fg():
    """Adaptive foreground: glyph saja di tengah, area aman ~55%."""
    S = 1024
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    k = (S * 0.62) / 64
    ox = (S - 64 * k) / 2
    oy = (S - 64 * k) / 2
    tmp = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    td = ImageDraw.Draw(tmp)
    draw_glyph(td, k)
    img.alpha_composite(tmp, (round(ox - 0), round(oy - 2 * k)))
    return img


def main():
    legacy = make_legacy()
    fg = make_fg()
    densities = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
    fg_sizes = {'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432}
    for dens, size in densities.items():
        p = os.path.join(HERE, 'res', 'mipmap-' + dens, 'ic_launcher.png')
        legacy.resize((size, size), Image.LANCZOS).save(p)
        print('tulis', p)
    for dens, size in fg_sizes.items():
        p = os.path.join(HERE, 'res', 'mipmap-' + dens, 'ic_launcher_fg.png')
        fg.resize((size, size), Image.LANCZOS).save(p)
        print('tulis', p)
    print('IKON SELESAI')


if __name__ == '__main__':
    main()
