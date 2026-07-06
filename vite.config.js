import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "esnext",
    chunkSizeWarningLimit: 40000,
    // OneDrive同期フォルダ内でViteの削除処理がクラッシュするため、
    // クリーンは scripts/clean-dist.js (prebuild) が担当する
    emptyOutDir: false,
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
