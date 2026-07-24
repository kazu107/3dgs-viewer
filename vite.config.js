import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  build: {
    target: "esnext",
    chunkSizeWarningLimit: 40000,
    // OneDrive同期フォルダ内でViteの削除処理がクラッシュするため、
    // クリーンは scripts/clean-dist.js (prebuild) が担当する
    emptyOutDir: false,
    rollupOptions: {
      // マルチページ: 通常ビューア(index) と ARビューア(ar)
      input: {
        main: path.resolve(__dirname, "index.html"),
        ar: path.resolve(__dirname, "ar.html"),
      },
    },
  },
  resolve: {
    // Spark と AR.js が同一の three (r0.180) を共有するため single-instance にする。
    // 物理的な単一化は package.json の overrides:{three} で担保済み(node_modules上に
    // three は1つだけ)。ここで three を alias で絶対パスへ強制すると Spark 同梱の
    // SPZデコード用 Worker のバンドルが壊れ、スプラットが0個になる不具合が出たため、
    // alias は使わず dedupe のみに留める。
    dedupe: ["three"],
  },
  optimizeDeps: {
    // Spark はWASM/WebWorkerを内包した単一ESMとして配布されるため、
    // 事前バンドル(esbuild)を通すとworker解決が壊れることがある
    exclude: ["@sparkjsdev/spark"],
  },
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
