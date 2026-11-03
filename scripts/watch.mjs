// ソースを変えるたびに dist を作り直す（本体と content.js の両方）。
// Edge は dist を読み込んでいるので、作り直したら拡張機能の一覧で「再読み込み」を押す。
// 本体のビルドが dist を空にすると content.js が消えてしまうため、ここでは dist を空にしない。
import { build } from 'vite';

const watch = { watch: {} };
await build({ configFile: 'vite.content.config.ts', build: watch });
await build({ configFile: 'vite.config.ts', build: { ...watch, emptyOutDir: false } });
