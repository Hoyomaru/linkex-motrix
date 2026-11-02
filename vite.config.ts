import { defineConfig } from 'vite';

// 拡張機能として読み込めるよう、出力ファイル名を固定する。
// background.js は manifest.json から直接参照するのでハッシュを付けない。
export default defineConfig({
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    modulePreload: false,
    rollupOptions: {
      input: {
        dashboard: 'dashboard.html',
        popup: 'popup.html',
        background: 'src/background/index.ts',
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
