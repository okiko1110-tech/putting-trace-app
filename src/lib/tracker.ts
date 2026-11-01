/**
 * ボール追跡と、残像に使う時刻（サンプル）の決定
 * 座標はすべて「作業解像度」の座標です（元動画座標 = 作業座標 × src.scale）。
 */
import { detectTracked, type Img } from './detect';
import type { VideoSource } from './video';

export type SampleStatus = 'auto' | 'low' | 'lost' | 'manual' | 'excluded';

export interface Sample {
  frame: number; // フレーム番号
  time: number; // そのフレームの実際の時刻（秒）
  targetTime: number; // 本来狙った時刻（開始 + n × 間隔）
  kind: 'start' | 'mid' | 'end';
  x: number | null;
  y: number | null;
  r: number | null;
  score: number | null;
  status: SampleStatus;
}

export interface Seed {
  x: number;
  y: number;
  r: number;
  refW: number;
}

export interface SamplePlan {
  samples: Sample[];
  notes: string[]; // 間隔についての注意（実現できない場合など）
  actualMin: number;
  actualMax: number;
}

/** 開始〜終了の間で、指定間隔ごとのフレームを決める */
export function planSamples(
  fps: number,
  fpsKnown: boolean,
  phase: number,
  startFrame: number,
  endFrame: number,
  interval: number,
): SamplePlan {
  const fd = 1 / fps;
  const tStart = phase + startFrame * fd;
  const tEnd = phase + endFrame * fd;
  const frames: { frame: number; target: number }[] = [];
  for (let i = 0; ; i++) {
    const target = tStart + i * interval;
    if (target > tEnd + 1e-9) break;
    const f = Math.min(endFrame, startFrame + Math.round((target - tStart) / fd));
    if (frames.length && frames[frames.length - 1].frame === f) continue; // 同じコマは1回だけ
    frames.push({ frame: f, target });
  }
  const last = frames[frames.length - 1];
  if (last.frame !== endFrame) {
    // 最後の間隔が極端に短いときは、最後の通常サンプルを終了位置に置き換える
    if (frames.length > 1 && (endFrame - last.frame) * fd < interval * 0.3) frames.pop();
    frames.push({ frame: endFrame, target: tEnd });
  }
  const samples: Sample[] = frames.map((f, i) => ({
    frame: f.frame,
    time: phase + f.frame * fd,
    targetTime: f.target,
    kind: i === 0 ? 'start' : i === frames.length - 1 ? 'end' : 'mid',
    x: null,
    y: null,
    r: null,
    score: null,
    status: 'lost',
  }));

  // 実際の間隔（最後の終了サンプルを除く）
  const gaps: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].kind === 'end' && i > 1) continue;
    gaps.push(samples[i].time - samples[i - 1].time);
  }
  const actualMin = gaps.length ? Math.min(...gaps) : 0;
  const actualMax = gaps.length ? Math.max(...gaps) : 0;
  const notes: string[] = [];
  const fpsLabel = `${Math.round(fps)}fps`;
  if (!fpsKnown) {
    notes.push('このブラウザでは動画のフレームレートを測定できなかったため、30fpsと仮定して処理しています。');
  }
  if (interval < fd * 0.99) {
    notes.push(
      `この動画（約${fpsLabel}）は1コマが約${fd.toFixed(3)}秒のため、${interval}秒間隔は実現できません。1コマごと（約${fd.toFixed(3)}秒間隔）で処理しました。`,
    );
  } else if (Math.abs(interval / fd - Math.round(interval / fd)) > 0.05) {
    notes.push(
      `この動画（約${fpsLabel}）のコマの都合で、${interval}秒間隔に最も近いコマを使っています。実際の間隔は ${actualMin.toFixed(3)}〜${actualMax.toFixed(3)}秒 です（位置は実際の撮影時刻に基づきます）。`,
    );
  }
  return { samples, notes, actualMin, actualMax };
}

export interface TrackProgress {
  done: number;
  total: number;
}

const AUTO_SCORE = 0.6;
const LOW_SCORE = 0.42;

/**
 * samples[fromIdx] の位置（seed）から、終了まで追跡する。
 * 手動指定（manual）のサンプルは正しい位置として扱い、追跡をそこから再開します。
 * samples は直接書き換えます。
 */
export async function track(
  src: VideoSource,
  samples: Sample[],
  fromIdx: number,
  seed: Seed,
  onProgress?: (p: TrackProgress) => void,
  isCancelled?: () => boolean,
): Promise<void> {
  // 参照フレーム（開始時点）: 動かない白い物（他のボールなど）を見分けるのに使う
  const ref: Img = await src.grab(src.frameSeekTime(samples[0].frame), () => src.getImageData());

  const fromFrame = samples[fromIdx].frame;
  const endFrame = samples[samples.length - 1].frame;
  // 追跡は細かいステップ（約1/30秒ごと）で行い、サンプル時刻の結果だけを残す
  const stride = Math.max(1, Math.round(src.frameDuration > 0 ? 1 / 30 / src.frameDuration : 1));
  const frameSet = new Set<number>();
  for (let f = fromFrame; f <= endFrame; f += stride) frameSet.add(f);
  for (let i = fromIdx; i < samples.length; i++) frameSet.add(samples[i].frame);
  const frames = [...frameSet].sort((a, b) => a - b);
  const sampleAt = new Map<number, Sample>();
  for (let i = fromIdx; i < samples.length; i++) sampleAt.set(samples[i].frame, samples[i]);

  const seedR = seed.r;
  let lx = seed.x, ly = seed.y, lr = seed.r, lf = fromFrame;
  let vx = 0, vy = 0; // px / フレーム
  let refW = seed.refW;
  let haveVel = false;
  const maxSearch = 0.3 * Math.max(src.workW, src.workH);

  for (let k = 0; k < frames.length; k++) {
    if (isCancelled?.()) return;
    const f = frames[k];
    const s = sampleAt.get(f);
    onProgress?.({ done: k, total: frames.length });

    if (k === 0) {
      if (s) {
        s.x = seed.x; s.y = seed.y; s.r = seed.r;
        if (s.status !== 'manual') { s.status = 'manual'; s.score = 1; }
        const t = await src.seek(src.frameSeekTime(f));
        s.time = t;
      }
      continue;
    }

    // 手動指定済みのサンプルは、その位置を正として追跡を続ける
    if (s && s.status === 'manual' && s.x !== null && s.y !== null && s.r !== null) {
      const gap = f - lf;
      if (gap > 0) {
        const nvx = (s.x - lx) / gap, nvy = (s.y - ly) / gap;
        vx = haveVel ? 0.5 * vx + 0.5 * nvx : nvx;
        vy = haveVel ? 0.5 * vy + 0.5 * nvy : nvy;
        haveVel = true;
      }
      lx = s.x; ly = s.y; lr = s.r; lf = f;
      continue;
    }

    const [t, img] = await src.grab(src.frameSeekTime(f), (ft) => [ft, src.getImageData()] as const);
    const gap = f - lf;
    const decay = Math.pow(0.97, gap);
    const px = lx + vx * gap * decay;
    const py = ly + vy * gap * decay;
    const speed = Math.hypot(vx, vy);
    const searchR = Math.min(maxSearch, Math.max(3.5 * lr, 12) + speed * gap * 1.0 + (gap - 1) * lr);
    const b = detectTracked(img, { expectedR: lr, refW, ref, predX: px, predY: py, searchR });

    let status: SampleStatus = 'lost';
    if (b && b.score >= LOW_SCORE) status = b.score >= AUTO_SCORE ? 'auto' : 'low';

    if (b && status === 'auto') {
      const nvx = (b.x - lx) / gap, nvy = (b.y - ly) / gap;
      vx = haveVel ? 0.5 * vx + 0.5 * nvx : nvx;
      vy = haveVel ? 0.5 * vy + 0.5 * nvy : nvy;
      haveVel = true;
      lx = b.x; ly = b.y; lf = f;
      lr = Math.min(seedR * 1.6, Math.max(seedR * 0.3, 0.7 * lr + 0.3 * b.r));
      refW = 0.85 * refW + 0.15 * b.meanW;
    } else if (b && status === 'low') {
      // 要確認: 位置は記録するが、追跡状態は控えめに更新
      lx = 0.5 * px + 0.5 * b.x; ly = 0.5 * py + 0.5 * b.y; lf = f;
    }

    if (s) {
      s.time = t;
      if (s.status === 'excluded') continue;
      if (b && status !== 'lost') {
        s.x = b.x; s.y = b.y; s.r = Math.max(b.r, lr * 0.8); s.score = b.score;
      } else {
        s.x = null; s.y = null; s.r = null; s.score = b?.score ?? null;
      }
      s.status = status;
    }
  }
  onProgress?.({ done: frames.length, total: frames.length });
}

export function countStatus(samples: Sample[]) {
  const c = { auto: 0, low: 0, lost: 0, manual: 0, excluded: 0 };
  for (const s of samples) c[s.status]++;
  return c;
}

/** 残像画像に含めるサンプル */
export function isIncluded(s: Sample, includeLow: boolean): boolean {
  if (s.x === null || s.y === null || s.r === null) return false;
  if (s.status === 'auto' || s.status === 'manual') return true;
  return s.status === 'low' && includeLow;
}
