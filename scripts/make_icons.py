"""Linkex Motrix のアイコンを描いて PNG と SVG に書き出す（標準ライブラリだけ使う）。

使い方: python make_icons.py <出力フォルダ>
128 x 128 の座標で図形を決め、各サイズへ縮めて塗る。縁は細かく分けて塗り、なめらかにする。
"""
import struct
import sys
import zlib
from pathlib import Path

TOP = (0x2A, 0xB8, 0x80)     # 背景の上の色
BOTTOM = (0x16, 0x82, 0x58)  # 背景の下の色
WHITE = (0xFF, 0xFF, 0xFF)
RADIUS = 28

# 下向き矢印（軸と頭）と、受け皿
SHAFT = (54, 20, 74, 66)                  # x0, y0, x1, y1
HEAD = [(30, 58), (98, 58), (64, 94)]     # 三角形
TRAY = (28, 100, 100, 112, 6)             # x0, y0, x1, y1, 角の丸み


def in_round_rect(x, y, x0, y0, x1, y1, r):
    if not (x0 <= x <= x1 and y0 <= y <= y1):
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def in_triangle(x, y, pts):
    (ax, ay), (bx, by), (cx, cy) = pts
    def side(px, py, qx, qy):
        return (qx - px) * (y - py) - (qy - py) * (x - px)
    d1, d2, d3 = side(ax, ay, bx, by), side(bx, by, cx, cy), side(cx, cy, ax, ay)
    neg = d1 < 0 or d2 < 0 or d3 < 0
    pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (neg and pos)


def in_glyph(x, y):
    return (
        (SHAFT[0] <= x <= SHAFT[2] and SHAFT[1] <= y <= SHAFT[3])
        or in_triangle(x, y, HEAD)
        or in_round_rect(x, y, *TRAY)
    )


def render(size):
    n = 8 if size <= 32 else 4   # 1ピクセルを n x n に分けて塗る
    scale = 128 / size
    rows = []
    for py in range(size):
        row = bytearray([0])  # PNG の行の先頭（フィルタなし）
        for px in range(size):
            bg = glyph = 0
            for sy in range(n):
                for sx in range(n):
                    x = (px + (sx + 0.5) / n) * scale
                    y = (py + (sy + 0.5) / n) * scale
                    if in_round_rect(x, y, 0, 0, 128, 128, RADIUS):
                        bg += 1
                        if in_glyph(x, y):
                            glyph += 1
            total = n * n
            t = (py + 0.5) / size
            base = [TOP[i] + (BOTTOM[i] - TOP[i]) * t for i in range(3)]
            if bg == 0:
                row += bytes(4)
                continue
            mix = glyph / bg
            rgb = [round(base[i] + (WHITE[i] - base[i]) * mix) for i in range(3)]
            row += bytes(rgb + [round(255 * bg / total)])
        rows.append(bytes(row))
    return png(size, size, b"".join(rows))


def png(w, h, raw):
    def chunk(kind, data):
        c = kind + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
    header = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def svg():
    hex_ = lambda c: "#%02x%02x%02x" % c
    tri = " ".join(f"{x},{y}" for x, y in HEAD)
    x0, y0, x1, y1, r = TRAY
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{hex_(TOP)}"/>
      <stop offset="1" stop-color="{hex_(BOTTOM)}"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="{RADIUS}" fill="url(#g)"/>
  <g fill="#fff">
    <rect x="{SHAFT[0]}" y="{SHAFT[1]}" width="{SHAFT[2] - SHAFT[0]}" height="{SHAFT[3] - SHAFT[1]}"/>
    <polygon points="{tri}"/>
    <rect x="{x0}" y="{y0}" width="{x1 - x0}" height="{y1 - y0}" rx="{r}"/>
  </g>
</svg>
"""


if __name__ == "__main__":
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128):
        (out / f"icon-{size}.png").write_bytes(render(size))
    (out / "icon.svg").write_text(svg(), encoding="utf-8")
    print("wrote", sorted(p.name for p in out.iterdir()))
