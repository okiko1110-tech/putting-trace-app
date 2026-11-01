import { useEffect, useRef, useState } from 'react';
import { AnalyzeScreen, type Interval } from './screens/AnalyzeScreen';
import { ResultScreen } from './screens/ResultScreen';
import { SelectScreen } from './screens/SelectScreen';
import type { Sample, SamplePlan } from './lib/tracker';
import { AppError, VideoSource } from './lib/video';

type Screen = 'select' | 'analyze' | 'result';

function checkSupport(): string | null {
  const c = document.createElement('canvas');
  if (!c.getContext || !c.getContext('2d')) return 'このブラウザは画像処理（Canvas）に対応していません。iPhone の Safari で開いてください。';
  if (!('toBlob' in c)) return 'このブラウザは画像の保存に対応していません。iOS を最新にするか、Safari で開いてください。';
  if (typeof document.createElement('video').canPlayType !== 'function') return 'このブラウザは動画の再生に対応していません。';
  return null;
}

export function App() {
  const [screen, setScreen] = useState<Screen>('select');
  const [src, setSrc] = useState<VideoSource | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(() => checkSupport());
  const [result, setResult] = useState<{ samples: Sample[]; plan: SamplePlan; interval: Interval } | null>(null);
  const [key, setKey] = useState(0);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onErr = (e: ErrorEvent | PromiseRejectionEvent) => {
      const m = 'reason' in e ? (e.reason as Error)?.message : e.message;
      setError(`予期しないエラーが発生しました：${m ?? '不明'}。ページを再読み込みしてやり直してください。`);
    };
    window.addEventListener('error', onErr);
    window.addEventListener('unhandledrejection', onErr);
    return () => {
      window.removeEventListener('error', onErr);
      window.removeEventListener('unhandledrejection', onErr);
    };
  }, []);

  const onFile = async (f: File) => {
    setError(null);
    setLoading(true);
    try {
      src?.dispose();
      setSrc(null);
      const s = await VideoSource.load(f, hostRef.current!);
      setSrc(s);
      setResult(null);
      setKey((k) => k + 1);
      setScreen('analyze');
      window.scrollTo(0, 0);
    } catch (e) {
      setError(e instanceof AppError ? e.message : `動画を読み込めませんでした：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  const restart = () => {
    src?.dispose();
    setSrc(null);
    setResult(null);
    setScreen('select');
    window.scrollTo(0, 0);
  };

  return (
    <div className="app">
      <header className="brand">
        <div className="brand-sub">STATS BALANCE</div>
        <div className="brand-main">PUTTING TRACE</div>
      </header>
      <div ref={hostRef} className="video-host" aria-hidden />
      {screen === 'select' && <SelectScreen onFile={onFile} loading={loading} error={error} />}
      {src && (screen === 'analyze' || screen === 'result') && (
        <AnalyzeScreen
          key={key}
          src={src}
          active={screen === 'analyze'}
          onBack={restart}
          onCompose={(samples, plan, interval) => {
            setResult({ samples, plan, interval });
            setScreen('result');
            window.scrollTo(0, 0);
          }}
        />
      )}
      {src && screen === 'result' && result && (
        <ResultScreen
          src={src}
          samples={result.samples}
          plan={result.plan}
          interval={result.interval}
          onBack={() => { setScreen('analyze'); window.scrollTo(0, 0); }}
          onRestart={restart}
        />
      )}
      <footer className="version">試作版 v{__APP_VERSION__}</footer>
      {screen !== 'select' && error && <div className="error floating" role="alert" onClick={() => setError(null)}>{error}（タップで閉じる）</div>}
    </div>
  );
}
