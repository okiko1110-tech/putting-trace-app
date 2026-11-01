import { useRef, useState } from 'react';

interface Props {
  onFile: (f: File) => void;
  loading: boolean;
  error: string | null;
}

export function SelectScreen({ onFile, loading, error }: Props) {
  const camRef = useRef<HTMLInputElement>(null);
  const libRef = useRef<HTMLInputElement>(null);
  const [showTips, setShowTips] = useState(false);

  const change = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) onFile(f);
  };

  return (
    <main className="screen select-screen">
      <section className="hero">
        <div className="hero-balls" aria-hidden>
          <span /><span /><span /><span /><span />
        </div>
        <p className="lead">
          パッティング動画から、実際のボールが転がった位置に
          <br />
          並んで見える<strong>残像画像</strong>を作ります。
        </p>
      </section>

      <div className="btn-stack">
        <button className="btn primary big" disabled={loading} onClick={() => camRef.current?.click()}>
          <span className="btn-icon">●</span> 動画を撮影
        </button>
        <button className="btn secondary big" disabled={loading} onClick={() => libRef.current?.click()}>
          <span className="btn-icon">▤</span> 動画を選択
        </button>
        <input ref={camRef} type="file" accept="video/*" capture="environment" hidden onChange={change} />
        <input ref={libRef} type="file" accept="video/*" hidden onChange={change} data-testid="file-input" />
      </div>

      {loading && (
        <div className="notice">
          <div className="spinner" /> 動画を読み込んでいます…
        </div>
      )}
      {error && <div className="error" role="alert">{error}</div>}

      <p className="privacy">🔒 動画はこの端末の中だけで処理されます。外部のサーバーには送信しません。</p>

      <section className="card">
        <button className="link-btn" onClick={() => setShowTips(!showTips)}>
          {showTips ? '▼' : '▶'} 上手に撮影するコツ
        </button>
        {showTips && (
          <ul className="tips">
            <li>iPhone を<strong>三脚などで固定</strong>してください（動くと残像がずれます）。</li>
            <li>ボールの<strong>真後ろ、またはやや斜め後ろ</strong>から撮影します。</li>
            <li>スタート位置からカップ付近まで、<strong>全体が画面に入る</strong>ようにします。</li>
            <li>縦向き・横向きどちらでも大丈夫です。</li>
            <li>録画を始めてからパットし、ボールが止まって<strong>2秒ほど待ってから</strong>止めます。</li>
            <li>白いボールを使い、ボールの周りに他の白い物が少ない場所が理想です。</li>
            <li>強い影がボールにかからない時間帯・向きだと認識しやすくなります。</li>
          </ul>
        )}
      </section>
    </main>
  );
}
