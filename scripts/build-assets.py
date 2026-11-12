#!/usr/bin/env python3
"""Turn the layered drawings into the pet's assets.

Every source layer is the same canvas size and lines up with Main.png.
Each layer is cropped to what it draws, scaled down, saved as PNG in
assets/, and its place on the scaled canvas goes into assets/layers.json.

Usage: python3 scripts/build-assets.py [source folder] [--px N] [--out DIR]
  --px N    height of the whole character in pixels (default 900)
  --out DIR where to write (default: ../assets next to this script)
"""
import io
import json
import sys
from pathlib import Path

from PIL import Image

def opt(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


ARGS = [a for i, a in enumerate(sys.argv[1:], 1) if not a.startswith('--') and sys.argv[i - 1] not in ('--px', '--out')]
SRC = Path(ARGS[0] if ARGS else '/home/ocgk123/Pictures/CLaude')
OUT = Path(opt('--out', Path(__file__).resolve().parent.parent / 'assets'))
VIEW_PX = int(opt('--px', 900))

# role -> source file. Draw order: base, eyes, mouth, hair (bangs over the eyes).
LAYERS = {
    'base': 'Main.png',
    'hair': 'Hair.png',
    'eyes_open': 'Eyes.png',
    'eyes_closed': 'down.png',
    'mouth_closed': 'Smile.png',
    'mouth_open': 'Ahhhhhhh.png',
    'mouth_sleep': 'Die.png',
    'eyes_happy': "Smile11'.png",
    'eyes_x': 'Dieeee.png',
    'buddy': '*12312321.png',  # the little friend; Korean file name, matched by glob
}

def src(name):
    hits = sorted(SRC.glob(name)) if '*' in name else [SRC / name]
    return hits[0]


base = Image.open(src(LAYERS['base'])).convert('RGBA')
bx0, by0, bx1, by1 = base.getchannel('A').getbbox()
view = (bx0, by0, bx1, by1)  # the whole character; the app crops to a bust itself
# Widen the view to take in the little friend beside her.
ux0, uy0, ux1, uy1 = Image.open(src(LAYERS['buddy'])).getchannel('A').getbbox()
view = (min(view[0], ux0), view[1], max(view[2], ux1), max(view[3], uy1))
k = VIEW_PX / (view[3] - view[1])

OUT.mkdir(parents=True, exist_ok=True)
for old in list(OUT.glob('*.png')) + list(OUT.glob('layers.json')):
    old.unlink()

manifest = {
    'view': [round(view[0] * k, 2), round(view[1] * k, 2), round((view[2] - view[0]) * k, 2), round((view[3] - view[1]) * k, 2)],
    'layers': {},
}
total = 0
for role, name in LAYERS.items():
    im = Image.open(src(name)).convert('RGBA')
    box = im.getchannel('A').getbbox()
    if role == 'base':
        box = view  # keep only the shown region of the body
    x0, y0, x1, y1 = box
    w, h = max(1, round((x1 - x0) * k)), max(1, round((y1 - y0) * k))
    part = im.crop(box).resize((w, h), Image.LANCZOS)
    part.info = {}  # drop the colour profile the source carries (~3.5 KB each)
    buf = io.BytesIO()
    part.save(buf, 'PNG', optimize=True)
    (OUT / f'{role}.png').write_bytes(buf.getvalue())
    manifest['layers'][role] = [round(x0 * k, 2), round(y0 * k, 2), round((x1 - x0) * k, 2), round((y1 - y0) * k, 2)]
    total += buf.tell()
    print(f'{role:13} {src(name).name:14} {w}x{h}  {buf.tell()} bytes')

(OUT / 'layers.json').write_text(json.dumps(manifest, indent=1))
print(f'total {total} bytes')

# Face icons for the tray and the window: body + open eyes + closed mouth + bangs, cropped square around the eyes.
L = manifest['layers']
bx, by, bw, bh = L['base']
face = Image.new('RGBA', (round(bw), round(bh)), (0, 0, 0, 0))
for role in ('base', 'eyes_open', 'mouth_closed', 'hair'):
    x, y, w, h = L[role]
    part = Image.open(OUT / f'{role}.png').convert('RGBA').resize((max(1, round(w)), max(1, round(h))), Image.LANCZOS)
    face.alpha_composite(part, (round(x - bx), round(y - by)))
ex, ey, ew, eh = L['eyes_open']
cx, cy, half = ex + ew / 2 - bx, ey + eh * 0.35 - by, ew * 0.92
face = face.crop(tuple(round(v) for v in (cx - half, cy - half, cx + half, cy + half)))
for name, px in (('tray.png', 64), ('icon.png', 256)):
    icon = face.resize((px, px), Image.LANCZOS)
    icon.info = {}
    icon.save(OUT / name, optimize=True)
    print(f'{name:13} {px}x{px}')
