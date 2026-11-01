import { useEffect, useRef, useState } from 'react';
import { buildComposite, canvasToPngBlob } from '../lib/composite';
import { countStatus, isIncluded, type Sample, type SamplePlan } from '../lib/tracker';
import type { VideoSource } from '../lib/video';

interface Props {
  src: VideoSource;
  samples: Sample[];
  plan: SamplePlan;
  interval: number;
  onBack: () => void;
  onRestart: () => void;
}

function fileName() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `putting-trace-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
}

export function ResultScreen({ src, samples, plan, interval, onBack, onRestart }: Props) {
  const [base, setBase] = useState<'start' | 'end'>('start');
  const [includeLow, setIncludeLow] = useState(false);
  const [maskScale, setMaskScale] = useState(1);
  const [busy, setBusy] = useState<string | null>('画像を作成しています…');
  const [error, setError] = useState<string | null>(null);
  const [png, setPng] = useState<{ blob: Blob; url: string; name: string; count: number; w: number; h: number } | null>(null);
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const runId = useRef(0);

  useEffect(() => {
    const id = ++runId.current;
    let url: string | null = null;
    setBusy('画像を作成しています…');
    setError(null);
    (async () => {
      try {
        const res = await buildComposite(
          src,
          samples,
          { base, includeLow, maskScale },
          (d, t) => {
            if (id === runId.current) setBusy(`画像を作成しています… ${d}/${t}`);
          },
          () => id !== runId.current,
        );
        if (!res || id !== runId.current) return;
        const { canvas, count } = res;
        const blob = await canvasToPngBlob(canvas);
        if (id !== runId.current) return;
        url = URL.createObjectURL(blob);
        const w = canvas.width, h = canvas.height;
        setPng((old) => {
          if (old) URL.revokeObjectURL(old.url);
          return { blob, url: url!, name: fileName(), count, w, h };
        });
        canvas.width = 0; // メモリ解放
        canvas.height = 0;
      } catch (e) {
        if (id === runId.current) setError((e as Error).message);
      } finally {
        if (id === runId.current) setBusy(null);
      }
    })();
  }, [src, samples, base, includeLow, maskScale]);

  const urlRef = useRef<string | null>(null);
  useEffect(() => {
    urlRef.current = png?.url ?? null;
  }, [png]);
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  const c = countStatus(samples);
  const used = samples.filter((s) => isIncluded(s, includeLow)).length;

  const share = async () => {
    if (!png) return;
    setShareMsg(null);
    const file = new File([png.blob], png.name, { type: 'image/png' });
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (nav.share && nav.canShare?.({ files: [file] })) {
      try {
        await nav.share({ files: [file], title: 'PUTTING TRACE' });
        return;
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
      }
    }
    download();
    setShareMsg('共有機能が使えないため、ダウンロードしました。保存できない場合は、画像を長押しして「"写真"に追加」を選んでください。');
  };

  const download = () => {
    if (!png) return;
    const a = document.createElement('a');
    a.href = png.url;
    a.download = png.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <main className="screen result-screen">
      <div className="topbar">
        <button className="link-btn" onClick={onBack}>‹ 位置の確認に戻る</button>
      </div>
      <h2 className="result-title">残像画像</h2>

      <div className="result-wrap">
        {png && <img src={png.url} alt="ボールの残像画像" className="result-img" data-testid="result-img" data-count={png.count} />}
        {busy && (
          <div className="result-busy">
            <div className="spinner" /> {busy}
          </div>
        )}
      </div>
      {error && <div className="error" role="alert">{error}</div>}

      <div className="btn-stack">
        <button className="btn primary big" disabled={!png || !!busy} onClick={share} data-testid="share">写真に保存・共有</button>
        <button className="btn secondary" disabled={!png || !!busy} onClick={download}>PNGファイルとしてダウンロード</button>
      </div>
      {shareMsg && <div className="notice">{shareMsg}</div>}
      <p className="muted small">「写真に保存・共有」→「画像を保存」で写真アプリに保存できます。画像を長押しして保存することもできます。</p>

      <section className="card info">
        <div className="info-row"><span>ボールの数</span><strong data-testid="ball-count">{png ? `${png.count}個` : '-'}</strong></div>
        <div className="info-row"><span>指定した間隔</span><strong>{interval}秒</strong></div>
        <div className="info-row">
          <span>実際の間隔</span>
          <strong>{plan.actualMin.toFixed(3) === plan.actualMax.toFixed(3) ? `${plan.actualMin.toFixed(3)}秒` : `${plan.actualMin.toFixed(3)}〜${plan.actualMax.toFixed(3)}秒`}</strong>
        </div>
        <div className="info-row"><span>使用した位置</span><strong>{used} / {samples.length}</strong></div>
        {png && <div className="info-row"><span>画像サイズ</span><strong>{png.w} × {png.h}</strong></div>}
        {plan.notes.map((n) => <div key={n} className="notice warn">{n}</div>)}
        {c.lost > 0 && <div className="notice warn">未検出の {c.lost} か所は画像に含めていません（勝手に位置を補っていません）。</div>}
        {c.low > 0 && !includeLow && <div className="notice warn">要確認の {c.low} か所は含めていません。下の設定で含めることもできます。</div>}
      </section>

      <section className="card settings">
        <h3>画像の設定</h3>
        <div className="setting">
          <span>背景に使う場面</span>
          <div className="segmented">
            <button className={base === 'start' ? 'on' : ''} onClick={() => setBase('start')}>開始時</button>
            <button className={base === 'end' ? 'on' : ''} onClick={() => setBase('end')}>終了時</button>
          </div>
        </div>
        <div className="setting">
          <span>ボールの切り抜きの大きさ</span>
          <div className="segmented">
            {[0.8, 1, 1.3].map((v) => (
              <button key={v} className={maskScale === v ? 'on' : ''} onClick={() => setMaskScale(v)}>
                {v === 0.8 ? '小' : v === 1 ? '標準' : '大'}
              </button>
            ))}
          </div>
        </div>
        {c.low > 0 && (
          <label className="check">
            <input type="checkbox" checked={includeLow} onChange={(e) => setIncludeLow(e.target.checked)} />
            要確認（黄色）の位置も含める
          </label>
        )}
      </section>

      <button className="btn secondary" onClick={onRestart}>別の動画で作る</button>
    </main>
  );
}
