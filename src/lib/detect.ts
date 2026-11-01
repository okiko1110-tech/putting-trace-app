/**
 * ボール検出（純粋な画像処理。ブラウザ API に依存しないのでテスト可能）
 *
 * 考え方:
 *  - 白いボールは「明るく」「色味が少ない（R,G,B がほぼ同じ）」
 *  - 緑のグリーンは「G だけ高い」→ 色味が強い
 *  そこで「白さ = 平均輝度 − (最大チャンネル − 最小チャンネル)」を使い、
 *  白さが周囲より十分高いピクセルのかたまり（ブロブ）をボール候補とします。
 */

export interface Img {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface Blob {
  x: number; // 重心 x（画像座標）
  y: number;
  r: number; // 推定半径
  area: number;
  meanW: number; // ブロブ内の平均白さ
  fill: number; // バウンディングボックス充填率（円なら約0.785）
  diff: number; // 参照フレームとの差（0〜255）
  score: number; // 0〜1 の確からしさ
}

export function whitenessAt(d: Uint8ClampedArray, i: number): number {
  const r = d[i], g = d[i + 1], b = d[i + 2];
  const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
  const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
  const w = (r + g + b) / 3 - (mx - mn);
  return w < 0 ? 0 : w;
}

function lumAt(d: Uint8ClampedArray, i: number): number {
  return (d[i] * 3 + d[i + 1] * 6 + d[i + 2]) / 10;
}

interface Window {
  x0: number;
  y0: number;
  w: number;
  h: number;
  vals: Float32Array;
}

function computeWindow(img: Img, cx: number, cy: number, R: number): Window | null {
  const x0 = Math.max(0, Math.floor(cx - R));
  const y0 = Math.max(0, Math.floor(cy - R));
  const x1 = Math.min(img.width - 1, Math.ceil(cx + R));
  const y1 = Math.min(img.height - 1, Math.ceil(cy + R));
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  if (w < 3 || h < 3) return null;
  const vals = new Float32Array(w * h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    let idx = ((y0 + y) * img.width + x0) * 4;
    for (let x = 0; x < w; x++, idx += 4) vals[y * w + x] = whitenessAt(d, idx);
  }
  return { x0, y0, w, h, vals };
}

function percentile(vals: Float32Array, p: number): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < vals.length; i++) hist[Math.min(255, vals[i] | 0)]++;
  const target = vals.length * p;
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= target) return i;
  }
  return 255;
}

interface Component {
  area: number;
  sx: number;
  sy: number;
  sw: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  sdiff: number;
}

function components(win: Window, thr: number, img: Img, ref: Img | null): Component[] {
  const { w, h, vals, x0, y0 } = win;
  const label = new Int32Array(w * h).fill(-1);
  const out: Component[] = [];
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (label[start] !== -1 || vals[start] < thr) continue;
    const c: Component = { area: 0, sx: 0, sy: 0, sw: 0, minX: 1e9, maxX: -1, minY: 1e9, maxY: -1, sdiff: 0 };
    const id = out.length;
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop()!;
      const px = p % w;
      const py = (p - px) / w;
      const v = vals[p];
      c.area++;
      c.sx += px * v;
      c.sy += py * v;
      c.sw += v;
      if (px < c.minX) c.minX = px;
      if (px > c.maxX) c.maxX = px;
      if (py < c.minY) c.minY = py;
      if (py > c.maxY) c.maxY = py;
      if (ref) {
        const gi = ((y0 + py) * img.width + (x0 + px)) * 4;
        c.sdiff += Math.abs(lumAt(img.data, gi) - lumAt(ref.data, gi));
      }
      if (px > 0) { const q = p - 1; if (label[q] === -1 && vals[q] >= thr) { label[q] = id; stack.push(q); } }
      if (px < w - 1) { const q = p + 1; if (label[q] === -1 && vals[q] >= thr) { label[q] = id; stack.push(q); } }
      if (py > 0) { const q = p - w; if (label[q] === -1 && vals[q] >= thr) { label[q] = id; stack.push(q); } }
      if (py < h - 1) { const q = p + w; if (label[q] === -1 && vals[q] >= thr) { label[q] = id; stack.push(q); } }
    }
    out.push(c);
  }
  return out;
}

function toBlob(c: Component, win: Window): Omit<Blob, 'score'> {
  const bw = c.maxX - c.minX + 1;
  const bh = c.maxY - c.minY + 1;
  const r = Math.max(Math.sqrt(c.area / Math.PI), Math.min(bw, bh) / 2);
  return {
    x: win.x0 + c.sx / c.sw + 0.5,
    y: win.y0 + c.sy / c.sw + 0.5,
    r,
    area: c.area,
    meanW: c.sw / c.area,
    fill: c.area / (bw * bh),
    diff: c.sdiff / c.area,
  };
}

/**
 * ユーザーがタップした位置の近くでボールを探す（最初の1回用）。
 * searchR: 探索半径（画像ピクセル）
 */
export function detectAtTap(img: Img, tx: number, ty: number, searchR: number): Blob | null {
  const win = computeWindow(img, tx, ty, searchR);
  if (!win) return null;
  const bg = percentile(win.vals, 0.5);
  // タップ位置周辺（探索半径の 1/3）の最大白さ
  let peak = 0;
  const pr = Math.max(4, searchR / 3);
  for (let y = 0; y < win.h; y++) {
    for (let x = 0; x < win.w; x++) {
      const dx = win.x0 + x - tx, dy = win.y0 + y - ty;
      if (dx * dx + dy * dy <= pr * pr) peak = Math.max(peak, win.vals[y * win.w + x]);
    }
  }
  if (peak - bg < 25) return null; // 周囲と差がない＝ボールが見つからない
  const thr = bg + 0.5 * (peak - bg);
  const comps = components(win, thr, img, null);
  let best: Blob | null = null;
  let bestD = Infinity;
  for (const c of comps) {
    if (c.area < 3) continue;
    const b = toBlob(c, win);
    // タップ位置からブロブの縁までの距離
    const d = Math.max(0, Math.hypot(b.x - tx, b.y - ty) - b.r);
    if (d < bestD) {
      bestD = d;
      best = { ...b, score: 1 };
    }
  }
  if (!best || bestD > searchR * 0.6) return null;
  return best;
}

export interface TrackOptions {
  expectedR: number;
  refW: number; // ボールの白さの目安
  ref?: Img | null; // 参照フレーム（静止した白い物を除外するため）
  predX: number;
  predY: number;
  searchR: number;
}

/** 予測位置の周りでボールを探す（2フレーム目以降） */
export function detectTracked(img: Img, o: TrackOptions): Blob | null {
  const win = computeWindow(img, o.predX, o.predY, o.searchR);
  if (!win) return null;
  const bg = percentile(win.vals, 0.5);
  const target = Math.max(o.refW, bg + 30);
  const thr = Math.max(bg + 20, bg + 0.45 * (target - bg));
  const comps = components(win, thr, img, o.ref ?? null);
  const expArea = Math.PI * o.expectedR * o.expectedR;
  let best: Blob | null = null;
  for (const c of comps) {
    if (c.area < Math.max(3, expArea * 0.12) || c.area > expArea * 6) continue;
    const b = toBlob(c, win);
    const sizeScore = Math.exp(-Math.abs(Math.log(b.area / expArea)) * 0.8);
    const dist = Math.hypot(b.x - o.predX, b.y - o.predY);
    const distScore = Math.exp(-((dist / (o.searchR * 0.6)) ** 2));
    const whiteScore = Math.min(1, Math.max(0, (b.meanW - bg) / Math.max(20, o.refW - bg)));
    const fillScore = Math.min(1, b.fill / 0.6);
    const diffScore = o.ref ? Math.min(1, b.diff / 35) : 0.7;
    const score =
      sizeScore * 0.25 + distScore * 0.3 + whiteScore * 0.15 + fillScore * 0.1 + diffScore * 0.2;
    if (!best || score > best.score) best = { ...b, score };
  }
  return best;
}
