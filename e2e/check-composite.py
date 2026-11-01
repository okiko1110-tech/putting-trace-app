"""合成画像の検証: 正解のボール位置（各サンプル時刻）が白くなっているかを調べる"""
import json, struct, sys, zlib

def read_png(p):
    data = open(p, 'rb').read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', 'PNG ではありません'
    pos, idat, w = 8, b'', 0
    while pos < len(data):
        ln, typ = struct.unpack('>I4s', data[pos:pos + 8])
        chunk = data[pos + 8:pos + 8 + ln]
        if typ == b'IHDR':
            w, h, bd, ct = struct.unpack('>IIBB', chunk[:10])
            assert bd == 8 and ct in (2, 6)
            bpp = 3 if ct == 2 else 4
        elif typ == b'IDAT':
            idat += chunk
        pos += 12 + ln
    raw = zlib.decompress(idat)
    stride = w * bpp
    out = bytearray(h * stride)
    prev = bytearray(stride)
    i = 0
    for y in range(h):
        f = raw[i]; i += 1
        line = bytearray(raw[i:i + stride]); i += stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            b = prev[x]
            c = prev[x - bpp] if x >= bpp else 0
            if f == 1: line[x] = (line[x] + a) & 255
            elif f == 2: line[x] = (line[x] + b) & 255
            elif f == 3: line[x] = (line[x] + ((a + b) >> 1)) & 255
            elif f == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, bpp, out

png, js, sf, ef, interval = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), float(sys.argv[5])
w, h, bpp, px = read_png(png)
t = json.load(open(js))
assert (w, h) == (t['W'], t['H']), f'サイズ不一致 {w}x{h}'
step = max(1, round(interval * t['fps']))
frames = list(range(sf, ef + 1, step))
if frames[-1] != ef: frames.append(ef)
ok = 0
miss = []
for f in frames:
    g = t['truth'][f]
    x, y = int(g['x']), int(g['y'] - g['r'] * 0.4)  # 影のない上半分を見る
    i = (y * w + x) * bpp
    r, gg, b = px[i], px[i + 1], px[i + 2]
    if min(r, gg, b) > 180: ok += 1
    else: miss.append((f, (r, gg, b)))
# 背景（ボールの無い場所）が緑のままか
g0 = t['truth'][sf]
bx, by = int(g0['x'] + 150) % w, int(g0['y'] - 60)
i = (by * w + bx) * bpp
bg_ok = px[i + 1] > px[i] + 30
print(f'正解位置にボールあり: {ok}/{len(frames)}  背景は緑: {bg_ok}')
if miss: print('見つからない位置:', miss[:10])
print('RESULT OK' if ok >= len(frames) * 0.9 and bg_ok else 'RESULT NG')
