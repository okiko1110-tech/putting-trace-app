"""テスト用の合成パッティング動画を作る（緑の芝 + 転がって曲がる白いボール）
使い方: python3 e2e/make-video.py 出力.webm [portrait|landscape]
真の位置は 出力.json に保存します。"""
import json, subprocess, sys
import numpy as np

out = sys.argv[1]
mode = sys.argv[2] if len(sys.argv) > 2 else 'portrait'
W, H = (720, 1280) if mode == 'portrait' else (1280, 720)
FPS, DUR = 30, 5.0
T0, TROLL = 1.0, 2.8  # 転がり始め・転がる時間
rng = np.random.default_rng(1)

yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
# 芝のテクスチャ（ノイズ + 縞模様）
base = np.zeros((H, W, 3), np.float32)
noise = rng.normal(0, 10, (H, W)).astype(np.float32)
stripe = 12 * np.sin(xx / 60.0)
base[..., 0] = 45 + noise * 0.6 + stripe * 0.4
base[..., 1] = 120 + noise + stripe
base[..., 2] = 40 + noise * 0.4
# カップ
if mode == 'portrait':
    cup = (W * 0.62, H * 0.24)
    start = (W * 0.5, H * 0.86)
else:
    cup = (W * 0.70, H * 0.30)
    start = (W * 0.45, H * 0.85)
d = ((xx - cup[0]) / 30) ** 2 + ((yy - cup[1]) / 12) ** 2
base[d < 1] = (10, 15, 10)
# 静止している別のボール（追跡を邪魔する）
other = (W * 0.25, H * 0.5, 14)

def pos(t):
    """時刻 t のボール位置と半径"""
    tt = min(max(t - T0, 0), TROLL)
    u = (2 * tt / TROLL - (tt / TROLL) ** 2)  # 減速して止まる（0→1）
    y = start[1] + (cup[1] + 25 - start[1]) * (1.25 * u / (1 + 0.25 * u))
    x = start[0] - 40 * np.sin(np.pi * u) + (cup[0] - start[0] - 10) * u ** 2
    r = 20 * (1 - 0.5 * u)
    return float(x), float(y), float(r)

def draw_ball(img, x, y, r):
    m = ((xx - x) ** 2 + (yy - y) ** 2) <= r * r
    shade = 235 - 45 * np.clip((yy - y) / r, 0, 1)
    for c, off in enumerate((0, 0, -5)):
        img[..., c] = np.where(m, shade + off, img[..., c])

truth = []
p = subprocess.Popen(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}',
                      '-r', str(FPS), '-i', '-', '-c:v', 'libvpx-vp9', '-b:v', '4M', '-deadline', 'realtime',
                      '-cpu-used', '8', '-pix_fmt', 'yuv420p', out], stdin=subprocess.PIPE)
for k in range(int(FPS * DUR)):
    t = k / FPS
    img = base.copy()
    draw_ball(img, *other)
    x, y, r = pos(t)
    draw_ball(img, x, y, r)
    # パター（スタート前に近づき、打つ）
    if t < T0 + 0.3:
        px = start[0] - 60 + 45 * min(1, max(0, (t - 0.4) / 0.6))
        pm = (abs(xx - px) < 6) & (abs(yy - (start[1] + 0)) < 40)
        img[pm] = (30, 30, 35)
    truth.append({'frame': k, 't': t, 'x': x, 'y': y, 'r': r})
    p.stdin.write(np.clip(img, 0, 255).astype(np.uint8).tobytes())
p.stdin.close(); p.wait()
json.dump({'W': W, 'H': H, 'fps': FPS, 't0': T0, 'troll': TROLL, 'truth': truth}, open(out.rsplit('.', 1)[0] + '.json', 'w'))
print('ok', out)
