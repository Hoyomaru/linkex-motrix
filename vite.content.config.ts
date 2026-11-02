import { defineConfig } from 'vite';

// コンテンツスクリプトは import を使えないので、1ファイルにまとめた IIFE としてビルドする。
// メインのビルドの後に実行し、dist を消さずに content.js だけ追加する。
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'es2022',
    lib: {
      entry: 'src/content/share-page.ts',
      formats: ['iife'],
      name: 'LinkexMotrixContent',
      fileName: () => 'content.js',
    },
  },
});
