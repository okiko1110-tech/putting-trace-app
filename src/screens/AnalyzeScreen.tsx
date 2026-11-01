import { useCallback, useEffect, useRef, useState } from 'react';
import { FrameView } from '../components/FrameView';
import { detectAtTap, whitenessAt } from '../lib/detect';
import { countStatus, planSamples, track, type Sample, type SamplePlan, type Seed } from '../lib/tracker';
import type { VideoSource } from '../lib/video';

export type Interval = 0.05 | 0.1 | 0.2;

interface Props {
  src: VideoSource;
  active: boolean;
  onBack: () => void;
  onCompose: (samples: Sample[], plan: SamplePlan, interval: Interval) => void;
}

type Step = 1 | 2 | 3 | 4 | 5;
const STEP_LABELS: Record<Step, string> = {
  1: '開始',
  2: '終了',
  3: 'ボール',
  4: '追跡',
  5: '確認',
};

const STATUS_LABEL: Record<Sample['status'], string> = {
  auto: '自動認識',
  low: '要確認',
  lost: '未検出',
  manual: '手動指定',
  excluded: '除外',
};
const STATUS_COLOR: Record<Sample['status'], string> = {
  auto: '#2fbf71',
  low: '#f2c94c',
  lost: '#eb5757',
  manual: '#56ccf2',
  excluded: '#888888',
};

function fmt(t: number) {
  return `${t.toFixed(2)}秒`;
}

export function AnalyzeScreen({ src, active, onBack, onCompose }: Props) {
  const [step, setStep] = useState<Step>(1);
  const [version, setVersion] = useState(0);
  const [frame, setFrame] = useState(0);
  const [shownTime, setShownTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [startFrame, setStartFrame] = useState<number | null>(null);
  const [endFrame, setEndFrame] = useState<number | null>(null);
  const [seed, setSeed] = useState<Seed | null>(null);
  const [seedMsg, setSeedMsg] = useState<string | null>(null);
  const [interval, setIntervalSec] = useState<Interval>(0.1);
  const [plan, setPlan] = useState<SamplePlan | null>(null);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef(false);
  const busyRef = useRef(false);

  const maxFrame = src.frameCount - 1;
  const fd = src.frameDuration;

  // ---- フレーム表示（最新のリクエストだけを処理） ----
  const wantRef = useRef<number | null>(null);
  const seekingRef = useRef(false);
  const showFrame = useCallback(
    async (f: number) => {
      const target = Math.max(0, Math.min(maxFrame, Math.round(f)));
      setFrame(target);
      wantRef.current = target;
      if (seekingRef.current) return;
      seekingRef.current = true;
      try {
        while (wantRef.current !== null) {
          const w = wantRef.current;
          wantRef.current = null;
          const t = await src.seek(src.frameSeekTime(w));
          setShownTime(t);
          setVersion((v) => v + 1);
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        seekingRef.current = false;
      }
    },
    [src, maxFrame],
  );

  useEffect(() => {
    showFrame(0);
  }, [showFrame]);

  // ---- 再生 ----
  const stopPlay = useCallback(() => {
    src.video.pause();
    setPlaying(false);
  }, [src]);

  const togglePlay = async () => {
    if (playing) {
      stopPlay();
      const f = src.frameIndexAt(src.video.currentTime);
      showFrame(f);
      return;
    }
    try {
      await src.video.play();
      setPlaying(true);
    } catch {
      setError('再生できませんでした。スライダーで位置を動かして確認してください。');
    }
  };

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const loop = () => {
      src.drawCurrent();
      setFrame(src.frameIndexAt(src.video.currentTime));
      setShownTime(src.video.currentTime);
      setVersion((v) => v + 1);
      if (src.video.paused || src.video.ended) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, src]);

  useEffect(() => {
    if (!active && playing) stopPlay();
  }, [active, playing, stopPlay]);

  const goStep = (s: Step) => {
    if (playing) stopPlay();
    setMsg(null);
    setError(null);
    setStep(s);
    if (s === 3 && startFrame !== null) showFrame(startFrame);
    if (s === 5 && sel !== null && samples[sel]) showFrame(samples[sel].frame);
  };

  const canGo = (s: Step) => {
    if (s === 1) return true;
    if (s === 2) return startFrame !== null;
    if (s === 3) return startFrame !== null && endFrame !== null;
    if (s === 4) return seed !== null;
    return samples.length > 0;
  };

  // ---- 手順1・2：開始・終了 ----
  const setStart = () => {
    if (playing) stopPlay();
    const f = playing ? src.frameIndexAt(src.video.currentTime) : frame;
    if (endFrame !== null && f >= endFrame) setEndFrame(null);
    setStartFrame(f);
    setSeed(null);
    setSamples([]);
    setStep(2);
    showFrame(Math.min(maxFrame, f + Math.round(1 / fd)));
  };
  const setEnd = () => {
    if (playing) stopPlay();
    const f = playing ? src.frameIndexAt(src.video.currentTime) : frame;
    if (startFrame === null) return;
    if (f <= startFrame) {
      setError('終了時刻は開始時刻より後にしてください。');
      return;
    }
    setError(null);
    setEndFrame(f);
    setSamples([]);
    setStep(3);
    showFrame(startFrame);
  };

  // ---- 手順3：ボールをタップ ----
  const minDim = Math.min(src.workW, src.workH);
  const tapSeed = (x: number, y: number) => {
    if (startFrame === null) return;
    if (frame !== startFrame) {
      showFrame(startFrame);
      setSeedMsg('開始時刻の画面に戻しました。もう一度ボールをタップしてください。');
      return;
    }
    const img = src.getImageData();
    const b = detectAtTap(img, x, y, Math.max(24, minDim * 0.05));
    if (b) {
      setSeed({ x: b.x, y: b.y, r: Math.max(2, b.r), refW: b.meanW });
      setSeedMsg('ボールを認識しました。円がボールに合っていれば「この位置で決定」を押してください。');
    } else {
      const i = (Math.round(y) * img.width + Math.round(x)) * 4;
      setSeed({ x, y, r: Math.max(3, minDim * 0.012), refW: Math.max(120, whitenessAt(img.data, i)) });
      setSeedMsg('ボールを自動で認識できませんでした。タップした位置を使います。円の大きさ・位置を調整してください。');
    }
    setSamples([]);
  };

  const nudgeSeed = (dx: number, dy: number, dr: number) => {
    if (!seed) return;
    const step = Math.max(1, seed.r * 0.2);
    setSeed({ ...seed, x: seed.x + dx * step, y: seed.y + dy * step, r: Math.max(2, seed.r * (1 + dr * 0.1)) });
    setSamples([]);
  };

  // ---- 手順4：追跡 ----
  const runTrack = async (fromIdx = 0, baseSamples?: Sample[]) => {
    if (startFrame === null || endFrame === null || !seed || busyRef.current) return;
    busyRef.current = true;
    cancelRef.current = false;
    setError(null);
    setMsg(null);
    let list: Sample[];
    let p = plan;
    if (!baseSamples) {
      p = planSamples(1 / fd, src.fps !== null, src.framePhase, startFrame, endFrame, interval);
      setPlan(p);
      list = p.samples;
    } else {
      list = baseSamples.map((s) => ({ ...s }));
    }
    const from = list[fromIdx];
    const sd: Seed =
      fromIdx === 0
        ? seed
        : { x: from.x!, y: from.y!, r: from.r!, refW: seed.refW };
    setProgress(0);
    try {
      await track(src, list, fromIdx, sd, ({ done, total }) => setProgress(total ? done / total : 0), () => cancelRef.current);
      if (cancelRef.current) {
        setMsg('追跡を中止しました。');
      } else {
        setSamples(list);
        (window as unknown as { __ptSamples: Sample[] }).__ptSamples = list; // テスト・調査用
        const c = countStatus(list);
        setMsg(
          c.lost + c.low > 0
            ? `追跡が終わりました。赤（未検出）や黄（要確認）の位置は、タップして確認・修正してください。`
            : '追跡が終わりました。すべての位置を認識できました。念のため確認してください。',
        );
        setStep(5);
        const firstBad = list.findIndex((s) => s.status === 'lost' || s.status === 'low');
        const pick = firstBad >= 0 ? firstBad : fromIdx;
        setSel(pick);
        await showFrame(list[pick].frame);
      }
    } catch (e) {
      setError(`追跡中にエラーが発生しました：${(e as Error).message}`);
    } finally {
      busyRef.current = false;
      setProgress(null);
    }
  };

  // ---- 手順5：確認・修正 ----
  const selectSample = (i: number) => {
    setSel(i);
    setMsg(null);
    showFrame(samples[i].frame);
  };

  const updateSample = (i: number, patch: Partial<Sample>) => {
    setSamples((list) => list.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  };

  const neighborR = (i: number) => {
    for (let d = 1; d < samples.length; d++) {
      for (const j of [i - d, i + d]) {
        const s = samples[j];
        if (s && s.r !== null && (s.status === 'auto' || s.status === 'manual')) return s.r;
      }
    }
    return seed?.r ?? minDim * 0.012;
  };

  const tapFix = (x: number, y: number) => {
    if (sel === null) return;
    const s = samples[sel];
    if (frame !== s.frame) {
      showFrame(s.frame);
      setMsg('選択中の時刻の画面に戻しました。もう一度タップしてください。');
      return;
    }
    const r0 = s.r ?? neighborR(sel);
    const b = detectAtTap(src.getImageData(), x, y, Math.max(12, r0 * 2.5));
    if (b && Math.hypot(b.x - x, b.y - y) < Math.max(r0 * 1.8, 8) && b.r < r0 * 2.5) {
      updateSample(sel, { x: b.x, y: b.y, r: Math.max(2, b.r), status: 'manual', score: 1 });
      setMsg('タップした近くのボールに合わせました（手動指定）。ずれていれば矢印で微調整してください。');
    } else {
      updateSample(sel, { x, y, r: r0, status: 'manual', score: 1 });
      setMsg('タップした位置を手動指定にしました。矢印で微調整できます。');
    }
  };

  const nudgeSel = (dx: number, dy: number, dr: number) => {
    if (sel === null) return;
    const s = samples[sel];
    if (s.x === null || s.y === null || s.r === null) return;
    const st = Math.max(1, s.r * 0.2);
    updateSample(sel, {
      x: s.x + dx * st,
      y: s.y + dy * st,
      r: Math.max(2, s.r * (1 + dr * 0.1)),
      status: 'manual',
      score: 1,
    });
  };

  const counts = countStatus(samples);
  const selSample = sel !== null ? samples[sel] : null;

  // ---- オーバーレイ ----
  const overlay = (ctx: CanvasRenderingContext2D, lw: number) => {
    if ((step === 3 || step === 4) && seed && frame === startFrame) {
      ring(ctx, seed.x, seed.y, seed.r * 1.6, '#2fbf71', lw * 2.5);
      cross(ctx, seed.x, seed.y, seed.r * 0.6, '#2fbf71', lw * 1.5);
    }
    if (step === 5 && samples.length) {
      // 軌跡の確認用（画面表示のみ。完成画像には描きません）
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = lw;
      ctx.setLineDash([lw * 4, lw * 4]);
      ctx.beginPath();
      let first = true;
      for (const s of samples) {
        if (s.x === null || s.y === null) continue;
        if (first) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
        first = false;
      }
      ctx.stroke();
      ctx.restore();
      samples.forEach((s, i) => {
        if (s.x === null || s.y === null || s.r === null) return;
        const isSel = i === sel;
        ring(ctx, s.x, s.y, s.r * (isSel ? 1.7 : 1.3), STATUS_COLOR[s.status], lw * (isSel ? 3 : 1.5));
      });
      if (selSample && selSample.x !== null && selSample.y !== null && selSample.r !== null) {
        cross(ctx, selSample.x, selSample.y, selSample.r * 0.5, STATUS_COLOR[selSample.status], lw * 1.5);
      }
    }
  };

  const hint =
    step === 3
      ? 'ボールをタップしてください'
      : step === 5 && selSample
        ? selSample.status === 'lost'
          ? 'この時刻のボールの位置をタップしてください'
          : 'ずれている場合は正しい位置をタップ'
        : undefined;
  const onTap = step === 3 ? tapSeed : step === 5 && sel !== null ? tapFix : undefined;

  const scrubber = (
    <div className="scrubber">
      <div className="time-row">
        <span className="time" data-testid="current-time">{fmt(shownTime)}</span>
        <span className="muted">/ {fmt(src.duration)}</span>
        <span className="muted small">{src.fps ? `約${Math.round(src.fps)}fps` : 'fps不明'}</span>
      </div>
      <input
        type="range"
        min={0}
        max={maxFrame}
        step={1}
        value={frame}
        onChange={(e) => {
          if (playing) stopPlay();
          showFrame(Number(e.target.value));
        }}
        aria-label="再生位置"
        data-testid="scrub"
      />
      <div className="ctrl-row">
        <button className="btn small" onClick={() => { if (playing) stopPlay(); showFrame(frame - Math.round(0.5 / fd)); }}>◀◀ 0.5秒</button>
        <button className="btn small" onClick={() => { if (playing) stopPlay(); showFrame(frame - 1); }}>◀ 1コマ</button>
        <button className="btn small play" onClick={togglePlay}>{playing ? '❚❚' : '▶'}</button>
        <button className="btn small" onClick={() => { if (playing) stopPlay(); showFrame(frame + 1); }}>1コマ ▶</button>
        <button className="btn small" onClick={() => { if (playing) stopPlay(); showFrame(frame + Math.round(0.5 / fd)); }}>0.5秒 ▶▶</button>
      </div>
    </div>
  );

  const arrows = (fn: (dx: number, dy: number, dr: number) => void) => (
    <div className="nudge">
      <div className="nudge-pad">
        <span />
        <button className="btn small" onClick={() => fn(0, -1, 0)} aria-label="上へ">↑</button>
        <span />
        <button className="btn small" onClick={() => fn(-1, 0, 0)} aria-label="左へ">←</button>
        <span className="nudge-label">位置</span>
        <button className="btn small" onClick={() => fn(1, 0, 0)} aria-label="右へ">→</button>
        <span />
        <button className="btn small" onClick={() => fn(0, 1, 0)} aria-label="下へ">↓</button>
        <span />
      </div>
      <div className="nudge-size">
        <span className="nudge-label">大きさ</span>
        <button className="btn small" onClick={() => fn(0, 0, -1)} aria-label="小さく">－</button>
        <button className="btn small" onClick={() => fn(0, 0, 1)} aria-label="大きく">＋</button>
      </div>
    </div>
  );

  return (
    <main className="screen analyze-screen" hidden={!active}>
      <div className="topbar">
        <button className="link-btn" onClick={onBack}>‹ 動画を選び直す</button>
      </div>

      <nav className="steps" aria-label="手順">
        {(Object.keys(STEP_LABELS) as unknown as Step[]).map((k) => {
          const s = Number(k) as Step;
          return (
            <button
              key={s}
              className={`step ${s === step ? 'current' : ''} ${canGo(s) ? '' : 'disabled'}`}
              disabled={!canGo(s) || progress !== null}
              onClick={() => goStep(s)}
            >
              <span className="step-no">{s}</span>
              {STEP_LABELS[s]}
            </button>
          );
        })}
      </nav>

      <FrameView src={src} version={version} overlay={overlay} onTap={progress === null ? onTap : undefined} hint={hint} />

      {error && <div className="error" role="alert">{error}</div>}

      {step === 1 && (
        <section className="panel">
          <h2>手順1　ボールが転がり始める時点</h2>
          <p className="desc">スライダーやボタンで、パターがボールに当たる<strong>直前</strong>の場面を表示してください。</p>
          {scrubber}
          <button className="btn primary big" onClick={setStart} data-testid="set-start">この時点を開始にする</button>
          {startFrame !== null && <p className="muted">現在の開始：{fmt(src.frameTime(startFrame))}</p>}
        </section>
      )}

      {step === 2 && startFrame !== null && (
        <section className="panel">
          <h2>手順2　ボールが止まる時点</h2>
          <p className="desc">ボールが<strong>完全に止まった</strong>場面（またはカップに入る直前）を表示してください。</p>
          {scrubber}
          <button className="btn primary big" onClick={setEnd} data-testid="set-end">この時点を終了にする</button>
          <p className="muted">開始：{fmt(src.frameTime(startFrame))}{endFrame !== null && `　終了：${fmt(src.frameTime(endFrame))}`}</p>
        </section>
      )}

      {step === 3 && (
        <section className="panel">
          <h2>手順3　最初のボールの位置</h2>
          <p className="desc">上の画面（開始時点）で、<strong>ボールをタップ</strong>してください。ピンチで拡大してからタップすると正確です。</p>
          {seedMsg && <div className="notice">{seedMsg}</div>}
          {seed && arrows(nudgeSeed)}
          <button className="btn primary big" disabled={!seed} onClick={() => goStep(4)} data-testid="seed-ok">この位置で決定</button>
        </section>
      )}

      {step === 4 && (
        <section className="panel">
          <h2>手順4　残像の間隔と追跡</h2>
          <p className="desc">ボールを何秒ごとに残すかを選んでください。速いところは間隔が広く、遅いところは狭く並びます。</p>
          <div className="segmented" role="radiogroup" aria-label="残像の間隔">
            {([0.05, 0.1, 0.2] as Interval[]).map((v) => (
              <button
                key={v}
                role="radio"
                aria-checked={interval === v}
                className={interval === v ? 'on' : ''}
                disabled={progress !== null}
                onClick={() => { setIntervalSec(v); setSamples([]); }}
              >
                {v}秒{v === 0.1 && <small>標準</small>}
              </button>
            ))}
          </div>
          {startFrame !== null && endFrame !== null && (
            <p className="muted">
              範囲：{fmt(src.frameTime(startFrame))} 〜 {fmt(src.frameTime(endFrame))}（{(src.frameTime(endFrame) - src.frameTime(startFrame)).toFixed(2)}秒）
            </p>
          )}
          {progress === null ? (
            <button className="btn primary big" onClick={() => runTrack(0)} data-testid="track">追跡を開始</button>
          ) : (
            <div className="progress-box">
              <div className="progress"><div style={{ width: `${Math.round(progress * 100)}%` }} /></div>
              <p>ボールを追跡しています… {Math.round(progress * 100)}%</p>
              <button className="btn secondary" onClick={() => (cancelRef.current = true)}>中止</button>
            </div>
          )}
          {msg && <div className="notice">{msg}</div>}
        </section>
      )}

      {step === 5 && samples.length > 0 && (
        <section className="panel">
          <h2>手順5　位置の確認・修正</h2>
          <div className="legend">
            <span><i style={{ background: STATUS_COLOR.auto }} />自動 {counts.auto}</span>
            <span><i style={{ background: STATUS_COLOR.manual }} />手動 {counts.manual}</span>
            <span><i style={{ background: STATUS_COLOR.low }} />要確認 {counts.low}</span>
            <span><i style={{ background: STATUS_COLOR.lost }} />未検出 {counts.lost}</span>
            {counts.excluded > 0 && <span><i style={{ background: STATUS_COLOR.excluded }} />除外 {counts.excluded}</span>}
          </div>
          {plan?.notes.map((n) => <div key={n} className="notice warn">{n}</div>)}

          <div className="chips" role="listbox" aria-label="時刻ごとの位置" data-testid="chips">
            {samples.map((s, i) => (
              <button
                key={s.frame}
                className={`chip ${i === sel ? 'sel' : ''}`}
                style={{ borderColor: STATUS_COLOR[s.status] }}
                onClick={() => selectSample(i)}
                data-status={s.status}
              >
                <i style={{ background: STATUS_COLOR[s.status] }} />
                {(s.time - samples[0].time).toFixed(2)}
              </button>
            ))}
          </div>

          {selSample && sel !== null && (
            <div className="sel-box">
              <div className="sel-head">
                <button className="btn small" disabled={sel <= 0} onClick={() => selectSample(sel - 1)}>◀ 前</button>
                <div className="sel-title">
                  <strong>{(selSample.time - samples[0].time).toFixed(2)}秒</strong>
                  {selSample.kind === 'start' ? '（開始）' : selSample.kind === 'end' ? '（終了）' : ''}
                  <span className="badge" style={{ background: STATUS_COLOR[selSample.status] }}>{STATUS_LABEL[selSample.status]}</span>
                </div>
                <button className="btn small" disabled={sel >= samples.length - 1} onClick={() => selectSample(sel + 1)}>次 ▶</button>
              </div>
              {msg && <div className="notice">{msg}</div>}
              {selSample.x !== null && arrows(nudgeSel)}
              <div className="btn-row">
                {selSample.status === 'low' && (
                  <button className="btn secondary" onClick={() => updateSample(sel, { status: 'manual' })}>この位置で正しい</button>
                )}
                {selSample.status !== 'excluded' && selSample.kind !== 'start' && (
                  <button className="btn secondary" onClick={() => updateSample(sel, { status: 'excluded', x: null, y: null, r: null })}>この時刻を使わない</button>
                )}
                {(selSample.status === 'manual') && sel < samples.length - 1 && (
                  <button className="btn secondary" onClick={() => runTrack(sel, samples)} disabled={progress !== null}>ここから再追跡</button>
                )}
              </div>
              {progress !== null && (
                <div className="progress-box">
                  <div className="progress"><div style={{ width: `${Math.round(progress * 100)}%` }} /></div>
                  <p>再追跡しています… {Math.round(progress * 100)}%</p>
                </div>
              )}
            </div>
          )}

          <button
            className="btn primary big"
            onClick={() => plan && onCompose(samples, plan, interval)}
            disabled={progress !== null}
            data-testid="compose"
          >
            残像画像を作成
          </button>
          <p className="muted small">赤（未検出）・灰（除外）の時刻は画像に含めません。黄（要確認）は次の画面で含めるか選べます。</p>
        </section>
      )}
    </main>
  );
}

function ring(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, lw: number) {
  ctx.save();
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = lw + 2;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.stroke();
  ctx.restore();
}

function cross(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, lw: number) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.moveTo(x - r, y);
  ctx.lineTo(x + r, y);
  ctx.moveTo(x, y - r);
  ctx.lineTo(x, y + r);
  ctx.stroke();
  ctx.restore();
}
