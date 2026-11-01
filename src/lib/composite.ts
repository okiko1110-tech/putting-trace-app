/**
 * 残像画像の合成
 * 各時刻の動画フレームから「実際のボールの画像」を円形に切り抜き、
 * 背景フレームに重ねていきます（線や図形のボールは描きません）。
 * 円の中でも背景と変わらない芝の部分は透明にするため、ボール同士が重なっても
 * 周りの芝が隣のボールを覆い隠しません（カメラ固定が前提）。
 */
import type { VideoSource } from './video';
import { isIncluded, type Sample } from './tracker';
import { AppError } from './video';

export interface CompositeOptions {
  base: 'start' | 'end';
  includeLow: boolean;
  /** 切り抜きサイズの倍率（1 = 標準） */
  maskScale: number;
}

/** iPhone Safari の Canvas 上限（約1670万画素）に余裕を持たせた値 */
const MAX_PIXELS = 16_000_000;
const MAX_LONG_SIDE = 4096;

export async function buildComposite(
  src: VideoSource,
  samples: Sample[],
  opt: CompositeOptions,
  onProgress?: (done: number, total: number) => void,
  isCancelled?: () => boolean,
): Promise<{ canvas: HTMLCanvasElement; count: number } | null> {
  const W0 = src.width, H0 = src.height;
  const s = Math.min(1, Math.sqrt(MAX_PIXELS / (W0 * H0)), MAX_LONG_SIDE / Math.max(W0, H0));
  const W = Math.round(W0 * s), H = Math.round(H0 * s);
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const ctx = out.getContext('2d');
  if (!ctx) throw new AppError('画像を作成できませんでした（Canvas を使えません）。');

  const baseSample = opt.base === 'start' ? samples[0] : samples[samples.length - 1];
  await src.grab(src.frameSeekTime(baseSample.frame), () => ctx.drawImage(src.video, 0, 0, W, H));

  // 元動画座標への変換係数（作業座標 → 出力座標）
  const k = src.scale * s;
  const list = samples.filter((x) => isIncluded(x, opt.includeLow) && x !== baseSample);
  // 奥（後の時刻）から描き、手前（前の時刻）のボールが上に来るようにする
  list.sort((a, b) => b.frame - a.frame);

  // 背景フレームの複製（ボール部分だけを切り出すための「差分」の基準）
  const baseCv = document.createElement('canvas');
  baseCv.width = W;
  baseCv.height = H;
  const bctx = baseCv.getContext('2d', { willReadFrequently: true });
  const tmp = document.createElement('canvas');
  const tctx = tmp.getContext('2d', { willReadFrequently: true });
  if (!tctx || !bctx) throw new AppError('画像を作成できませんでした（Canvas を使えません）。');
  bctx.drawImage(out, 0, 0);

  let done = 0;
  for (const smp of list) {
    if (isCancelled?.()) return null;
    onProgress?.(done++, list.length);
    const cx = smp.x! * k, cy = smp.y! * k, r = smp.r! * k;
    const rIn = r * 1.2 * opt.maskScale;
    const rOut = r * 1.6 * opt.maskScale;
    // 出力画像上の切り抜き範囲（整数ピクセルに揃え、画像からはみ出さないよう切り詰める）
    const ox = Math.max(0, Math.floor(cx - rOut)), oy = Math.max(0, Math.floor(cy - rOut));
    const ox1 = Math.min(W, Math.ceil(cx + rOut)), oy1 = Math.min(H, Math.ceil(cy + rOut));
    const w = ox1 - ox, h = oy1 - oy;
    if (w < 2 || h < 2) continue;
    tmp.width = w;
    tmp.height = h;
    // 元動画から、その時刻の実際のボール部分を切り出す
    await src.grab(src.frameSeekTime(smp.frame), () =>
      tctx.drawImage(src.video, ox / s, oy / s, w / s, h / s, 0, 0, w, h),
    );
    const crop = tctx.getImageData(0, 0, w, h);
    const bg = bctx.getImageData(ox, oy, w, h).data;
    const d = crop.data;
    // 透明度 = 円形マスク × 背景との違い（ボール以外の芝はほぼ透明になる）
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const dist = Math.hypot(ox + x + 0.5 - cx, oy + y + 0.5 - cy);
        let a = dist <= rIn ? 1 : dist >= rOut ? 0 : (rOut - dist) / (rOut - rIn);
        if (a > 0) {
          const diff = Math.max(Math.abs(d[i] - bg[i]), Math.abs(d[i + 1] - bg[i + 1]), Math.abs(d[i + 2] - bg[i + 2]));
          // 背景と同じ（差が小さい）部分は透明に。背景の同じ場所にボールが写っていれば、それがそのまま見えます
          a *= Math.min(1, Math.max(0, (diff - 14) / 30));
        }
        d[i + 3] = Math.round(a * 255);
      }
    }
    tctx.putImageData(crop, 0, 0);
    ctx.drawImage(tmp, ox, oy);
  }
  onProgress?.(list.length, list.length);
  // 背景に元から写っているボールも1個と数える
  return { canvas: out, count: list.length + 1 };
}

export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) resolve(b);
      else reject(new AppError('PNG 画像を作成できませんでした。動画の解像度を下げて（1080p で撮影）お試しください。'));
    }, 'image/png');
  });
}
