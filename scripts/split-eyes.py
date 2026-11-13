#!/usr/bin/env python3
"""뜬 눈 그림(assets/eyes_open.png)을 마우스 따라보기용 세 장으로 나눈다.

  eyes_white.png  흰자와 눈꺼풀 선. 눈동자 자리는 그 줄의 흰자 색으로 메운다.
  eyes_iris.png   눈동자(진한 고리와 안쪽 빨강·분홍·크림). 이것만 움직인다.
  eyes_lid.png    눈동자 밖의 진한 선(눈꺼풀). 움직이는 눈동자 위에 덮는다.

눈동자는 진한 고리로 닫혀 있다. 빨간 부분에서 시작해 진한 선을 넘지 않게 칠하면 안쪽이 나오고,
그 모양에 맞춘 타원을 고리 두께만큼 키운 것이 눈동자다. 그림을 바꾸면 다시 돌린다.
    python3 scripts/split-eyes.py
"""
import math
from collections import deque
from pathlib import Path

from PIL import Image

ASSETS = Path(__file__).resolve().parent.parent / 'assets'
RING = 11  # 고리 두께(그림 픽셀)에 가장자리 여유를 더한 값


def dark(p):
    return p[3] > 40 and p[0] + p[1] + p[2] < 330


def sclera(p):  # 흰자: 밝고 거의 무채색(크림색 눈동자 아랫부분은 노란 기가 있어 빠진다)
    r, g, b, a = p
    return a > 200 and min(r, g, b) > 205 and max(r, g, b) - min(r, g, b) < 28


def fill_inside(px, w, h):
    seeds = [(x, y) for y in range(h) for x in range(w)
             if px[x, y][3] > 200 and px[x, y][0] > 150 and px[x, y][1] < 120 and px[x, y][2] < 120]
    seen = set(seeds)
    queue = deque(seeds)
    while queue:
        x, y = queue.popleft()
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h and (nx, ny) not in seen and px[nx, ny][3] > 40 and not dark(px[nx, ny]):
                seen.add((nx, ny))
                queue.append((nx, ny))
    return seen


def ellipse(points):
    """고르게 칠해진 타원 영역에서 중심, 두 반지름, 기울기를 구한다."""
    n = len(points)
    cx = sum(x for x, _ in points) / n
    cy = sum(y for _, y in points) / n
    sxx = sum((x - cx) ** 2 for x, _ in points) / n
    syy = sum((y - cy) ** 2 for _, y in points) / n
    sxy = sum((x - cx) * (y - cy) for x, y in points) / n
    angle = 0.5 * math.atan2(2 * sxy, sxx - syy)
    c, s = math.cos(angle), math.sin(angle)
    var_u = sxx * c * c + 2 * sxy * c * s + syy * s * s
    var_v = sxx * s * s - 2 * sxy * c * s + syy * c * c
    return cx, cy, 2 * math.sqrt(var_u), 2 * math.sqrt(var_v), angle


def reach(e, x, y, grow=0.0):
    """타원 안이면 1 이하. grow 만큼 키운 타원으로 잰다."""
    cx, cy, a, b, angle = e
    c, s = math.cos(angle), math.sin(angle)
    u = (x - cx) * c + (y - cy) * s
    v = -(x - cx) * s + (y - cy) * c
    return math.hypot(u / (a + grow), v / (b + grow))


def main():
    im = Image.open(ASSETS / 'eyes_open.png').convert('RGBA')
    w, h = im.size
    px = im.load()
    inside = fill_inside(px, w, h)
    if not inside or len(inside) > w * h * 0.5:
        raise SystemExit('눈동자를 찾지 못했어요. 그림이 바뀌었으면 색 기준을 고쳐 주세요.')
    eyes = [ellipse([p for p in inside if p[0] < w / 2]), ellipse([p for p in inside if p[0] >= w / 2])]

    def which(x, y):
        return min(eyes, key=lambda e: reach(e, x, y, RING))

    white = im.copy()
    iris = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    lid = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    wp, ip, lp = white.load(), iris.load(), lid.load()

    # 줄마다, 눈마다 눈동자 밖 흰자의 평균 색: 눈동자가 비킨 자리를 메울 색.
    row_color = {}
    for e in eyes:
        for y in range(h):
            got = [px[x, y] for x in range(w) if which(x, y) is e and reach(e, x, y, RING) > 1 and sclera(px[x, y])]
            if got:
                row_color[id(e), y] = tuple(sum(c[i] for c in got) // len(got) for i in range(3)) + (255,)
    for e in eyes:  # 흰자가 없는 줄은 가까운 줄 색을 쓴다
        for y in range(h):
            if (id(e), y) not in row_color:
                near = min((k for k in row_color if k[0] == id(e)), key=lambda k: abs(k[1] - y), default=None)
                row_color[id(e), y] = row_color[near] if near else (255, 255, 255, 255)

    for y in range(h):
        for x in range(w):
            p = px[x, y]
            if p[3] == 0:
                continue
            e = which(x, y)
            r_in = reach(e, x, y)
            r_out = reach(e, x, y, RING)
            if r_out <= 1:
                # 눈동자 자리: 흰자 판은 흰자 색으로 메우고, 눈동자 판은 흰자가 아닌 것만 가져간다.
                wp[x, y] = row_color[id(e), y][:3] + (p[3],)  # 가장자리 투명도는 원래대로
                if r_in <= 1.02 or not sclera(p):
                    ip[x, y] = p
            elif not sclera(p):
                lp[x, y] = p

    white.save(ASSETS / 'eyes_white.png', optimize=True)
    iris.save(ASSETS / 'eyes_iris.png', optimize=True)
    lid.save(ASSETS / 'eyes_lid.png', optimize=True)
    for i, (cx, cy, a, b, angle) in enumerate(eyes):
        print(f'눈 {i + 1}: 가운데 ({cx:.0f}, {cy:.0f}), 반지름 {a:.0f}×{b:.0f}, 기울기 {math.degrees(angle):.0f}도')


if __name__ == '__main__':
    main()
