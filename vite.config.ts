import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// base: './' にすることで、GitHub Pages などのサブフォルダに置いても動きます。
export default defineConfig({
  base: './',
  plugins: [react()],
  // 画面下に表示するバージョン（iPhone で最新版が開けているか確認するため）
  define: { __APP_VERSION__: JSON.stringify(`${pkg.version} (${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC)`) },
  server: { host: true },
  test: {
    include: ['src/**/*.test.ts'],
  },
} as any);
