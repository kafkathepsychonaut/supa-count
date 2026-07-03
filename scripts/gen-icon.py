#!/usr/bin/env python3
"""Gera build/icon.png (1024px) — quadrado arredondado verde Supabase com um
glifo de gauge/barras. Rode: python scripts/gen-icon.py"""
import os
from PIL import Image, ImageDraw

S = 1024
BG = (16, 22, 20, 255)        # #101614 (fundo dark do widget)
GREEN = (62, 207, 142, 255)   # #3ECF8E (verde supabase)
DARK = (12, 31, 22, 255)      # detalhe escuro sobre o verde

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# placa de fundo arredondada
pad = 80
d.rounded_rectangle([pad, pad, S - pad, S - pad], radius=200, fill=BG)

# "gauge" — três barras horizontais de larguras diferentes (uso subindo)
bx = 260
by = 300
bh = 90
gap = 70
widths = [0.75, 0.5, 0.9]
for i, w in enumerate(widths):
    y = by + i * (bh + gap)
    full = S - 2 * bx
    # trilho
    d.rounded_rectangle([bx, y, bx + full, y + bh], radius=bh // 2, fill=(34, 48, 41, 255))
    # preenchido
    d.rounded_rectangle([bx, y, bx + int(full * w), y + bh], radius=bh // 2, fill=GREEN)

out = os.path.join(os.path.dirname(__file__), "..", "build", "icon.png")
os.makedirs(os.path.dirname(out), exist_ok=True)
img.save(out)
print("icon salvo:", os.path.abspath(out))
