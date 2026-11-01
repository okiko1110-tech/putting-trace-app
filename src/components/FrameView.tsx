import { useEffect, useRef } from 'react';
import type { VideoSource } from '../lib/video';

interface Props {
  src: VideoSource;
  /** 値が変わるたびに再描画 */
  version: number;
  /** オーバーレイ描画。lw は「画面上で約1px」に相当する線幅 */
  overlay?: (ctx: CanvasRenderingContext2D, lw: number) => void;
  onTap?: (x: number, y: number) => void;
  hint?: string;
}

/** 動画フレーム（作業解像度）を表示し、タップ位置を作業座標で返す */
export function FrameView({ src, version, overlay, onTap, hint }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    if (c.width !== src.workW) c.width = src.workW;
    if (c.height !== src.workH) c.height = src.workH;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(src.work, 0, 0);
    const cssW = c.getBoundingClientRect().width || c.width;
    const lw = c.width / cssW;
    overlay?.(ctx, lw);
  });

  const handle = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!onTap) return;
    const c = e.currentTarget;
    const rect = c.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * c.width;
    const y = ((e.clientY - rect.top) / rect.height) * c.height;
    onTap(x, y);
  };

  const portrait = src.workH > src.workW;
  return (
    <div className={`frame-wrap ${portrait ? 'portrait' : 'landscape'}`} data-version={version}>
      <canvas
        ref={ref}
        className={`frame ${onTap ? 'tappable' : ''}`}
        style={{ aspectRatio: `${src.workW} / ${src.workH}` }}
        onPointerUp={handle}
        data-testid="frame"
      />
      {hint && <div className="frame-hint">{hint}</div>}
    </div>
  );
}
