import { describe, expect, it } from 'vitest';
import { detectAtTap, detectTracked, type Img } from './detect';
import { planSamples } from './tracker';

/** 緑の背景に白い円を描いたテスト画像 */
function makeImg(w: number, h: number, balls: { x: number; y: number; r: number; shade?: number }[], seed = 1): Img {
  const data = new Uint8ClampedArray(w * h * 4);
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const n = rnd() * 30;
      data[i] = 40 + n;
      data[i + 1] = 110 + n * 1.5;
      data[i + 2] = 35 + n * 0.5;
      data[i + 3] = 255;
      for (const b of balls) {
        const d = Math.hypot(x + 0.5 - b.x, y + 0.5 - b.y);
        if (d <= b.r) {
          // 下半分を少し暗くして影を再現
          const v = (b.shade ?? 235) - (y > b.y ? 40 : 0);
          data[i] = v; data[i + 1] = v; data[i + 2] = v - 5;
        }
      }
    }
  }
  return { data, width: w, height: h };
}

describe('detectAtTap', () => {
  it('タップ付近のボールの中心と半径を求める', () => {
    const img = makeImg(200, 200, [{ x: 100, y: 120, r: 8 }]);
    const b = detectAtTap(img, 104, 117, 30)!;
    expect(b).not.toBeNull();
    expect(Math.abs(b.x - 100)).toBeLessThan(1.5);
    expect(Math.abs(b.y - 120)).toBeLessThan(2.5);
    expect(b.r).toBeGreaterThan(6);
    expect(b.r).toBeLessThan(10);
  });

  it('ボールが無い場所では null を返す', () => {
    const img = makeImg(200, 200, [{ x: 30, y: 30, r: 8 }]);
    expect(detectAtTap(img, 150, 150, 30)).toBeNull();
  });
});

describe('detectTracked', () => {
  it('予測位置の近くのボールを見つけ、静止した別の白い物より優先する', () => {
    const ref = makeImg(300, 300, [{ x: 200, y: 100, r: 8 }], 2); // 静止ボールのみ
    const img = makeImg(300, 300, [{ x: 200, y: 100, r: 8 }, { x: 150, y: 120, r: 7 }], 3);
    const b = detectTracked(img, { expectedR: 7, refW: 220, ref, predX: 160, predY: 115, searchR: 60 })!;
    expect(b).not.toBeNull();
    expect(Math.abs(b.x - 150)).toBeLessThan(2);
    expect(b.score).toBeGreaterThan(0.6);
  });

  it('探索範囲にボールが無ければ見つからない', () => {
    const img = makeImg(300, 300, [{ x: 20, y: 20, r: 7 }]);
    const b = detectTracked(img, { expectedR: 7, refW: 220, ref: null, predX: 200, predY: 200, searchR: 40 });
    expect(b).toBeNull();
  });
});

describe('planSamples', () => {
  it('30fps・0.1秒間隔なら3コマごと＋終了位置', () => {
    const p = planSamples(30, true, 0, 30, 90, 0.1);
    expect(p.samples[0].kind).toBe('start');
    expect(p.samples[p.samples.length - 1].frame).toBe(90);
    expect(p.samples[1].frame - p.samples[0].frame).toBe(3);
    expect(p.notes).toHaveLength(0);
    expect(p.actualMin).toBeCloseTo(0.1, 5);
  });

  it('30fps で 0.05秒間隔はコマ単位に丸め、その旨を知らせる', () => {
    const p = planSamples(30, true, 0, 0, 30, 0.05);
    expect(p.notes.length).toBeGreaterThan(0);
    const frames = p.samples.map((s) => s.frame);
    expect(new Set(frames).size).toBe(frames.length); // 重複なし
    expect(p.actualMin).toBeCloseTo(1 / 30, 3);
    expect(p.actualMax).toBeCloseTo(2 / 30, 3);
  });

  it('60fps で 0.05秒間隔は3コマごと', () => {
    const p = planSamples(60, true, 0, 0, 120, 0.05);
    expect(p.notes).toHaveLength(0);
    expect(p.samples[1].frame).toBe(3);
  });

  it('フレームレートより細かい間隔は実現できない旨を表示', () => {
    const p = planSamples(15, true, 0, 0, 30, 0.05);
    expect(p.notes.join()).toContain('実現できません');
  });
});
