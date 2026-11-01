/**
 * 動画の読み込みとフレーム取り出し（端末内で完結。外部送信なし）
 * iPhone Safari では <video> のシーク + Canvas への描画でフレームを取り出します。
 */

export class AppError extends Error {}

/** 解析・表示用の作業解像度（長辺）。追跡を速くするため縮小します */
const WORK_LONG_SIDE = 1280;

type RVFC = (cb: (now: number, meta: { mediaTime: number }) => void) => number;

export class VideoSource {
  readonly video: HTMLVideoElement;
  readonly url: string;
  duration = 0;
  width = 0; // 元動画の幅（回転適用後）
  height = 0;
  workW = 0;
  workH = 0;
  /** 元動画座標 = 作業座標 × scale */
  scale = 1;
  readonly work: HTMLCanvasElement;
  private workCtx!: CanvasRenderingContext2D;
  private queue: Promise<unknown> = Promise.resolve();
  /** requestVideoFrameCallback が使えるか（null = 未確認） */
  private rvfcOk: boolean | null = null;
  private rvfcFails = 0;
  /** 推定フレームレート（null = 不明） */
  fps: number | null = null;
  /** フレーム時刻の位相（最初のフレームの時刻のずれ） */
  framePhase = 0;
  /** 最後に取り出したフレームの実際の時刻 */
  lastFrameTime = 0;
  /** 実フレーム時刻を取得できているか */
  get hasFrameTimes(): boolean {
    return this.rvfcOk === true;
  }

  private constructor(file: File, host: HTMLElement) {
    this.url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true;
    v.defaultMuted = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.setAttribute('muted', '');
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    // iOS では DOM に無い／非表示の動画はデコードされないことがあるため、見えない形で配置
    Object.assign(v.style, {
      position: 'fixed', left: '0', top: '0', width: '2px', height: '2px',
      opacity: '0.01', pointerEvents: 'none', zIndex: '-1',
    });
    host.appendChild(v);
    this.video = v;
    this.work = document.createElement('canvas');
  }

  static async load(file: File, host: HTMLElement): Promise<VideoSource> {
    if (file.type && !file.type.startsWith('video/')) {
      throw new AppError('選択されたファイルは動画ではないようです。動画ファイルを選んでください。');
    }
    const src = new VideoSource(file, host);
    try {
      await src.init();
    } catch (e) {
      src.dispose();
      throw e;
    }
    return src;
  }

  private init(): Promise<void> {
    const v = this.video;
    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new AppError('動画の読み込みに時間がかかりすぎています。短い動画（10秒程度）で試すか、別の動画を選んでください。'));
      }, 20000);
      const onError = () => {
        cleanup();
        const code = v.error?.code;
        if (code === 4) {
          reject(new AppError('この動画形式はこのブラウザでは再生できません。iPhone の Safari で、iPhone のカメラで撮影した動画（MOV / MP4）を選んでください。'));
        } else {
          reject(new AppError(`動画を読み込めませんでした（エラー番号 ${code ?? '不明'}）。別の動画で試してください。`));
        }
      };
      const onData = async () => {
        cleanup();
        try {
          await this.afterMetadata();
          resolve();
        } catch (e) {
          reject(e);
        }
      };
      const cleanup = () => {
        window.clearTimeout(timer);
        v.removeEventListener('error', onError);
        v.removeEventListener('loadeddata', onData);
      };
      v.addEventListener('error', onError);
      v.addEventListener('loadeddata', onData);
      v.src = this.url;
      v.load();
    });
  }

  private async afterMetadata() {
    const v = this.video;
    if (!v.videoWidth || !v.videoHeight) {
      throw new AppError('動画の映像部分を読み取れませんでした。音声のみのファイルか、未対応の形式の可能性があります。');
    }
    // 長さが不明（Infinity）な動画への対処
    if (!isFinite(v.duration) || v.duration <= 0) {
      await new Promise<void>((res) => {
        const h = () => { v.removeEventListener('durationchange', h); res(); };
        v.addEventListener('durationchange', h);
        v.currentTime = 1e7;
        window.setTimeout(res, 3000);
      });
    }
    if (!isFinite(v.duration) || v.duration <= 0) {
      throw new AppError('動画の長さを取得できませんでした。別の動画で試してください。');
    }
    this.duration = v.duration;
    this.width = v.videoWidth;
    this.height = v.videoHeight;
    const long = Math.max(this.width, this.height);
    const s = Math.min(1, WORK_LONG_SIDE / long);
    this.workW = Math.round(this.width * s);
    this.workH = Math.round(this.height * s);
    this.scale = this.width / this.workW;
    this.work.width = this.workW;
    this.work.height = this.workH;
    const ctx = this.work.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new AppError('このブラウザでは画像処理（Canvas）が使えません。');
    this.workCtx = ctx;
    // iOS では一度再生しないとフレームが描画されないことがあるため、短く再生して止める。
    // その間にフレームレートを測ります。
    await this.measureFps();
    await this.seek(0);
  }

  /** 少しだけ再生して、実際のフレーム時刻からフレームレートを推定 */
  private async measureFps() {
    const v = this.video;
    const rvfc = (v as unknown as { requestVideoFrameCallback?: RVFC }).requestVideoFrameCallback;
    const times: number[] = [];
    let playing = false;
    try {
      if (typeof rvfc === 'function') {
        const loop = (_n: number, meta: { mediaTime: number }) => {
          times.push(meta.mediaTime);
          if (times.length < 16 && playing) rvfc.call(v, loop);
        };
        rvfc.call(v, loop);
      }
      v.playbackRate = 1;
      await v.play();
      playing = true;
      const t0 = performance.now();
      while (performance.now() - t0 < 1500 && times.length < 16) await wait(50);
    } catch {
      /* 自動再生が拒否されても続行（シークで表示できることが多い） */
    } finally {
      playing = false;
      v.pause();
    }
    const diffs: number[] = [];
    for (let i = 1; i < times.length; i++) {
      const d = times[i] - times[i - 1];
      if (d > 0.001) diffs.push(d);
    }
    if (diffs.length >= 3) {
      // 取りこぼしがあっても最小間隔付近の値を採用
      diffs.sort((a, b) => a - b);
      const fd = diffs[Math.floor(diffs.length * 0.25)];
      const fps = 1 / fd;
      // よくあるフレームレートに丸める
      const common = [24, 25, 30, 50, 60, 120, 240];
      let best = fps;
      for (const c of common) if (Math.abs(c - fps) / c < 0.06) best = c;
      this.fps = best;
      const fdr = 1 / best;
      const phases = times.map((t) => ((t % fdr) + fdr) % fdr).sort((a, b) => a - b);
      this.framePhase = phases[Math.floor(phases.length / 2)];
      if (this.framePhase > fdr * 0.95) this.framePhase = 0;
      this.rvfcOk = true;
    }
  }

  /** フレーム1コマの長さ（秒）。不明なら 1/30 と仮定 */
  get frameDuration(): number {
    return 1 / (this.fps ?? 30);
  }

  /** 時刻 t を含むフレーム番号 */
  frameIndexAt(t: number): number {
    return Math.max(0, Math.floor((t - this.framePhase) / this.frameDuration + 1e-6));
  }

  /** フレーム番号 → シークに使う時刻（フレームの中央を狙うので丸め誤差に強い） */
  frameSeekTime(k: number): number {
    return this.framePhase + (k + 0.5) * this.frameDuration;
  }

  /** フレーム番号 → そのフレームの表示開始時刻 */
  frameTime(k: number): number {
    return this.framePhase + k * this.frameDuration;
  }

  get frameCount(): number {
    return Math.max(1, Math.floor((this.duration - this.framePhase) / this.frameDuration));
  }

  /** 指定時刻へシークし、作業キャンバスにフレームを描画。実際のフレーム時刻を返す */
  seek(t: number): Promise<number> {
    const job = this.queue.then(() => this.doSeek(t));
    this.queue = job.catch(() => undefined);
    return job;
  }

  /**
   * シークと、そのフレームを使う処理（fn）を、他の処理に割り込まれないように続けて実行する。
   * 複数の処理が同時に動いても、別の時刻のフレームを読んでしまうことを防ぎます。
   */
  grab<T>(t: number, fn: (frameTime: number) => T): Promise<T> {
    const job = this.queue.then(async () => fn(await this.doSeek(t)));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async doSeek(t: number): Promise<number> {
    const v = this.video;
    const target = Math.min(Math.max(0, t), Math.max(0, this.duration - 0.001));
    const rvfc = (v as unknown as { requestVideoFrameCallback?: RVFC }).requestVideoFrameCallback;
    let frameTime: number | null = null;
    let frameResolve: (() => void) | null = null;
    const framePromise = new Promise<void>((r) => (frameResolve = r));
    const useRvfc = typeof rvfc === 'function' && this.rvfcOk !== false;
    if (useRvfc) {
      rvfc.call(v, (_now, meta) => {
        frameTime = meta.mediaTime;
        frameResolve?.();
      });
    }
    const needSeek = Math.abs(v.currentTime - target) > 1e-6 || v.seeking;
    if (needSeek) {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          v.removeEventListener('seeked', ok);
          reject(new AppError('動画の指定時刻を表示できませんでした（シークのタイムアウト）。もう一度試してください。'));
        }, 8000);
        const ok = () => {
          window.clearTimeout(timer);
          resolve();
        };
        v.addEventListener('seeked', ok, { once: true });
        v.currentTime = target;
      });
      if (useRvfc) {
        await Promise.race([framePromise, wait(this.rvfcOk ? 300 : 250)]);
        if (frameTime === null) {
          this.rvfcFails++;
          if (this.rvfcOk === null && this.rvfcFails >= 3) this.rvfcOk = false;
        } else {
          this.rvfcOk = true;
        }
      } else {
        await nextAnimationFrame();
      }
    }
    this.workCtx.drawImage(v, 0, 0, this.workW, this.workH);
    if (frameTime === null && needSeek) {
      // 実フレーム時刻が取れない場合は、推定フレームレートから計算
      frameTime = this.frameTime(this.frameIndexAt(target));
    }
    this.lastFrameTime = frameTime ?? this.lastFrameTime;
    return this.lastFrameTime;
  }

  /** 再生中など、今表示されている動画フレームを作業キャンバスに描く */
  drawCurrent() {
    this.workCtx.drawImage(this.video, 0, 0, this.workW, this.workH);
  }

  /** 作業解像度の画素データ */
  getImageData(): ImageData {
    return this.workCtx.getImageData(0, 0, this.workW, this.workH);
  }

  dispose() {
    try {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
      this.video.remove();
    } catch {
      /* noop */
    }
    URL.revokeObjectURL(this.url);
  }
}

export function wait(ms: number) {
  return new Promise<void>((r) => window.setTimeout(r, ms));
}
function nextAnimationFrame() {
  return new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}
