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
    // Spark と AR.js が同一の three (r0.180) インスタンスを共有するために必須。
    // AR.js(@ar-js-org/ar.js-threejs)は three を bare import するため、
    // 単一インスタンスに束ねないと scene graph / instanceof が壊れる。
    dedupe: ["three"],
    alias: [
      { find: /^three$/, replacement: path.resolve(__dirname, "node_modules/three") },
    ],
  },
  optimizeDeps: {
    // Spark はWASM/WebWorkerを内包した単一ESMとして配布されるため、
    // 事前バンドル(esbuild)を通すとworker解決が壊れることがある
    exclude: ["@sparkjsdev/spark"],
    include: ["three", "@ar-js-org/ar.js-threejs"],
  },
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
