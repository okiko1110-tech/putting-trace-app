// 合成動画を使って、画面1→2→3 の一連の操作をブラウザ（Chromium）で自動確認するテスト
// 使い方: npm run build && npm run e2e
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// 開発環境に入っている Playwright を使います（無い場合は npm i -D playwright）
const { chromium } = require('playwright');
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const outDir = path.join(here, 'out');
fs.mkdirSync(outDir, { recursive: true });

for (const mode of ['portrait', 'landscape']) {
  const vid = path.join(here, `test-${mode}.webm`);
  if (!fs.existsSync(vid)) execFileSync('python3', [path.join(here, 'make-video.py'), vid, mode], { stdio: 'inherit' });
}

const server = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], { cwd: path.join(here, '..'), stdio: 'pipe' });
await new Promise((res) => {
  server.stdout.on('data', (d) => { if (String(d).includes('4173')) res(); });
  setTimeout(res, 8000);
});

const interval = Number(process.env.INTERVAL ?? 0.1);
let failed = false;
const browser = await chromium.launch();
try {
  for (const mode of ['portrait', 'landscape']) {
    const truth = JSON.parse(fs.readFileSync(path.join(here, `test-${mode}.json`), 'utf8'));
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const logs = [];
    page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
    await page.goto('http://localhost:4173/');
    await page.screenshot({ path: path.join(outDir, `${mode}-1-select.png`), fullPage: true });

    await page.setInputFiles('[data-testid=file-input]', path.join(here, `test-${mode}.webm`));
    await page.waitForSelector('[data-testid=set-start]', { timeout: 30000 });

    const setFrame = async (f) => {
      await page.evaluate((f) => {
        const el = document.querySelector('[data-testid=scrub]');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, String(f));
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, f);
      await page.waitForTimeout(500);
    };
    const startF = Math.round((truth.t0 - 0.05) * truth.fps);
    const endF = Math.round((truth.t0 + truth.troll + 0.3) * truth.fps);
    await setFrame(startF);
    await page.screenshot({ path: path.join(outDir, `${mode}-2-start.png`), fullPage: true });
    await page.click('[data-testid=set-start]');
    await setFrame(endF);
    await page.click('[data-testid=set-end]');
    await page.waitForTimeout(600);

    // 最初のボールをタップ（わざと中心から少しずらす）
    const t0 = truth.truth[startF];
    const box = await page.locator('[data-testid=frame]').boundingBox();
    await page.locator('[data-testid=frame]').click({
      position: { x: ((t0.x + 6) / truth.W) * box.width, y: ((t0.y - 5) / truth.H) * box.height },
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(outDir, `${mode}-3-seed.png`), fullPage: true });
    await page.click('[data-testid=seed-ok]');
    if (interval !== 0.1) await page.click(`text=${interval}秒`);
    const tTrack = Date.now();
    await page.click('[data-testid=track]');
    await page.waitForSelector('[data-testid=chips]', { timeout: 120000 });
    const trackSec = (Date.now() - tTrack) / 1000;
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outDir, `${mode}-4-review.png`), fullPage: true });

    const statuses = await page.$$eval('[data-testid=chips] .chip', (els) => els.map((e) => e.dataset.status));
    const counts = statuses.reduce((a, s) => ((a[s] = (a[s] ?? 0) + 1), a), {});

    await page.click('[data-testid=compose]');
    await page.waitForSelector('[data-testid=result-img]', { timeout: 60000 });
    await page.waitForFunction(() => !document.querySelector('.result-busy'), null, { timeout: 60000 });
    await page.screenshot({ path: path.join(outDir, `${mode}-5-result.png`), fullPage: true });
    const b64 = await page.evaluate(async () => {
      const img = document.querySelector('[data-testid=result-img]');
      const blob = await (await fetch(img.src)).blob();
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return { type: blob.type, data: btoa(s) };
    });
    const pngPath = path.join(outDir, `${mode}-composite.png`);
    fs.writeFileSync(pngPath, Buffer.from(b64.data, 'base64'));
    const count = await page.locator('[data-testid=ball-count]').textContent();

    // 合成画像に、正解位置の白いボールが写っているか確認
    const check = execFileSync('python3', [path.join(here, 'check-composite.py'), pngPath, path.join(here, `test-${mode}.json`), String(startF), String(endF), String(interval)]).toString();
    console.log(`\n=== ${mode} ===`);
    console.log('PNG形式:', b64.type, ' ボール数表示:', count, ' 追跡時間:', trackSec.toFixed(1), '秒');
    console.log('状態:', JSON.stringify(counts));
    console.log(check.trim());
    if (!check.includes('RESULT OK')) failed = true;
    const errs = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'));
    if (errs.length) { console.log('ブラウザのエラー:', errs.join('\n')); failed = true; }
    await ctx.close();
  }
} finally {
  await browser.close();
  server.kill();
}
console.log(failed ? '\nE2E: 失敗あり' : '\nE2E: すべて成功');
process.exit(failed ? 1 : 0);
